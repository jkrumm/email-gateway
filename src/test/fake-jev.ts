import type { Experimental_DecisionModel as DecisionModel } from 'ai'
import { unwrapDecisionState } from '../llm/openrouter-decision-model'

type DoDecide = Extract<DecisionModel, { doDecide: unknown }>['doDecide']
type Options = Parameters<DoDecide>[0]
type Result = Awaited<ReturnType<DoDecide>>

// Fake decision model: `respond` sees the options the SDK passes
// down (state, questions, abortSignal) and returns the raw model result.
export function fakeJevModel(respond: (options: Options) => Result | Promise<Result>) {
  const calls: Options[] = []
  const model: DecisionModel = {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-jev',
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    doDecide: async (options) => {
      calls.push(options)
      return respond(options)
    },
  }
  return { model, calls }
}

// The state a decision model sees: `decide` normalizes a JSON object state to
// a single `json` part and a string to a `text` part; this undoes that.
export function stateOf(options: Options): unknown {
  return unwrapDecisionState(options.state)
}

// OpenRouter's decision model reports per-answer choice confidence and the
// request cost (USD) here.
export function openrouterMetadata({
  confidence = {},
  cost,
}: {
  confidence?: Record<string, number>
  cost?: number
} = {}) {
  return {
    openrouter: {
      answers: Object.fromEntries(
        Object.entries(confidence).map(([key, value]) => [key, { confidence: value }]),
      ),
      ...(cost !== undefined && { usage: { cost } }),
    },
  }
}
