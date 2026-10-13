import { describe, expect, test } from "bun:test";
import { APICallError, experimental_evaluate as evaluate } from "ai";
import { createUeDecisionModel } from "./ue-decision-model";

const BASE_URL = "https://ue.example.com/decisions/v1";

const questions = {
  spam: { type: "boolean", instructions: "Is this spam?" },
  kind: {
    type: "choice",
    instructions: "What kind?",
    criteria: { seo: "SEO pitch", other: "Other" },
  },
  rating: {
    type: "score",
    instructions: "How pushy?",
    criteria: ["low", "mid", "high"],
  },
} as const;

function envelope(answers: unknown, usage?: object) {
  return {
    answers,
    model: "Cloudflare/clef",
    usage: usage ?? {
      input_tokens: 206,
      output_tokens: 0,
      cost: 0.00004944,
    },
  };
}

const verifiedContent = {
  kind: {
    choice: "seo",
    confidence: 0.9036,
    probabilities: { other: 0.0964, seo: 0.9036 },
    type: "choice",
  },
  spam: { noul: 0.983, type: "noul" },
  rating: {
    type: "score",
    score: 1.1,
    legend: { "0": "low", "1": "mid", "2": "high" },
    probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
    confidence: 0.7,
  },
};

function fakeFetch(respond: () => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createUeDecisionModel", () => {
  test("posts the systemone wire format with a Bearer header", async () => {
    const { fetchImpl, requests } = fakeFetch(() =>
      json(envelope(verifiedContent)),
    );
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: `${BASE_URL}/`,
      apiKey: "secret",
      fetch: fetchImpl,
    });

    await evaluate({
      model,
      state: { subject: "SEO audit" },
      questions,
      maxRetries: 0,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${BASE_URL}/systemone`);
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["api-key"]).toBeUndefined();

    const body = JSON.parse(requests[0]!.init.body as string);
    expect(body).toEqual({
      model: "decision-1-eu",
      state: { subject: "SEO audit" },
      questions: {
        spam: { type: "noul", instructions: "Is this spam?" },
        kind: questions.kind,
        rating: questions.rating,
      },
    });
  });

  test("sends a string state as is", async () => {
    const { fetchImpl, requests } = fakeFetch(() =>
      json(envelope({ spam: { noul: 0.5, type: "noul" } })),
    );
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: BASE_URL,
      apiKey: "k",
      fetch: fetchImpl,
    });

    await evaluate({
      model,
      state: "plain text",
      questions: { spam: questions.spam },
      maxRetries: 0,
    });

    const body = JSON.parse(requests[0]!.init.body as string);
    expect(body.state).toBe("plain text");
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("stream");
  });

  test("parses noul, choice and score answers, usage and cost", async () => {
    const { fetchImpl } = fakeFetch(() => json(envelope(verifiedContent)));
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: BASE_URL,
      apiKey: "k",
      fetch: fetchImpl,
    });

    const result = await evaluate({
      model,
      state: "x",
      questions,
      maxRetries: 0,
    });

    expect(result.answers.spam).toEqual({
      type: "boolean",
      probability: 0.983,
    });
    expect(result.answers.kind).toEqual({
      type: "choice",
      choice: "seo",
      probabilities: { other: 0.0964, seo: 0.9036 },
    });
    expect(result.answers.rating).toMatchObject({ type: "score", score: 1.1 });
    expect(result.usage.inputTokens).toBe(206);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.providerMetadata?.ue).toEqual({
      answers: {
        spam: {},
        kind: { confidence: 0.9036 },
        rating: { confidence: 0.7 },
      },
      usage: { cost: 0.00004944 },
    });
  });

  test("omits cost metadata when UE reports none (decision-1)", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        envelope(
          { spam: { noul: 0.1, type: "noul" } },
          { input_tokens: 133, output_tokens: 3 },
        ),
      ),
    );
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: BASE_URL,
      apiKey: "k",
      fetch: fetchImpl,
    });

    const result = await evaluate({
      model,
      state: "x",
      questions: { spam: questions.spam },
      maxRetries: 0,
    });

    expect(result.providerMetadata?.ue).toEqual({ answers: { spam: {} } });
    expect(result.usage.inputTokens).toBe(133);
    expect(result.usage.outputTokens).toBe(3);
  });

  test("a 429 throws an APICallError carrying statusCode and responseBody", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ error: "Capacity temporarily exceeded" }, 429),
    );
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: BASE_URL,
      apiKey: "k",
      fetch: fetchImpl,
    });

    const error = await evaluate({
      model,
      state: "x",
      questions: { spam: questions.spam },
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(APICallError.isInstance(error)).toBe(true);
    const apiError = error as APICallError;
    expect(apiError.statusCode).toBe(429);
    expect(apiError.responseBody).toContain("Capacity temporarily exceeded");
    expect(apiError.isRetryable).toBe(true);
  });

  test("a 400 is not retryable", async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: "bad" }, 400));
    const model = createUeDecisionModel("decision-1-eu", {
      baseUrl: BASE_URL,
      apiKey: "k",
      fetch: fetchImpl,
    });

    const error = (await evaluate({
      model,
      state: "x",
      questions: { spam: questions.spam },
      maxRetries: 0,
    }).catch((caught: unknown) => caught)) as APICallError;

    expect(error.statusCode).toBe(400);
    expect(error.isRetryable).toBe(false);
  });

  describe("malformed responses", () => {
    const run = (response: () => Response) => {
      const { fetchImpl } = fakeFetch(response);
      return evaluate({
        model: createUeDecisionModel("decision-1-eu", {
          baseUrl: BASE_URL,
          apiKey: "k",
          fetch: fetchImpl,
        }),
        state: "x",
        questions: { kind: questions.kind },
        maxRetries: 0,
      });
    };

    test("a body that is not JSON", async () => {
      await expect(run(() => new Response("not json"))).rejects.toThrow(
        "unexpected shape",
      );
    });

    test("a body without answers", async () => {
      await expect(run(() => json({ model: "x" }))).rejects.toThrow(
        "unexpected shape",
      );
    });

    test("answers that are not an object", async () => {
      await expect(run(() => json(envelope("not an object")))).rejects.toThrow(
        "unexpected shape",
      );
    });

    test("a missing question name", async () => {
      await expect(
        run(() => json(envelope({ other: { noul: 0.5, type: "noul" } }))),
      ).rejects.toThrow('"kind": no answer');
    });

    test("an answer of the wrong type", async () => {
      await expect(
        run(() => json(envelope({ kind: { noul: 0.5, type: "noul" } }))),
      ).rejects.toThrow("expected a choice answer");
    });

    test("a choice outside the criteria keys", async () => {
      await expect(
        run(() =>
          json(envelope({ kind: { choice: "unknown", type: "choice" } })),
        ),
      ).rejects.toThrow('unknown option "unknown"');
    });

    test("a probability outside 0-1", async () => {
      await expect(
        run(() =>
          json(
            envelope({
              kind: {
                choice: "seo",
                type: "choice",
                probabilities: { seo: 1.4, other: -0.4 },
              },
            }),
          ),
        ),
      ).rejects.toThrow("unexpected shape");
    });
  });
});
