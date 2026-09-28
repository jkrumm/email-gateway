import { describe, expect, test } from "bun:test";
import { fakeJevModel, typesafeConfidence } from "../test/fake-jev";
import { decide, decideShadow, type JevConfig } from "./jev";

const config: JevConfig = { apiKey: "test-key", model: "typesafe-ai/jev" };

const questions = {
  verdict: {
    type: "choice",
    instructions: "Classify",
    criteria: { legit: "genuine", spam: "junk" },
  },
  is_spam: { type: "boolean", instructions: "Is this spam?" },
  tone: {
    type: "score",
    instructions: "How pushy?",
    criteria: ["low", "mid", "high"],
  },
} as const;

const rawAnswers = {
  verdict: {
    type: "choice" as const,
    choice: "spam",
    probabilities: { legit: 0.02, spam: 0.98 },
  },
  is_spam: { type: "boolean" as const, probability: 0.96 },
  tone: {
    type: "score" as const,
    score: 1,
    probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
  },
};

describe("decide", () => {
  test("passes state and questions to the model and returns typed answers", async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: rawAnswers,
      warnings: [],
      providerMetadata: typesafeConfidence({ verdict: 0.97 }),
    }));

    const { answers } = await decide({
      config,
      model,
      state: { subject: "SEO audit" },
      questions,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toEqual({ subject: "SEO audit" });
    expect(calls[0]!.questions).toEqual(questions);
    expect(calls[0]!.abortSignal).toBeInstanceOf(AbortSignal);

    // Types narrow by question type: choice → .choice, boolean → .probability.
    const choice: "legit" | "spam" = answers.verdict.choice;
    expect(choice).toBe("spam");
    expect(answers.verdict.confidence).toBe(0.97);
    expect(answers.is_spam.probability).toBe(0.96);
    expect(answers.tone.score).toBe(1);
  });

  test("never retries at the SDK level — the durable job queue owns retries", async () => {
    const { model, calls } = fakeJevModel(() => {
      throw new Error(
        "The upstream provider is currently experiencing high demand",
      );
    });

    await expect(
      decide({ config, model, state: { subject: "x" }, questions }),
    ).rejects.toThrow("high demand");

    // maxRetries: 0 means exactly one HTTP-equivalent attempt; a leftover
    // SDK-level retry would show up here as more than one call.
    expect(calls).toHaveLength(1);
  });

  test("falls back to the choice's probability when no confidence is reported", async () => {
    for (const providerMetadata of [
      undefined,
      typesafeConfidence({ other: 0.5 }),
      typesafeConfidence({ verdict: 1.5 }),
    ]) {
      const { model } = fakeJevModel(() => ({
        answers: { verdict: rawAnswers.verdict },
        warnings: [],
        providerMetadata,
      }));

      const { answers } = await decide({
        config,
        model,
        state: "x",
        questions: { verdict: questions.verdict },
      });

      expect(answers.verdict.confidence).toBe(0.98);
    }
  });

  test("throws when a choice has neither confidence nor probabilities", async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: { type: "choice", choice: "spam" } },
      warnings: [],
    }));

    await expect(
      decide({
        config,
        model,
        state: "x",
        questions: { verdict: questions.verdict },
      }),
    ).rejects.toThrow('no confidence for "verdict"');
  });

  test("throws when Jev is not configured", async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: {},
      warnings: [],
    }));

    await expect(
      decide({ config: null, model, state: "x", questions }),
    ).rejects.toThrow("Jev not configured");
    expect(calls).toHaveLength(0);
  });

  test("propagates a model failure", async () => {
    const { model } = fakeJevModel(() => {
      throw new Error("gateway 529");
    });

    await expect(
      decide({
        config,
        model,
        state: "x",
        questions: { is_spam: questions.is_spam },
        // SDK retries transient failures; a plain Error is not retried.
      }),
    ).rejects.toThrow("gateway 529");
  });
});

describe("decideShadow", () => {
  const shadowQuestions = { is_spam: questions.is_spam };
  const pick = ({ is_spam }: { is_spam: { probability: number } }) => ({
    spam: is_spam.probability,
  });

  test("returns null when disabled", () => {
    expect(
      decideShadow({
        state: "x",
        questions: shadowQuestions,
        pick,
        config: null,
      }),
    ).toBeNull();
  });

  test("maps answers with latency and model on success, and rejects on failure", async () => {
    const ok = fakeJevModel(() => ({
      answers: { is_spam: rawAnswers.is_spam },
      warnings: [],
    }));
    const success = await decideShadow({
      state: "x",
      questions: shadowQuestions,
      pick,
      config,
      model: ok.model,
    })!;
    expect(success).toMatchObject({ spam: 0.96, model: "typesafe-ai/jev" });
    expect(success.latencyMs).toBeGreaterThanOrEqual(0);

    const bad = fakeJevModel(() => {
      throw new Error("gateway 529");
    });
    await expect(
      decideShadow({
        state: "x",
        questions: shadowQuestions,
        pick,
        config,
        model: bad.model,
      })!,
    ).rejects.toThrow("gateway 529");
  });
});
