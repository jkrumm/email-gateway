import type { Experimental_EvaluationModel as EvaluationModel } from "ai";

type DoEvaluate = Extract<
  EvaluationModel,
  { doEvaluate: unknown }
>["doEvaluate"];
type Options = Parameters<DoEvaluate>[0];
type Result = Awaited<ReturnType<DoEvaluate>>;

// Fake gateway evaluation model: `respond` sees the options the SDK passes
// down (state, questions, abortSignal) and returns the raw model result.
export function fakeJevModel(
  respond: (options: Options) => Result | Promise<Result>,
) {
  const calls: Options[] = [];
  const model: EvaluationModel = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-jev",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: async (options) => {
      calls.push(options);
      return respond(options);
    },
  };
  return { model, calls };
}

// OpenRouter's evaluation model reports per-answer choice confidence and the
// request cost (USD) here.
export function openrouterMetadata({
  confidence = {},
  cost,
}: {
  confidence?: Record<string, number>;
  cost?: number;
} = {}) {
  return {
    openrouter: {
      answers: Object.fromEntries(
        Object.entries(confidence).map(([key, value]) => [
          key,
          { confidence: value },
        ]),
      ),
      ...(cost !== undefined && { usage: { cost } }),
    },
  };
}
