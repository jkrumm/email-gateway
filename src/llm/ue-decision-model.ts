import { APICallError, InvalidResponseDataError } from "ai";
// Types only: `@ai-sdk/provider` is a devDependency, so a runtime import
// crashes the prod image. Runtime values (the error classes) come from `ai`.
import type {
  Experimental_EvaluationModelV4 as EvaluationModelV4,
  Experimental_EvaluationModelV4Answer as EvaluationModelV4Answer,
  Experimental_EvaluationModelV4CallOptions as CallOptions,
  Experimental_EvaluationModelV4Question as EvaluationModelV4Question,
  Experimental_EvaluationModelV4Result as EvaluationModelV4Result,
} from "@ai-sdk/provider";
import { z } from "zod";

// An AI SDK evaluation model over IU's Unified Endpoint (UE): a chat-completions
// request whose `response_format` is `{ type: "questions" }`. The answers come
// back as a JSON string in `choices[0].message.content`. AI SDK question types
// map `boolean` -> `noul` (P(yes)), `choice` -> `choice`, `score` -> `score`.
// Sampling params are deliberately never sent.

export const UE_PROVIDER = "ue";

// UE rounds probabilities and scores to four decimals.
const UE_ROUNDING = { probabilityDecimals: 4, scoreDecimals: 4 };

const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);

const ueAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilities.optional(),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite().min(0),
    probabilities: probabilities.optional(),
    confidence: probability.optional(),
    legend: z.unknown().optional(),
  }),
]);
type UeAnswer = z.infer<typeof ueAnswerSchema>;

const ueResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

const EXPECTED_ANSWER_TYPE = {
  boolean: "noul",
  choice: "choice",
  score: "score",
} as const;

function toUeQuestion(question: EvaluationModelV4Question) {
  if (question.type === "boolean") {
    return {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria && { criteria: question.criteria }),
    };
  }
  return question;
}

function toEvaluationAnswer(
  id: string,
  question: EvaluationModelV4Question,
  answer: UeAnswer | undefined,
  data: unknown,
): EvaluationModelV4Answer {
  const fail = (message: string): never => {
    throw new InvalidResponseDataError({
      data,
      message: `UE question "${id}": ${message}`,
    });
  };
  if (!answer) return fail("no answer returned");
  if (answer.type !== EXPECTED_ANSWER_TYPE[question.type]) {
    return fail(`expected a ${question.type} answer, got "${answer.type}"`);
  }

  switch (answer.type) {
    case "noul":
      return { type: "boolean", probability: answer.noul };
    case "choice":
      if (
        question.type === "choice" &&
        !Object.hasOwn(question.criteria, answer.choice)
      ) {
        return fail(`selected unknown option "${answer.choice}"`);
      }
      return {
        type: "choice",
        choice: answer.choice,
        ...(answer.probabilities && { probabilities: answer.probabilities }),
      };
    case "score":
      return {
        type: "score",
        score: answer.score,
        ...(answer.probabilities && { probabilities: answer.probabilities }),
      };
  }
}

function toAnswerMetadata(answer: UeAnswer) {
  if (answer.type === "noul" || answer.confidence === undefined) return {};
  return { confidence: answer.confidence };
}

export interface UeDecisionModelSettings {
  // Chat-completions base, e.g. `https://…/openai/v1`.
  baseUrl: string;
  apiKey: string;
  // Injectable for tests.
  fetch?: typeof fetch;
}

export function createUeDecisionModel(
  modelId: string,
  { baseUrl, apiKey, fetch: fetchImpl = fetch }: UeDecisionModelSettings,
): EvaluationModelV4 {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    specificationVersion: "v4",
    provider: UE_PROVIDER,
    modelId,
    supportedQuestionTypes: ["choice", "score", "boolean"],

    async doEvaluate({
      state,
      questions,
      abortSignal,
      headers,
    }: CallOptions): Promise<EvaluationModelV4Result> {
      const body = {
        model: modelId,
        stream: false,
        messages: [
          {
            role: "user",
            content: typeof state === "string" ? state : JSON.stringify(state),
          },
        ],
        response_format: {
          type: "questions",
          questions: Object.fromEntries(
            Object.entries(questions).map(([id, question]) => [
              id,
              toUeQuestion(question),
            ]),
          ),
        },
      };

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new APICallError({
          message: `UE decision request failed with status ${response.status}`,
          url,
          requestBodyValues: body,
          statusCode: response.status,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: responseText,
          isRetryable: response.status === 429 || response.status >= 500,
        });
      }

      const rawBody = safeJson(responseText);
      const envelope = ueResponseSchema.safeParse(rawBody);
      if (!envelope.success) {
        throw new InvalidResponseDataError({
          data: responseText,
          message: `UE decision response has an unexpected shape: ${envelope.error.message}`,
        });
      }

      const content = envelope.data.choices[0]!.message.content;
      const parsed = z
        .record(z.string(), ueAnswerSchema)
        .safeParse(safeJson(content));
      if (!parsed.success) {
        throw new InvalidResponseDataError({
          data: content,
          message: `UE decision answers are malformed: ${parsed.error.message}`,
        });
      }

      const answers: Record<string, EvaluationModelV4Answer> = {};
      const answerMetadata: Record<string, { confidence?: number }> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = parsed.data[id];
        answers[id] = toEvaluationAnswer(id, question, answer, content);
        answerMetadata[id] = answer ? toAnswerMetadata(answer) : {};
      }

      const { usage } = envelope.data;
      return {
        answers,
        rounding: UE_ROUNDING,
        usage: usage && {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        },
        warnings: [],
        providerMetadata: {
          [UE_PROVIDER]: {
            answers: answerMetadata,
            ...(usage?.cost !== undefined && { usage: { cost: usage.cost } }),
          },
        },
        response: {
          id: envelope.data.id,
          modelId: envelope.data.model,
          headers: Object.fromEntries(response.headers.entries()),
          body: rawBody,
        },
      };
    },
  };
}

// Unparseable text becomes `undefined`, which the zod schemas then reject.
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
