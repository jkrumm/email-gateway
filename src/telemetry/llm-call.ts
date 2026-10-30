import type { LanguageModelUsage } from "ai";
import { log } from "./log";
import { startSpan } from "./otel";
import { errorName } from "./otel-format";

export type LlmSubTool =
  | "spam-classify"
  | "enrich"
  | "draft-reply"
  | "thread-summary"
  | "decision-email"
  | "decision-submission";

export interface LlmTokens {
  // Uncached input only; cached reads are counted separately.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

// AI SDK v7 reports inputTokens as the total; the uncached part lives in
// inputTokenDetails.noCacheTokens (fallback: total minus cache reads).
export function tokensFromUsage(usage: LanguageModelUsage): LlmTokens {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  return {
    inputTokens:
      usage.inputTokenDetails.noCacheTokens ??
      Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
  };
}

// The span/event lane of a sub-tool: `llm.<lane>`.
function laneOf(subTool: LlmSubTool): string {
  if (subTool === "spam-classify") return "classify";
  if (subTool.startsWith("decision-")) return "jev";
  return subTool;
}

// Opens the `llm.<lane>` client span for one model call; `finish` ends it and emits the
// `llm.call` event. Only the model, outcome, latency and token counts are recorded — never a
// prompt, an output, or the provider's error text (which can echo either).
export function startLlmCall(subTool: LlmSubTool, model: string) {
  const lane = laneOf(subTool);
  const startedAt = Date.now();
  const span = startSpan(`llm.${lane}`, { "llm.model": model }, "client");
  return {
    finish({
      outcome,
      tokens,
      error,
    }: {
      outcome: "ok" | "error";
      tokens?: LlmTokens;
      error?: unknown;
    }): void {
      const latencyMs = Date.now() - startedAt;
      span.setAttributes({
        outcome,
        "llm.latency_ms": latencyMs,
        ...(tokens && {
          "llm.input_tokens": tokens.inputTokens,
          "llm.output_tokens": tokens.outputTokens,
          "llm.cache_read_tokens": tokens.cacheReadTokens,
        }),
      });
      if (outcome === "error") {
        span.setStatus("error", errorName(error));
      }
      span.end();
      log.event(
        "llm.call",
        { lane, outcome, latency_ms: latencyMs },
        outcome === "error" ? "warn" : "info",
      );
    },
  };
}

// Runs one `generateText` call inside its `llm.<lane>` span, success or
// failure, without changing its result or error.
export async function traceLlmCall<
  Result extends { usage: LanguageModelUsage },
>({
  subTool,
  model,
  run,
}: {
  subTool: LlmSubTool;
  model: string;
  run: () => Promise<Result>;
}): Promise<Result> {
  const call = startLlmCall(subTool, model);
  try {
    const result = await run();
    call.finish({ outcome: "ok", tokens: tokensFromUsage(result.usage) });
    return result;
  } catch (error) {
    call.finish({ outcome: "error", error });
    throw error;
  }
}
