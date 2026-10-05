import type { LanguageModelUsage } from "ai";
import { env } from "../env";

// Usage reporting to Argo (`POST /usage/records`, upsert key (source,
// source_id, machine)). Fire-and-forget: a strict no-op while ARGO_USAGE_URL
// or ARGO_API_SECRET is unset, failures are logged and never thrown, and
// callers never await it — a slow or down Argo can't touch the send routes or
// the spam gate's deadline.

export type UsageSubTool =
  | "spam-classify"
  | "enrich"
  | "draft-reply"
  | "thread-summary"
  | "decision-email"
  | "decision-submission";

export interface UsageTokens {
  // Uncached input only; cached reads are reported separately.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export interface UsageCost {
  usd: number | null;
  source: "reported" | "computed" | "none";
}

export interface UsageInput {
  subTool: UsageSubTool;
  model: string;
  billing: "iu" | "openrouter";
  outcome: "ok" | "error";
  durationMs: number;
  tokens: UsageTokens;
  cost: UsageCost;
}

export type UsageReporter = (input: UsageInput) => Promise<void>;

export interface ArgoConfig {
  url: string;
  secret: string;
  machine: string;
}

export const ZERO_TOKENS: UsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
};

export const NO_COST: UsageCost = { usd: null, source: "none" };

const REPORT_TIMEOUT_MS = 5_000;

export function buildUsageRecord(
  input: UsageInput,
  { machine, now = new Date() }: { machine: string; now?: Date },
) {
  const timestamp = now.toISOString();
  return {
    source: "email-gateway",
    source_id: crypto.randomUUID(),
    grain: "request",
    ts: timestamp,
    ingested_at: timestamp,
    model: input.model,
    model_norm: input.model,
    // Argo derives `workspace` from `project` only for path-driven sources and
    // leaves it NULL otherwise, which its Private/Work filter never matches —
    // so it is declared explicitly (same as image-gen's reporter).
    project: "email-gateway",
    workspace: "private",
    sub_tool: input.subTool,
    machine,
    billing: input.billing,
    outcome: input.outcome,
    input_tokens: input.tokens.inputTokens,
    output_tokens: input.tokens.outputTokens,
    cache_read_tokens: input.tokens.cacheReadTokens,
    cache_write_tokens: 0,
    reasoning_tokens: input.tokens.reasoningTokens,
    duration_ms: input.durationMs,
    cost_usd: input.cost.usd,
    cost_source: input.cost.source,
    raw: null,
  };
}

// `config` is read per call so a null/unset config is a pure no-op.
export function createUsageReporter({
  config,
  fetchImpl = fetch,
}: {
  config: () => ArgoConfig | null;
  fetchImpl?: typeof fetch;
}): UsageReporter {
  return async (input) => {
    const resolved = config();
    if (!resolved) return;

    try {
      const record = buildUsageRecord(input, { machine: resolved.machine });
      const response = await fetchImpl(resolved.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolved.secret}`,
        },
        body: JSON.stringify({ records: [record] }),
        // Telemetry, not agent work: a hung Argo drops the record instead of
        // piling up open sockets under the 256 MB limit.
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      // fetch only rejects on network failure; an auth or schema rejection
      // would otherwise drop the record silently.
      if (!response.ok) {
        console.error("Usage report rejected by Argo", {
          status: response.status,
        });
      }
    } catch (error) {
      console.error("Usage report failed", { error });
    }
  };
}

export const reportUsage: UsageReporter = createUsageReporter({
  config: () =>
    env.ARGO_USAGE_URL && env.ARGO_API_SECRET
      ? {
          url: env.ARGO_USAGE_URL,
          secret: env.ARGO_API_SECRET,
          machine: env.MACHINE,
        }
      : null,
});

// USD per million tokens, keyed by the configured LLM_MODEL.
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
}

const IU_RATES: Record<string, Rate> = {
  // usage-tracker/src/pricing.ts
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function computeIuCost(model: string, tokens: UsageTokens): UsageCost {
  const rate = IU_RATES[model];
  if (!rate) return NO_COST;
  const usd =
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cacheReadTokens * rate.cacheRead) /
    1_000_000;
  return { usd, source: "computed" };
}

// AI SDK v7 reports inputTokens as the total; the uncached part lives in
// inputTokenDetails.noCacheTokens (fallback: total minus cache reads).
// outputTokens already include reasoning tokens.
export function tokensFromUsage(usage: LanguageModelUsage): UsageTokens {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  return {
    inputTokens:
      usage.inputTokenDetails.noCacheTokens ??
      Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
  };
}

// Runs one IU `generateText` call and reports it, success or failure, without
// changing its result or error. Billing is always `iu`; cost is computed.
export async function trackLlmCall<
  Result extends { usage: LanguageModelUsage },
>({
  subTool,
  model,
  run,
  report = reportUsage,
}: {
  subTool: UsageSubTool;
  model: string;
  run: () => Promise<Result>;
  report?: UsageReporter;
}): Promise<Result> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const tokens = tokensFromUsage(result.usage);
    void report({
      subTool,
      model,
      billing: "iu",
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      tokens,
      cost: computeIuCost(model, tokens),
    }).catch(() => {});
    return result;
  } catch (error) {
    void report({
      subTool,
      model,
      billing: "iu",
      outcome: "error",
      durationMs: Date.now() - startedAt,
      tokens: ZERO_TOKENS,
      cost: NO_COST,
    }).catch(() => {});
    throw error;
  }
}
