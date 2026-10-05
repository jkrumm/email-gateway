import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationAnswer as EvaluationAnswer,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { env } from "../env";
import {
  NO_COST,
  ZERO_TOKENS,
  reportUsage,
  type UsageCost,
  type UsageReporter,
  type UsageSubTool,
} from "../usage/argo";

// The shadow decision lane ("Jev" is its historical name — job kinds, `jev_*`
// columns and function names keep it). It is a decision model: typed answers
// with calibrated probabilities, no text generation, today Cloudflare's Clef
// via OpenRouter's Decisions API. It is reached through the AI SDK's
// experimental `evaluate`, so the question and answer types are the SDK's own
// (`choice` / `score` / `boolean`).

export interface JevConfig {
  // OpenRouter API key.
  apiKey: string;
  // Decisions model id, e.g. `cloudflare/clef`.
  model: string;
}

type JevState = Parameters<typeof evaluate>[0]["state"];

// OpenRouter reports per-question choice confidence in provider metadata
// rather than on the answer itself.
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

// `providerMetadata.openrouter`: per-answer confidence and the request's cost
// in USD. Each field degrades to undefined on a bad shape instead of failing
// the decision.
const openrouterMetadataSchema = z.object({
  answers: z
    .record(
      z.string(),
      z.object({
        confidence: z.number().min(0).max(1).optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
  usage: z
    .object({ cost: z.number().min(0).optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const APP_NAME = "email-gateway";
const APP_URL = "https://github.com/jkrumm/email-gateway";

export function getJevConfig(): JevConfig | null {
  const { OPENROUTER_API_KEY, DECISION_MODEL } = env;
  if (!OPENROUTER_API_KEY) return null;
  return { apiKey: OPENROUTER_API_KEY, model: DECISION_MODEL };
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  // Request cost in USD as reported by OpenRouter; null when absent.
  costUsd: number | null;
}

export async function decide<
  const Questions extends Record<string, EvaluationQuestion>,
>({
  state,
  questions,
  subTool,
  config = getJevConfig(),
  model,
  report = reportUsage,
}: {
  state: JevState;
  questions: Questions;
  // Argo `sub_tool` the call is reported under.
  subTool: Extract<UsageSubTool, `decision-${string}`>;
  config?: JevConfig | null;
  // Injectable evaluation model (tests); defaults to OpenRouter's.
  model?: EvaluationModel;
  report?: UsageReporter;
}): Promise<JevDecision<Questions> & { usage: JevUsage }> {
  if (!config) throw new Error("Jev not configured");

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof evaluate<Questions>>>;
  try {
    result = await evaluate({
      model:
        model ??
        createOpenRouter({
          apiKey: config.apiKey,
          appName: APP_NAME,
          appUrl: APP_URL,
        }).evaluationModel(config.model),
      state,
      questions,
      // The durable job queue owns retries and backoff (src/db/jobs.ts) — the
      // SDK's own default (2 retries, i.e. 3 HTTP requests per judge attempt)
      // tripled the request volume a 429 burst produced, burning through the
      // queue's attempt budget faster than the burst itself (2026-09-28
      // incident). Zero SDK retries: exactly one HTTP request per attempt.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(JEV_HANG_GUARD_MS),
    });
  } catch (error) {
    void report({
      subTool,
      model: config.model,
      billing: "openrouter",
      outcome: "error",
      durationMs: Date.now() - startedAt,
      tokens: ZERO_TOKENS,
      cost: NO_COST,
    }).catch(() => {});
    throw error;
  }

  const metadata = openrouterMetadataSchema.safeParse(
    result.providerMetadata?.openrouter,
  );
  const answerMetadata = metadata.success ? metadata.data.answers : undefined;
  const costUsd = (metadata.success ? metadata.data.usage?.cost : null) ?? null;
  const usage: JevUsage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    costUsd,
  };
  const cost: UsageCost =
    costUsd === null ? NO_COST : { usd: costUsd, source: "reported" };
  // The call was billed either way; a missing confidence below still makes
  // the decision a failure, so the outcome is settled only after the loop.
  const reportBilled = (outcome: "ok" | "error") =>
    void report({
      subTool,
      model: config.model,
      billing: "openrouter",
      outcome,
      durationMs: Date.now() - startedAt,
      tokens: {
        ...ZERO_TOKENS,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      cost,
    }).catch(() => {});

  const answers: Record<string, unknown> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type !== "choice") {
      answers[key] = answer;
      continue;
    }

    const confidence =
      answerMetadata?.[key]?.confidence ??
      answer.probabilities?.[answer.choice];
    if (confidence === undefined) {
      reportBilled("error");
      throw new Error(`Jev returned no confidence for "${key}"`);
    }
    answers[key] = { ...answer, confidence };
  }
  reportBilled("ok");

  // One answer per question, typed by the SDK; confidence was added above.
  return {
    answers: answers as JevDecision<Questions>["answers"],
    usage,
  };
}

interface JevCallMeta {
  latencyMs: number;
  model: string;
  usage: JevUsage;
}

// Runs `decide` and maps the answers with `pick`, adding latency, model and
// usage. Returns null when the lane is disabled (no API key); rejects on
// failure — the job queue (src/jobs/jev.ts) owns retries and backoff.
export function decideShadow<
  const Questions extends Record<string, EvaluationQuestion>,
  Fields extends object,
>({
  state,
  questions,
  subTool,
  pick,
  config = getJevConfig(),
  model,
  report,
}: {
  state: JevState;
  questions: Questions;
  subTool: Extract<UsageSubTool, `decision-${string}`>;
  pick: (answers: JevDecision<Questions>["answers"]) => Fields;
  config?: JevConfig | null;
  model?: EvaluationModel;
  report?: UsageReporter;
}): Promise<Fields & JevCallMeta> | null {
  if (!config) return null;

  const startedAt = Date.now();

  return decide({
    config,
    model,
    state,
    questions,
    subTool,
    ...(report && { report }),
  }).then(({ answers, usage }) => ({
    ...pick(answers),
    latencyMs: Date.now() - startedAt,
    model: config.model,
    usage,
  }));
}
