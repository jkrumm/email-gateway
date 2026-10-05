import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { generateText, type LanguageModelUsage } from "ai";
import {
  buildUsageRecord,
  computeIuCost,
  createUsageReporter,
  NO_COST,
  tokensFromUsage,
  trackLlmCall,
  ZERO_TOKENS,
  type UsageInput,
} from "./argo";

const input: UsageInput = {
  subTool: "enrich",
  model: "gpt-6-luna",
  billing: "iu",
  outcome: "ok",
  durationMs: 42,
  tokens: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    reasoningTokens: 5,
  },
  cost: { usd: 0.01, source: "computed" },
};

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("buildUsageRecord", () => {
  test("maps every Argo field with an explicit workspace", () => {
    const now = new Date("2026-10-05T10:00:00.000Z");
    const record = buildUsageRecord(input, { machine: "vps", now });

    expect(record).toMatchObject({
      source: "email-gateway",
      grain: "request",
      ts: "2026-10-05T10:00:00.000Z",
      ingested_at: "2026-10-05T10:00:00.000Z",
      model: "gpt-6-luna",
      model_norm: "gpt-6-luna",
      project: "email-gateway",
      workspace: "private",
      sub_tool: "enrich",
      machine: "vps",
      billing: "iu",
      outcome: "ok",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      cache_write_tokens: 0,
      reasoning_tokens: 5,
      duration_ms: 42,
      cost_usd: 0.01,
      cost_source: "computed",
      raw: null,
    });
    expect(record.source_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(buildUsageRecord(input, { machine: "vps" }).source_id).not.toBe(
      record.source_id,
    );
  });
});

describe("createUsageReporter", () => {
  test("is a strict no-op when unconfigured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createUsageReporter({ config: () => null, fetchImpl })(input);
    expect(calls).toHaveLength(0);
  });

  test("POSTs { records: [record] } with the bearer secret", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createUsageReporter({
      config: () => ({
        url: "https://argo.example.com/usage/records",
        secret: "s3cret",
        machine: "vps",
      }),
      fetchImpl,
    })(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://argo.example.com/usage/records");
    expect(calls[0]!.init.method).toBe("POST");
    expect(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer s3cret");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      source: "email-gateway",
      machine: "vps",
      sub_tool: "enrich",
    });
  });

  test("never throws on a non-2xx or a network failure", async () => {
    const config = () => ({
      url: "https://argo.example.com",
      secret: "s",
      machine: "vps",
    });
    const rejected = fakeFetch(401);
    await createUsageReporter({ config, fetchImpl: rejected.fetchImpl })(input);
    expect(rejected.calls).toHaveLength(1);

    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await createUsageReporter({ config, fetchImpl: failing })(input);
  });
});

describe("IU cost and tokens", () => {
  test("computes gpt-6-luna cost from the rate table, unknown model is none", () => {
    const cost = computeIuCost("gpt-6-luna", {
      ...ZERO_TOKENS,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost.source).toBe("computed");
    expect(cost.usd).toBeCloseTo(0.1 + 0.5 + 0.01, 10);
    expect(computeIuCost("mystery-model", ZERO_TOKENS)).toEqual(NO_COST);
  });

  test("input tokens are the uncached part", () => {
    const usage = {
      inputTokens: 150,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: undefined,
      },
      outputTokens: 20,
      outputTokenDetails: { textTokens: 15, reasoningTokens: 5 },
      totalTokens: 170,
    } satisfies LanguageModelUsage;
    expect(tokensFromUsage(usage)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      reasoningTokens: 5,
    });
    expect(
      tokensFromUsage({
        ...usage,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 50,
          cacheWriteTokens: undefined,
        },
      }).inputTokens,
    ).toBe(100);
  });
});

describe("trackLlmCall", () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "hi" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      },
      warnings: [],
    }),
  });

  test("reports success with computed IU cost and returns the result", async () => {
    const reports: UsageInput[] = [];
    const result = await trackLlmCall({
      subTool: "draft-reply",
      model: "gpt-6-luna",
      run: () => generateText({ model, prompt: "x" }),
      report: async (r) => void reports.push(r),
    });

    expect(result.text).toBe("hi");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      subTool: "draft-reply",
      billing: "iu",
      outcome: "ok",
      tokens: { inputTokens: 10, outputTokens: 4 },
      cost: { source: "computed" },
    });
  });

  test("reports failures with zero usage and rethrows", async () => {
    const reports: UsageInput[] = [];
    await expect(
      trackLlmCall({
        subTool: "enrich",
        model: "gpt-6-luna",
        run: async () => {
          throw new Error("boom");
        },
        report: async (r) => void reports.push(r),
      }),
    ).rejects.toThrow("boom");

    expect(reports[0]).toMatchObject({
      outcome: "error",
      tokens: ZERO_TOKENS,
      cost: NO_COST,
    });
  });
});
