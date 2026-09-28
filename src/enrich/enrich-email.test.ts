import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { enrichEmail } from "./enrich-email";

function mockUsage() {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function mockModelReturning(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: mockUsage(),
      warnings: [],
    }),
  });
}

function mockModelThrowing(message: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

const baseEmail = {
  direction: "outbound" as const,
  fromAddress: "guest@example.com",
  toAddresses: ["charter@example.com"],
  subject: "Charter request",
  text: "We'd like to charter for 4 guests in August.",
  html: null,
};

const validEnrichment = {
  category: "inquiry",
  priority: "high",
  actionRequired: true,
  summary: "Guest requests a charter for 4 people in August.",
  suggestedAction: "Reply with availability",
  language: "en",
  facts: [{ label: "guests", value: "4" }],
};

describe("enrichEmail", () => {
  test("returns the parsed enrichment on success", async () => {
    const model = mockModelReturning(JSON.stringify(validEnrichment));

    const outcome = await enrichEmail({ email: baseEmail, model });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.category).toBe("inquiry");
      expect(outcome.result.actionRequired).toBe(true);
      expect(outcome.result.model).toBe(model.modelId);
    }
  });

  test("returns a fail-open error when the LLM is not configured", async () => {
    const outcome = await enrichEmail({ email: baseEmail });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("Enrichment not configured");
    }
  });
});

describe("enrichEmail robustness", () => {
  test("a malformed body yields an ok:false outcome instead of throwing", async () => {
    const outcome = await enrichEmail({
      email: { ...baseEmail, text: null, html: 5 as unknown as string },
      model: mockModelReturning(JSON.stringify(validEnrichment)),
    });
    expect(outcome.ok).toBe(false);
  });
});
