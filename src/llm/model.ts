import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { env } from "../env";

let cachedModel: LanguageModel | null = null;

export function getLlmConfig(): {
  baseURL: string;
  apiKey: string;
  model: string;
} | null {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = env;
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) return null;
  return {
    baseURL: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
  };
}

export function getModel(): LanguageModel {
  if (!cachedModel) {
    const config = getLlmConfig();
    if (!config) {
      throw new Error("LLM not configured");
    }
    const provider = createOpenAICompatible({
      name: "llm",
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      // Without this the provider only asks for json_object mode and never
      // sends the schema, so GPT-class models answer in their own shape.
      supportsStructuredOutputs: true,
    });
    cachedModel = provider(config.model);
  }
  return cachedModel;
}

export function getModelId(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}
