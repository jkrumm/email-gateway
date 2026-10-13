import type { Experimental_DecisionModel as DecisionModel } from "ai";
// Types only: `@ai-sdk/provider` is a devDependency, so a runtime import
// crashes the prod image.
import type { Experimental_DecisionModelV4State as DecisionModelV4State } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

type OpenRouterModel = ReturnType<
  ReturnType<typeof createOpenRouter>["evaluationModel"]
>;
type OpenRouterState = Parameters<OpenRouterModel["doEvaluate"]>[0]["state"];

// `decide` hands models a normalized state (`[{ type: "json", value }]` or text
// parts), while @openrouter/ai-sdk-provider's `doEvaluate` (3.1.0) still posts
// `state` as given — the raw JSON object/array or string. Unwrap it back so
// OpenRouter receives the same body as before; drop this module once its
// provider speaks `doDecide`.
export function unwrapDecisionState(
  parts: DecisionModelV4State,
): OpenRouterState {
  const [only] = parts;
  if (parts.length === 1 && only?.type === "json") {
    const { value } = only;
    if (typeof value === "object" && value !== null) return value;
  }
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return JSON.stringify(part.value);
      throw new Error("OpenRouter decisions state cannot carry files");
    })
    .join("\n");
}

export function createOpenRouterDecisionModel({
  apiKey,
  model,
  appName,
  appUrl,
  fetch: fetchImpl,
}: {
  apiKey: string;
  model: string;
  appName: string;
  appUrl: string;
  // Injectable for tests.
  fetch?: typeof fetch;
}): DecisionModel {
  const evaluationModel = createOpenRouter({
    apiKey,
    appName,
    appUrl,
    ...(fetchImpl && { fetch: fetchImpl }),
  }).evaluationModel(model);

  return {
    specificationVersion: "v4",
    provider: evaluationModel.provider,
    modelId: evaluationModel.modelId,
    supportedQuestionTypes: evaluationModel.supportedQuestionTypes,
    doDecide: (options) =>
      evaluationModel.doEvaluate({
        ...options,
        state: unwrapDecisionState(options.state),
      }),
  };
}
