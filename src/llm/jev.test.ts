import { describe, expect, test } from 'bun:test'
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { isRateLimitError } from '../jobs/rate-limit'
import { fakeJevModel, openrouterMetadata, stateOf } from '../test/fake-jev'
import { env } from '../env'
import {
  DECISION_RATES,
  computeDecisionCost,
  decide,
  decideShadow,
  jevConfigFromEnv,
  type JevConfig,
} from './jev'

const config: JevConfig = {
  provider: 'openrouter',
  apiKey: 'test-key',
  model: 'cloudflare/clef',
}

const questions = {
  verdict: {
    type: 'choice',
    instructions: 'Classify',
    criteria: { legit: 'genuine', spam: 'junk' },
  },
  is_spam: { type: 'boolean', instructions: 'Is this spam?' },
  tone: {
    type: 'score',
    instructions: 'How pushy?',
    criteria: ['low', 'mid', 'high'],
  },
} as const

const rawAnswers = {
  verdict: {
    type: 'choice' as const,
    choice: 'spam',
    probabilities: { legit: 0.02, spam: 0.98 },
  },
  is_spam: { type: 'boolean' as const, probability: 0.96 },
  tone: {
    type: 'score' as const,
    score: 1,
    probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
  },
}

describe('decide', () => {
  test('passes state and questions to the model and returns typed answers', async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: rawAnswers,
      warnings: [],
      providerMetadata: openrouterMetadata({ confidence: { verdict: 0.97 } }),
    }))

    const { answers } = await decide({
      config,
      model,
      state: { subject: 'SEO audit' },
      subTool: 'decision-email',
      questions,
    })

    expect(calls).toHaveLength(1)
    expect(stateOf(calls[0]!)).toEqual({ subject: 'SEO audit' })
    expect(calls[0]!.questions).toEqual(questions)
    expect(calls[0]!.abortSignal).toBeInstanceOf(AbortSignal)

    // Types narrow by question type: choice → .choice, boolean → .probability.
    const choice: 'legit' | 'spam' = answers.verdict.choice
    expect(choice).toBe('spam')
    expect(answers.verdict.confidence).toBe(0.97)
    expect(answers.is_spam.probability).toBe(0.96)
    expect(answers.tone.score).toBe(1)
  })

  test('never retries at the SDK level — the durable job queue owns retries', async () => {
    const { model, calls } = fakeJevModel(() => {
      throw new Error('The upstream provider is currently experiencing high demand')
    })

    await expect(
      decide({
        config,
        model,
        state: { subject: 'x' },
        questions,
        subTool: 'decision-email',
      }),
    ).rejects.toThrow('high demand')

    // maxRetries: 0 means exactly one HTTP-equivalent attempt; a leftover
    // SDK-level retry would show up here as more than one call.
    expect(calls).toHaveLength(1)
  })

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
      }))

      const { answers } = await decide({
        config,
        model,
        state: 'x',
        subTool: 'decision-email',
        questions: { verdict: questions.verdict },
      })

      expect(answers.verdict.confidence).toBe(0.98)
    }
  })

  test('throws when a choice has neither confidence nor probabilities', async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: { type: 'choice', choice: 'spam' } },
      warnings: [],
    }))

    await expect(
      decide({
        config,
        model,
        state: 'x',
        subTool: 'decision-email',
        questions: { verdict: questions.verdict },
      }),
    ).rejects.toThrow('no confidence for "verdict"')
  })

  test('throws when Jev is not configured', async () => {
    const { model, calls } = fakeJevModel(() => ({
      answers: {},
      warnings: [],
    }))

    await expect(
      decide({
        config: null,
        model,
        state: 'x',
        questions,
        subTool: 'decision-email',
      }),
    ).rejects.toThrow('Jev not configured')
    expect(calls).toHaveLength(0)
  })

  test('propagates a model failure', async () => {
    const { model } = fakeJevModel(() => {
      throw new Error('gateway 529')
    })

    await expect(
      decide({
        config,
        model,
        state: 'x',
        subTool: 'decision-email',
        questions: { is_spam: questions.is_spam },
        // SDK retries transient failures; a plain Error is not retried.
      }),
    ).rejects.toThrow('gateway 529')
  })
})

describe('decide usage', () => {
  test('reads confidence and cost from providerMetadata.openrouter', async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: rawAnswers.verdict },
      warnings: [],
      usage: { inputTokens: 147, outputTokens: 3 },
      providerMetadata: openrouterMetadata({
        confidence: { verdict: 0.91 },
        cost: 0.00003528,
      }),
    }))

    const { answers, usage } = await decide({
      config,
      model,
      state: 'x',
      questions: { verdict: questions.verdict },
      subTool: 'decision-submission',
    })

    expect(answers.verdict.confidence).toBe(0.91)
    expect(usage).toEqual({
      inputTokens: 147,
      outputTokens: 3,
      costUsd: 0.00003528,
    })
  })

  test('a malformed cost or missing metadata leaves the cost null', async () => {
    for (const providerMetadata of [
      undefined,
      { openrouter: { usage: { cost: 'free' } } },
      { openrouter: { usage: { cost: -1 } } },
    ]) {
      const { model } = fakeJevModel(() => ({
        answers: { is_spam: rawAnswers.is_spam },
        warnings: [],
        providerMetadata,
      }))

      const { usage } = await decide({
        config,
        model,
        state: 'x',
        questions: { is_spam: questions.is_spam },
        subTool: 'decision-email',
      })

      expect(usage.costUsd).toBeNull()
    }
  })

  test('a failed call rethrows', async () => {
    const { model } = fakeJevModel(() => {
      throw new Error('openrouter 402')
    })

    await expect(
      decide({
        config,
        model,
        state: 'x',
        questions: { is_spam: questions.is_spam },
        subTool: 'decision-email',
      }),
    ).rejects.toThrow('402')
  })
})

describe('computeDecisionCost', () => {
  test('prices decision-1 and decision-1-eu per input token, others are null', () => {
    for (const model of ['decision-1', 'decision-1-eu']) {
      expect(computeDecisionCost(model, 1_000_000)).toBeCloseTo(0.042, 10)
    }
    expect(computeDecisionCost('decision-1-eu', 0)).toBe(0)
    expect(computeDecisionCost('decision-1-eu', 0, 1_000_000)).toBe(0)
    expect(computeDecisionCost('clef-eu', 1_000_000)).toBeNull()
  })

  test('prices pplx-decider-v1-27b at 0.04 USD per 1M input and output tokens', () => {
    expect(computeDecisionCost('pplx-decider-v1-27b', 391, 9)).toBeCloseTo(0.000016, 10)
  })
})

describe('decideShadow', () => {
  const shadowQuestions = { is_spam: questions.is_spam }
  const pick = ({ is_spam }: { is_spam: { probability: number } }) => ({
    spam: is_spam.probability,
  })

  test('returns null when disabled', () => {
    expect(
      decideShadow({
        state: 'x',
        subTool: 'decision-email' as const,
        questions: shadowQuestions,
        pick,
        config: null,
      }),
    ).toBeNull()
  })

  test('maps answers with latency and model on success, and rejects on failure', async () => {
    const ok = fakeJevModel(() => ({
      answers: { is_spam: rawAnswers.is_spam },
      warnings: [],
    }))
    const success = await decideShadow({
      state: 'x',
      subTool: 'decision-email' as const,
      questions: shadowQuestions,
      pick,
      config,
      model: ok.model,
    })!
    expect(success).toMatchObject({ spam: 0.96, model: 'cloudflare/clef' })
    expect(success.latencyMs).toBeGreaterThanOrEqual(0)

    const bad = fakeJevModel(() => {
      throw new Error('gateway 529')
    })
    await expect(
      decideShadow({
        state: 'x',
        subTool: 'decision-email' as const,
        questions: shadowQuestions,
        pick,
        config,
        model: bad.model,
      })!,
    ).rejects.toThrow('gateway 529')
  })
})

describe('jevConfigFromEnv', () => {
  const base = {
    DECISION_PROVIDER: 'ue' as const,
    DECISION_MODEL: 'decision-1-eu',
    DECISION_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
    LLM_BASE_URL: 'https://ue.example.com/openai/v1',
    LLM_API_KEY: 'ue-key',
  }

  test('ue needs LLM_BASE_URL and LLM_API_KEY', () => {
    expect(jevConfigFromEnv(base)).toEqual({
      provider: 'ue',
      apiKey: 'ue-key',
      baseUrl: 'https://ue.example.com/decisions/v1',
      model: 'decision-1-eu',
    })
    expect(jevConfigFromEnv({ ...base, LLM_API_KEY: undefined })).toBeNull()
    expect(jevConfigFromEnv({ ...base, LLM_BASE_URL: undefined })).toBeNull()
    // An OpenRouter key alone never enables the ue lane.
    expect(
      jevConfigFromEnv({
        ...base,
        LLM_API_KEY: undefined,
        OPENROUTER_API_KEY: 'or-key',
      }),
    ).toBeNull()
  })

  test('DECISION_BASE_URL overrides the derived decisions base', () => {
    expect(
      jevConfigFromEnv({
        ...base,
        DECISION_BASE_URL: 'https://decisions.example.com/decisions/v1',
      }),
    ).toMatchObject({ baseUrl: 'https://decisions.example.com/decisions/v1' })
    // The override alone is enough for the base URL; the key is still needed.
    expect(
      jevConfigFromEnv({
        ...base,
        LLM_BASE_URL: undefined,
        DECISION_BASE_URL: 'https://decisions.example.com/decisions/v1',
      }),
    ).toMatchObject({ baseUrl: 'https://decisions.example.com/decisions/v1' })
  })

  test('an unparseable LLM_BASE_URL disables the ue lane', () => {
    expect(jevConfigFromEnv({ ...base, LLM_BASE_URL: 'not a url' })).toBeNull()
  })

  test('openrouter needs OPENROUTER_API_KEY only', () => {
    const openrouter = {
      ...base,
      DECISION_PROVIDER: 'openrouter' as const,
      DECISION_MODEL: 'cloudflare/clef',
      OPENROUTER_API_KEY: 'or-key',
    }
    expect(jevConfigFromEnv(openrouter)).toEqual({
      provider: 'openrouter',
      apiKey: 'or-key',
      model: 'cloudflare/clef',
    })
    expect(jevConfigFromEnv({ ...openrouter, OPENROUTER_API_KEY: undefined })).toBeNull()
  })
})

describe('decide with the ue provider', () => {
  const ueConfig = (model: string): JevConfig => ({
    provider: 'ue',
    apiKey: 'k',
    baseUrl: 'https://ue.example.com/decisions/v1',
    model,
  })

  // The real TypeSafe provider over an injected fetch: the wire format, the
  // `typesafe` metadata key and the 429 mapping are the provider's, not ours.
  const typesafeModel = (
    model: string,
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  ) =>
    createTypeSafeAi({
      baseURL: 'https://ue.example.com/decisions/v1/',
      apiKey: 'secret-key',
      fetch: fetchImpl as typeof fetch,
    }).decisionModel(model)

  test('posts systemone with a Bearer key, reads typesafe confidence and computes the pplx cost', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const model = typesafeModel('pplx-decider-v1-27b', async (url, init) => {
      requests.push({ url, init })
      return Response.json({
        model: 'pplx-decider-v1-27b',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'spam',
            probabilities: { legit: 0.02, spam: 0.98 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 391, output_tokens: 0 },
      })
    })

    const { answers, usage } = await decide({
      config: ueConfig('pplx-decider-v1-27b'),
      model,
      state: { subject: 'SEO audit' },
      questions: { verdict: questions.verdict },
      subTool: 'decision-email',
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://ue.example.com/decisions/v1/systemone')
    const headers = new Headers(requests[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer secret-key')
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      model: 'pplx-decider-v1-27b',
      state: { subject: 'SEO audit' },
      questions: { verdict: questions.verdict },
    })

    expect(answers.verdict.choice).toBe('spam')
    expect(answers.verdict.confidence).toBe(0.9)
    expect(usage.costUsd).toBeCloseTo((391 * 0.04) / 1_000_000, 12)
  })

  test('a 429 surfaces as a rate-limit error after exactly one request', async () => {
    let requests = 0
    const model = typesafeModel('pplx-decider-v1-27b', async () => {
      requests += 1
      return new Response(JSON.stringify({ message: 'Too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    })

    const error = await decide({
      config: ueConfig('pplx-decider-v1-27b'),
      model,
      state: 'x',
      questions: { verdict: questions.verdict },
      subTool: 'decision-email',
    }).catch((caught: unknown) => caught)

    expect(requests).toBe(1)
    expect(isRateLimitError(error)).toBe(true)
  })

  test("an answer outside the question's options is rejected by the SDK", async () => {
    const model = typesafeModel('pplx-decider-v1-27b', async () =>
      Response.json({
        answers: {
          verdict: {
            type: 'choice',
            choice: 'marketing',
            probabilities: { marketing: 1 },
          },
        },
      }),
    )

    await expect(
      decide({
        config: ueConfig('pplx-decider-v1-27b'),
        model,
        state: 'x',
        questions: { verdict: questions.verdict },
        subTool: 'decision-email',
      }),
    ).rejects.toThrow('unknown option')
  })

  test('a boolean question round-trips as noul', async () => {
    const wire: { questions: Record<string, { type: string }> }[] = []
    const model = typesafeModel('pplx-decider-v1-27b', async (_url, init) => {
      wire.push(JSON.parse(init.body as string))
      return Response.json({
        answers: { is_spam: { type: 'noul', noul: 0.96 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    })

    const { answers } = await decide({
      config: ueConfig('pplx-decider-v1-27b'),
      model,
      state: 'x',
      questions: { is_spam: questions.is_spam },
      subTool: 'decision-email',
    })

    expect(wire[0]!.questions.is_spam!.type).toBe('noul')
    expect(answers.is_spam.probability).toBe(0.96)
  })

  test("a missing or null confidence falls back to the choice's probability", async () => {
    for (const confidence of [undefined, null]) {
      const model = typesafeModel('pplx-decider-v1-27b', async () =>
        Response.json({
          answers: {
            verdict: {
              type: 'choice',
              choice: 'spam',
              probabilities: { legit: 0.02, spam: 0.98 },
              ...(confidence !== undefined && { confidence }),
            },
          },
        }),
      )

      const { answers } = await decide({
        config: ueConfig('pplx-decider-v1-27b'),
        model,
        state: 'x',
        questions: { verdict: questions.verdict },
        subTool: 'decision-email',
      })

      expect(answers.verdict.confidence).toBe(0.98)
    }
  })

  test('a malformed provider response rejects', async () => {
    const model = typesafeModel('pplx-decider-v1-27b', async () =>
      Response.json({ model: 'pplx-decider-v1-27b' }),
    )

    await expect(
      decide({
        config: ueConfig('pplx-decider-v1-27b'),
        model,
        state: 'x',
        questions: { verdict: questions.verdict },
        subTool: 'decision-email',
      }),
    ).rejects.toThrow()
  })

  test('warns once, naming the model, when a ue model has no rate', async () => {
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args)
    try {
      const { model } = fakeJevModel(() => ({
        answers: { verdict: rawAnswers.verdict },
        warnings: [],
        usage: { inputTokens: 5, outputTokens: 1 },
      }))
      await decide({
        config: ueConfig('clef-eu'),
        model,
        state: 'x',
        questions: { verdict: questions.verdict },
        subTool: 'decision-email',
      })
    } finally {
      console.warn = original
    }

    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]![0])).toContain('clef-eu')
  })

  test('the default DECISION_MODEL has a cost rate', () => {
    expect(DECISION_RATES[env.DECISION_MODEL]).toBeDefined()
  })

  test('decision-1 reports no cost: computed at 0.042 USD per 1M input tokens', async () => {
    const { model } = fakeJevModel(() => ({
      answers: { verdict: rawAnswers.verdict },
      warnings: [],
      usage: { inputTokens: 1_000_000, outputTokens: 3 },
      providerMetadata: { typesafe: { confidence: { verdict: 0.9 } } },
    }))

    const { usage } = await decide({
      config: {
        provider: 'ue',
        apiKey: 'k',
        baseUrl: 'u',
        model: 'decision-1-eu',
      },
      model,
      state: 'x',
      questions: { verdict: questions.verdict },
      subTool: 'decision-email',
    })

    expect(usage.costUsd).toBeCloseTo(0.042, 10)
  })

  test('a failed ue call rethrows', async () => {
    const { model } = fakeJevModel(() => {
      throw new Error('boom')
    })

    await expect(
      decide({
        config: { provider: 'ue', apiKey: 'k', baseUrl: 'u', model: 'clef-eu' },
        model,
        state: 'x',
        questions: { is_spam: questions.is_spam },
        subTool: 'decision-email',
      }),
    ).rejects.toThrow('boom')
  })
})
