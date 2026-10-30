import { describe, expect, test } from "bun:test";
import { decide, type JevConfig } from "./jev";
import {
  createOpenRouterDecisionModel,
  unwrapDecisionState,
} from "./openrouter-decision-model";

describe("unwrapDecisionState", () => {
  test("a single json object or array part is unwrapped to the raw value", () => {
    expect(
      unwrapDecisionState([{ type: "json", value: { subject: "SEO audit" } }]),
    ).toEqual({ subject: "SEO audit" });
    expect(unwrapDecisionState([{ type: "json", value: [1, "a"] }])).toEqual([
      1,
      "a",
    ]);
  });

  test("a single json primitive becomes its JSON text", () => {
    expect(unwrapDecisionState([{ type: "json", value: 42 }])).toBe("42");
    expect(unwrapDecisionState([{ type: "json", value: null }])).toBe("null");
  });

  test("text parts are joined with newlines", () => {
    expect(unwrapDecisionState([{ type: "text", text: "hello" }])).toBe(
      "hello",
    );
    expect(
      unwrapDecisionState([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  test("mixed json and text parts become one string", () => {
    expect(
      unwrapDecisionState([
        { type: "text", text: "intro" },
        { type: "json", value: { a: 1 } },
      ]),
    ).toBe('intro\n{"a":1}');
  });

  test("a file part throws", () => {
    expect(() =>
      unwrapDecisionState([
        {
          type: "file",
          data: { type: "data", data: new Uint8Array([1]) },
          mediaType: "image/png",
        },
      ]),
    ).toThrow("cannot carry files");
  });
});

describe("createOpenRouterDecisionModel", () => {
  const config: JevConfig = {
    provider: "openrouter",
    apiKey: "or-key",
    model: "cloudflare/clef",
  };
  const questions = {
    verdict: {
      type: "choice",
      instructions: "Classify",
      criteria: { legit: "genuine", spam: "junk" },
    },
  } as const;

  async function wireState(state: Parameters<typeof decide>[0]["state"]) {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    const model = createOpenRouterDecisionModel({
      apiKey: "or-key",
      model: "cloudflare/clef",
      appName: "test",
      appUrl: "https://example.com",
      fetch: (async (url: string, init: RequestInit) => {
        bodies.push({ url, body: JSON.parse(init.body as string) });
        return Response.json({
          answers: {
            verdict: {
              type: "choice",
              choice: "spam",
              probabilities: { legit: 0.02, spam: 0.98 },
              confidence: 0.9,
            },
          },
        });
      }) as unknown as typeof fetch,
    });
    const { answers } = await decide({
      config,
      model,
      state,
      questions,
      subTool: "decision-email",
    });
    return { requests: bodies, answers };
  }

  test("a JSON object state reaches the wire raw", async () => {
    const { requests, answers } = await wireState({ subject: "SEO audit" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/decisions");
    expect(requests[0]!.body.state).toEqual({ subject: "SEO audit" });
    expect(requests[0]!.body.model).toBe("cloudflare/clef");
    expect(answers.verdict.confidence).toBe(0.9);
  });

  test("a string state reaches the wire raw", async () => {
    const { requests } = await wireState("plain text");

    expect(requests[0]!.body.state).toBe("plain text");
  });
});
