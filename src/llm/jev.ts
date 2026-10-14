import {
  experimental_decide as decideWithModel,
  type Experimental_DecisionAnswer as DecisionAnswer,
  type Experimental_DecisionModel as DecisionModel,
  type Experimental_DecisionQuestion as DecisionQuestion,
} from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { z } from "zod";
import { env } from "../env";
import { createOpenRouterDecisionModel } from "./openrouter-decision-model";
import {
  NO_COST,
  computeDecisionCost,
  ZERO_TOKENS,
  reportUsage,
  startLlmCall,
  type UsageCost,
  type UsageReporter,
  type UsageSubTool,
  type UsageTokens,
} from "../usage/argo";
import { log } from "../telemetry/log";

// The shadow decision lane ("Jev" is its historical name — job kinds, `jev_*`
// columns and function names keep it). It is a decision model: typed answers
// with calibrated probabilities, no text generation: `pplx-decider-v1-27b` on
// IU's native decision API (systemone) by default, through the official
// `@ai-sdk/typesafe-ai` provider; OpenRouter's Decisions API is the selectable
// alternative (`DECISION_PROVIDER`). Both are reached through the AI SDK's
// experimental `decide`, so the question and answer types are the SDK's own
// (`choice` / `score` / `boolean`) and the SDK validates the answers.

export type JevProvider = "ue" | "openrouter";

export interface JevConfig {
  provider: JevProvider;
  // API key for the provider (UE: LLM_API_KEY, OpenRouter: OPENROUTER_API_KEY).
  apiKey: string;
  // UE only: decisions base URL (`<ue-origin>/decisions/v1`).
  baseUrl?: string;
  // Decision model id: `pplx-decider-v1-27b` on UE, `cloudflare/clef` on OpenRouter.
  model: string;
}

// Argo `billing` per provider: UE is billed to IU, OpenRouter to the owner.
const BILLING = { ue: "iu", openrouter: "openrouter" } as const;

// The key each provider files its `providerMetadata` under: the TypeSafe
// provider (which serves UE) uses `typesafe`.
const METADATA_KEY = { ue: "typesafe", openrouter: "openrouter" } as const;

type JevState = Parameters<typeof decideWithModel>[0]["state"];

// Providers report per-question choice confidence in provider metadata
// rather than on the answer itself.
type JevAnswer<Question extends DecisionQuestion> =
  DecisionAnswer<Question> extends { type: "choice" }
    ? DecisionAnswer<Question> & { confidence: number }
    : DecisionAnswer<Question>;

interface JevDecision<Questions extends Record<string, DecisionQuestion>> {
  answers: { [Key in keyof Questions]: JevAnswer<Questions[Key]> };
}

// Single model requests get a hang guard, never a tight timeout (house rule,
// see src/spam/classify.ts).
const JEV_HANG_GUARD_MS = 30 * 60_000;

// `providerMetadata[METADATA_KEY[provider]]`. TypeSafe (UE) reports
// `confidence` per question id and no cost; OpenRouter reports `answers` (per
// question confidence) and the request's cost in USD. Each field degrades to
// undefined on a bad shape instead of failing the decision.
const confidenceSchema = z.number().min(0).max(1).optional().catch(undefined);
const providerMetadataSchema = z.object({
  confidence: z
    .record(z.string(), confidenceSchema)
    .optional()
    .catch(undefined),
  answers: z
    .record(z.string(), z.object({ confidence: confidenceSchema }))
    .optional()
    .catch(undefined),
  usage: z
    .object({ cost: z.number().min(0).optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const APP_NAME = "email-gateway";
const APP_URL = "https://github.com/jkrumm/email-gateway";

type JevEnv = Pick<
  typeof env,
  | "DECISION_PROVIDER"
  | "DECISION_MODEL"
  | "DECISION_BASE_URL"
  | "OPENROUTER_API_KEY"
  | "LLM_BASE_URL"
  | "LLM_API_KEY"
>;

// The decision API lives beside the chat API on the same origin
// (`<origin>/openai/v1` -> `<origin>/decisions/v1`).
function decisionsBaseFrom(llmBaseUrl: string | undefined): string | null {
  if (!llmBaseUrl) return null;
  try {
    return `${new URL(llmBaseUrl).origin}/decisions/v1`;
  } catch {
    return null;
  }
}

// Pure over its env argument so provider selection is testable (`env` itself
// is parsed at import).
export function jevConfigFromEnv({
  DECISION_PROVIDER,
  DECISION_MODEL,
  DECISION_BASE_URL,
  OPENROUTER_API_KEY,
  LLM_BASE_URL,
  LLM_API_KEY,
}: JevEnv): JevConfig | null {
  if (DECISION_PROVIDER === "openrouter") {
    if (!OPENROUTER_API_KEY) return null;
    return {
      provider: "openrouter",
      apiKey: OPENROUTER_API_KEY,
      model: DECISION_MODEL,
    };
  }
  if (!LLM_API_KEY) return null;
  const baseUrl = DECISION_BASE_URL ?? decisionsBaseFrom(LLM_BASE_URL);
  if (!baseUrl) return null;
  return {
    provider: "ue",
    apiKey: LLM_API_KEY,
    baseUrl,
    model: DECISION_MODEL,
  };
}

export function getJevConfig(): JevConfig | null {
  return jevConfigFromEnv(env);
}

function createDecisionModel(config: JevConfig): DecisionModel {
  if (config.provider === "openrouter") {
    return createOpenRouterDecisionModel({
      apiKey: config.apiKey,
      model: config.model,
      appName: APP_NAME,
      appUrl: APP_URL,
    });
  }
  if (!config.baseUrl) throw new Error("Jev UE config has no baseUrl");
  return createTypeSafeAi({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  }).decisionModel(config.model);
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  // Request cost in USD, reported by the provider (OpenRouter) or computed from
  // `DECISION_RATES` (UE: the TypeSafe provider drops UE's cost); null when
  // unknown.
  costUsd: number | null;
}

export async function decide<
  const Questions extends Record<string, DecisionQuestion>,
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
  // Injectable decision model (tests); defaults to the configured provider's.
  model?: DecisionModel;
  report?: UsageReporter;
}): Promise<JevDecision<Questions> & { usage: JevUsage }> {
  if (!config) throw new Error("Jev not configured");

  const startedAt = Date.now();
  const call = startLlmCall(subTool, config.model);
  let result: Awaited<ReturnType<typeof decideWithModel<Questions>>>;
  try {
    result = await decideWithModel({
      model: model ?? createDecisionModel(config),
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
    call.finish({ outcome: "error", error });
    void report({
      subTool,
      model: config.model,
      billing: BILLING[config.provider],
      outcome: "error",
      durationMs: Date.now() - startedAt,
      tokens: ZERO_TOKENS,
      cost: NO_COST,
    }).catch(() => {});
    throw error;
  }

  const parsedMeta = providerMetadataSchema.safeParse(
    result.providerMetadata?.[METADATA_KEY[config.provider]],
  );
  const providerMeta = parsedMeta.success ? parsedMeta.data : undefined;
  // Both providers' shapes, as one per-question confidence record.
  const confidences: Record<string, number | undefined> = {
    ...Object.fromEntries(
      Object.entries(providerMeta?.answers ?? {}).map(([key, answer]) => [
        key,
        answer.confidence,
      ]),
    ),
    ...providerMeta?.confidence,
  };
  const reportedCostUsd = providerMeta?.usage?.cost ?? null;
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const cost: UsageCost =
    reportedCostUsd !== null
      ? { usd: reportedCostUsd, source: "reported" }
      : computeDecisionCost(config.model, inputTokens, outputTokens);
  if (cost.source === "none" && config.provider === "ue") {
    log.warn(
      `Jev: no reported cost and no DECISION_RATES entry for "${config.model}"`,
    );
  }
  const usage: JevUsage = {
    inputTokens,
    outputTokens,
    costUsd: cost.usd,
  };
  // The call was billed either way; a missing confidence below still makes
  // the decision a failure, so the outcome is settled only after the loop.
  const billedTokens: UsageTokens = {
    ...ZERO_TOKENS,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  const reportBilled = (outcome: "ok" | "error") => {
    call.finish({ outcome, tokens: billedTokens });
    void report({
      subTool,
      model: config.model,
      billing: BILLING[config.provider],
      outcome,
      durationMs: Date.now() - startedAt,
      tokens: billedTokens,
      cost,
    }).catch(() => {});
  };

  const answers: Record<string, unknown> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type !== "choice") {
      answers[key] = answer;
      continue;
    }

    const confidence =
      confidences[key] ?? answer.probabilities?.[answer.choice];
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
// usage. Returns null when the lane is disabled (missing credentials); rejects
// on failure — the job queue (src/jobs/jev.ts) owns retries and backoff.
export function decideShadow<
  const Questions extends Record<string, DecisionQuestion>,
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
  model?: DecisionModel;
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
