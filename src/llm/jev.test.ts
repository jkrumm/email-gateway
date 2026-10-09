import { describe, expect, test } from "bun:test";
import { fakeJevModel, openrouterMetadata } from "../test/fake-jev";
import type { UsageInput } from "../usage/argo";
import { decide, decideShadow, jevConfigFromEnv, type JevConfig } from "./jev";

const config: JevConfig = {
  provider: "openrouter",
  apiKey: "test-key",
  model: "cloudflare/clef",
};

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
      providerMetadata: openrouterMetadata({ confidence: { verdict: 0.97 } }),
    }));

    const { answers } = await decide({
      config,
      model,
      state: { subject: "SEO audit" },
      subTool: "decision-email",
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
      decide({
        config,
        model,
        state: { subject: "x" },
        questions,
        subTool: "decision-email",
      }),
    ).rejects.toThrow("high demand");

    // maxRetries: 0 means exactly one HTTP-equivalent attempt; a leftover
    // SDK-level retry would show up here as more than one call.
    expect(calls).toHaveLength(1);
  });

  test("falls back to the choice's probability when no confidence is reported", async () => {
    for (const providerMetadata of [
      undefined,
      openrouterMetadata({ confidence: { other: 0.5 } }),
      openrouterMetadata({ confidence: { verdict: 1.5 } }),
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
        subTool: "decision-email",
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
        subTool: "decision-email",
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
      decide({
        config: null,
        model,
        state: "x",
        questions,
        subTool: "decision-email",
      }),
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
        subTool: "decision-email",
        questions: { is_spam: questions.is_spam },
        // SDK retries transient failures; a plain Error is not retried.
      }),
    ).rejects.toThrow("gateway 529");
  });
});

describe("decide usage", () => {
  const reportsTo = () => {
    const reports: UsageInput[] = [];
    return {
      reports,
      report: async (input: UsageInput) => void reports.push(input),
    };
  };

  test("reads confidence and cost from providerMetadata.openrouter and reports them", async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: rawAnswers.verdict },
      warnings: [],
      usage: { inputTokens: 147, outputTokens: 3 },
      providerMetadata: openrouterMetadata({
        confidence: { verdict: 0.91 },
        cost: 0.00003528,
      }),
    }));
    const { reports, report } = reportsTo();

    const { answers, usage } = await decide({
      config,
      model,
      state: "x",
      questions: { verdict: questions.verdict },
      subTool: "decision-submission",
      report,
    });

    expect(answers.verdict.confidence).toBe(0.91);
    expect(usage).toEqual({
      inputTokens: 147,
      outputTokens: 3,
      costUsd: 0.00003528,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      subTool: "decision-submission",
      model: "cloudflare/clef",
      billing: "openrouter",
      outcome: "ok",
      tokens: {
        inputTokens: 147,
        outputTokens: 3,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      cost: { usd: 0.00003528, source: "reported" },
    });
  });

  test("a malformed cost or missing metadata reports cost source none", async () => {
    for (const providerMetadata of [
      undefined,
      { openrouter: { usage: { cost: "free" } } },
      { openrouter: { usage: { cost: -1 } } },
    ]) {
      const { model } = fakeJevModel(() => ({
        answers: { is_spam: rawAnswers.is_spam },
        warnings: [],
        providerMetadata,
      }));
      const { reports, report } = reportsTo();

      const { usage } = await decide({
        config,
        model,
        state: "x",
        questions: { is_spam: questions.is_spam },
        subTool: "decision-email",
        report,
      });

      expect(usage.costUsd).toBeNull();
      expect(reports[0]!.cost).toEqual({ usd: null, source: "none" });
    }
  });

  test("reports a failed call with zero usage and rethrows", async () => {
    const { model } = fakeJevModel(() => {
      throw new Error("openrouter 402");
    });
    const { reports, report } = reportsTo();

    await expect(
      decide({
        config,
        model,
        state: "x",
        questions: { is_spam: questions.is_spam },
        subTool: "decision-email",
        report,
      }),
    ).rejects.toThrow("402");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: "error",
      billing: "openrouter",
      tokens: { inputTokens: 0, outputTokens: 0 },
      cost: { usd: null, source: "none" },
    });
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
        subTool: "decision-email" as const,
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
      subTool: "decision-email" as const,
      questions: shadowQuestions,
      pick,
      config,
      model: ok.model,
    })!;
    expect(success).toMatchObject({ spam: 0.96, model: "cloudflare/clef" });
    expect(success.latencyMs).toBeGreaterThanOrEqual(0);

    const bad = fakeJevModel(() => {
      throw new Error("gateway 529");
    });
    await expect(
      decideShadow({
        state: "x",
        subTool: "decision-email" as const,
        questions: shadowQuestions,
        pick,
        config,
        model: bad.model,
      })!,
    ).rejects.toThrow("gateway 529");
  });
});

describe("jevConfigFromEnv", () => {
  const base = {
    DECISION_PROVIDER: "ue" as const,
    DECISION_MODEL: "clef-eu",
    OPENROUTER_API_KEY: undefined,
    LLM_BASE_URL: "https://ue.example.com/openai/v1",
    LLM_API_KEY: "ue-key",
  };

  test("ue needs LLM_BASE_URL and LLM_API_KEY", () => {
    expect(jevConfigFromEnv(base)).toEqual({
      provider: "ue",
      apiKey: "ue-key",
      baseUrl: "https://ue.example.com/openai/v1",
      model: "clef-eu",
    });
    expect(jevConfigFromEnv({ ...base, LLM_API_KEY: undefined })).toBeNull();
    expect(jevConfigFromEnv({ ...base, LLM_BASE_URL: undefined })).toBeNull();
    // An OpenRouter key alone never enables the ue lane.
    expect(
      jevConfigFromEnv({
        ...base,
        LLM_API_KEY: undefined,
        OPENROUTER_API_KEY: "or-key",
      }),
    ).toBeNull();
  });

  test("openrouter needs OPENROUTER_API_KEY only", () => {
    const openrouter = {
      ...base,
      DECISION_PROVIDER: "openrouter" as const,
      DECISION_MODEL: "cloudflare/clef",
      OPENROUTER_API_KEY: "or-key",
    };
    expect(jevConfigFromEnv(openrouter)).toEqual({
      provider: "openrouter",
      apiKey: "or-key",
      model: "cloudflare/clef",
    });
    expect(
      jevConfigFromEnv({ ...openrouter, OPENROUTER_API_KEY: undefined }),
    ).toBeNull();
  });
});

describe("decide with the ue provider", () => {
  test("reads providerMetadata.ue and reports billing iu with the reported cost", async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: rawAnswers.verdict },
      warnings: [],
      usage: { inputTokens: 206, outputTokens: 0 },
      providerMetadata: {
        ue: {
          answers: { verdict: { confidence: 0.9 } },
          usage: { cost: 0.00004944 },
        },
      },
    }));
    const reports: UsageInput[] = [];

    const { answers, usage } = await decide({
      config: { provider: "ue", apiKey: "k", baseUrl: "u", model: "clef-eu" },
      model,
      state: "x",
      questions: { verdict: questions.verdict },
      subTool: "decision-email",
      report: async (input) => void reports.push(input),
    });

    expect(answers.verdict.confidence).toBe(0.9);
    expect(usage.costUsd).toBe(0.00004944);
    expect(reports[0]).toMatchObject({
      model: "clef-eu",
      billing: "iu",
      outcome: "ok",
      cost: { usd: 0.00004944, source: "reported" },
    });
  });

  test("a failed ue call reports billing iu", async () => {
    const { model } = fakeJevModel(() => {
      throw new Error("boom");
    });
    const reports: UsageInput[] = [];

    await expect(
      decide({
        config: { provider: "ue", apiKey: "k", baseUrl: "u", model: "clef-eu" },
        model,
        state: "x",
        questions: { is_spam: questions.is_spam },
        subTool: "decision-email",
        report: async (input) => void reports.push(input),
      }),
    ).rejects.toThrow("boom");
    expect(reports[0]).toMatchObject({ billing: "iu", outcome: "error" });
  });
});
