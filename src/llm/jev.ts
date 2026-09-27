import {
  createGateway,
  experimental_evaluate as evaluate,
  type Experimental_EvaluationAnswer as EvaluationAnswer,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";
import { z } from "zod";
import { env } from "../env";

// Jev (TypeSafe AI "System One") is a decision model: typed answers with
// calibrated probabilities, no text generation. It is reached through the
// Vercel AI Gateway via the AI SDK's experimental `evaluate`, so the question
// and answer types are the SDK's own (`choice` / `score` / `boolean`).

export interface JevConfig {
  // Vercel AI Gateway key.
  apiKey: string;
  // Gateway evaluation model id, e.g. `typesafe-ai/jev`.
  model: string;
}

type JevState = Parameters<typeof evaluate>[0]["state"];

// Jev reports per-question choice confidence in provider metadata rather than
// on the answer itself.
type JevAnswer<Question extends EvaluationQuestion> =
  EvaluationAnswer<Question> extends { type: "choice" }
    ? EvaluationAnswer<Question> & { confidence: number }
    : EvaluationAnswer<Question>;

interface JevDecision<Questions extends Record<string, EvaluationQuestion>> {
  answers: { [Key in keyof Questions]: JevAnswer<Questions[Key]> };
}

// Single model requests get a hang guard, never a tight timeout (house rule,
// see src/spam/classify.ts).
const JEV_HANG_GUARD_MS = 30 * 60_000;

const confidenceSchema = z.object({
  confidence: z.record(z.string(), z.number().min(0).max(1)),
});

export function getJevConfig(): JevConfig | null {
  const { JEV_API_KEY, JEV_MODEL } = env;
  if (!JEV_API_KEY) return null;
  return { apiKey: JEV_API_KEY, model: JEV_MODEL };
}

export async function decide<
  const Questions extends Record<string, EvaluationQuestion>,
>({
  state,
  questions,
  config = getJevConfig(),
  model,
}: {
  state: JevState;
  questions: Questions;
  config?: JevConfig | null;
  // Injectable evaluation model (tests); defaults to the gateway's.
  model?: EvaluationModel;
}): Promise<JevDecision<Questions>> {
  if (!config) throw new Error("Jev not configured");

  const result = await evaluate({
    model:
      model ??
      createGateway({ apiKey: config.apiKey }).evaluation(config.model),
    state,
    questions,
    abortSignal: AbortSignal.timeout(JEV_HANG_GUARD_MS),
  });

  const confidences = confidenceSchema.safeParse(
    result.providerMetadata?.typesafe,
  );

  const answers: Record<string, unknown> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type !== "choice") {
      answers[key] = answer;
      continue;
    }

    const confidence =
      (confidences.success ? confidences.data.confidence[key] : undefined) ??
      answer.probabilities?.[answer.choice];
    if (confidence === undefined) {
      throw new Error(`Jev returned no confidence for "${key}"`);
    }
    answers[key] = { ...answer, confidence };
  }

  // One answer per question, typed by the SDK; confidence was added above.
  return { answers: answers as JevDecision<Questions>["answers"] };
}

interface JevCallMeta {
  latencyMs: number;
  model: string;
}

// Runs `decide` and maps the answers with `pick`, adding latency and model.
// Returns null when Jev is disabled (no API key); rejects on failure — the
// Jev queue worker (src/jev/worker.ts) owns retries and backoff.
export function decideShadow<
  const Questions extends Record<string, EvaluationQuestion>,
  Fields extends object,
>({
  state,
  questions,
  pick,
  config = getJevConfig(),
  model,
}: {
  state: JevState;
  questions: Questions;
  pick: (answers: JevDecision<Questions>["answers"]) => Fields;
  config?: JevConfig | null;
  model?: EvaluationModel;
}): Promise<Fields & JevCallMeta> | null {
  if (!config) return null;

  const startedAt = Date.now();

  return decide({ config, model, state, questions }).then(({ answers }) => ({
    ...pick(answers),
    latencyMs: Date.now() - startedAt,
    model: config.model,
  }));
}
