import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import { _test } from "./otel";
import { tokensFromUsage, traceLlmCall } from "./llm-call";

describe("tokensFromUsage", () => {
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

describe("traceLlmCall", () => {
  test("a call is an llm.<lane> client span plus an llm.call event, without prompt or output", async () => {
    const capture = _test.capture();
    const result = await traceLlmCall({
      subTool: "spam-classify",
      model: "gpt-6-luna",
      run: async () => ({
        text: "SECRET-OUTPUT",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          inputTokenDetails: {},
          outputTokenDetails: {},
        } as never,
      }),
    });
    capture.stop();

    expect(result.text).toBe("SECRET-OUTPUT");
    const [span] = capture.spans;
    expect(span?.name).toBe("llm.classify");
    expect(span?.kind).toBe(3);
    expect(span?.attributes).toContainEqual({
      key: "llm.model",
      value: { stringValue: "gpt-6-luna" },
    });
    expect(span?.attributes).toContainEqual({
      key: "outcome",
      value: { stringValue: "ok" },
    });
    expect(span?.attributes).toContainEqual({
      key: "llm.input_tokens",
      value: { intValue: "10" },
    });
    const event = capture.logs.find((l) => l.body.stringValue === "llm.call");
    expect(event?.attributes).toContainEqual({
      key: "lane",
      value: { stringValue: "classify" },
    });
    expect(JSON.stringify([capture.spans, capture.logs])).not.toContain(
      "SECRET-OUTPUT",
    );
  });

  test("a failure is an error span carrying only the error name, and rethrows", async () => {
    const capture = _test.capture();
    await expect(
      traceLlmCall({
        subTool: "decision-email",
        model: "m",
        run: async () => {
          throw new TypeError("prompt echoed: hello@example.com");
        },
      }),
    ).rejects.toThrow(TypeError);
    capture.stop();

    expect(capture.spans[0]?.name).toBe("llm.jev");
    expect(capture.spans[0]?.status).toEqual({ code: 2, message: "TypeError" });
    expect(JSON.stringify(capture.spans)).not.toContain("hello@example.com");
    expect(
      capture.logs.find((l) => l.body.stringValue === "llm.call")?.severityText,
    ).toBe("WARN");
  });
});
