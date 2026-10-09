import { describe, expect, test } from "bun:test";
import { fakeJevModel, openrouterMetadata } from "../test/fake-jev";
import { CATEGORIES } from "./categories";
import { judgeEmailWithJev } from "./jev-email";

const config = {
  provider: "openrouter" as const,
  apiKey: "k",
  model: "cloudflare/clef",
};
const payload = {
  direction: "inbound" as const,
  from: "a@example.com",
  to: ["me@example.com"],
  subject: "Charter",
  text: "Hi",
};

describe("judgeEmailWithJev", () => {
  test("returns null when Jev is disabled", () => {
    expect(judgeEmailWithJev({ payload, config: null })).toBeNull();
  });

  test("asks spam + category (same category set as the LLM) in one call", async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: {
        spam: { type: "boolean", probability: 0.04 },
        category: {
          type: "choice",
          choice: "inquiry",
          probabilities: Object.fromEntries(
            CATEGORIES.map((category) => [
              category,
              category === "inquiry" ? 0.9 : 0.01,
            ]),
          ),
        },
      },
      warnings: [],
      providerMetadata: openrouterMetadata({ confidence: { category: 0.88 } }),
    }));

    const outcome = await judgeEmailWithJev({
      payload,
      config,
      model,
    })!;

    expect(outcome).toMatchObject({
      spamProbability: 0.04,
      category: "inquiry",
      categoryConfidence: 0.88,
    });
    expect(calls).toHaveLength(1);
    const asked = calls[0]!.questions;
    expect(asked.spam!.type).toBe("boolean");
    expect(Object.keys(asked.category!.criteria as object)).toEqual([
      ...CATEGORIES,
    ]);
  });

  test("caps the text state at 6,000 chars, keeping from/subject first", async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: {
        spam: { type: "boolean", probability: 0.1 },
        category: {
          type: "choice",
          choice: "inquiry",
          probabilities: Object.fromEntries(
            CATEGORIES.map((category) => [
              category,
              category === "inquiry" ? 0.9 : 0.01,
            ]),
          ),
        },
      },
      warnings: [],
    }));

    await judgeEmailWithJev({
      payload: { ...payload, text: "x".repeat(12_000) },
      config,
      model,
    })!;

    const state = calls[0]!.state as typeof payload;
    expect(state.text).toHaveLength(6_000);
    expect(Object.keys(state).slice(0, 3)).toEqual(["direction", "from", "to"]);
    expect(state.subject).toBe("Charter");
  });

  test("rejects when the call fails so the queue can retry", async () => {
    const { model } = fakeJevModel(() => {
      throw new Error("gateway 401");
    });

    await expect(
      judgeEmailWithJev({ payload, config, model })!,
    ).rejects.toThrow("401");
  });
});
