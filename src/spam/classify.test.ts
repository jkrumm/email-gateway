import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { classifySubmission, shouldSuppress } from './classify'

function mockUsage() {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function mockModelReturning(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: mockUsage(),
      warnings: [],
    }),
  })
}

function mockModelThrowing(message: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(message)
    },
  })
}

function userPromptText(model: MockLanguageModelV4): string {
  const call = model.doGenerateCalls[0] as LanguageModelV4CallOptions
  const userMessage = call.prompt.find((message) => message.role === 'user')
  if (!userMessage || typeof userMessage.content === 'string') {
    throw new Error('Expected a user message with structured content')
  }
  const textPart = userMessage.content.find((part) => part.type === 'text')
  if (!textPart || textPart.type !== 'text') {
    throw new Error('Expected a text part in the user message')
  }
  return textPart.text
}

describe('classifySubmission', () => {
  test('returns legit with confidence 0 when the classifier is not configured', async () => {
    const result = await classifySubmission({
      source: 'fpp',
      submission: { email: 'user@example.com', message: 'Found a bug' },
    })

    expect(result).toEqual({
      verdict: 'legit',
      confidence: 0,
      reason: 'Classifier not configured',
      model: null,
    })
  })

  test('parses a marketing verdict from the model', async () => {
    const model = mockModelReturning(
      JSON.stringify({
        verdict: 'marketing',
        confidence: 0.9,
        reason: 'Unsolicited SEO pitch',
      }),
    )

    const result = await classifySubmission({
      source: 'fpp',
      submission: {
        email: 'seo@agency.example',
        message: 'We noticed your website...',
      },
      model,
    })

    expect(result.verdict).toBe('marketing')
    expect(result.confidence).toBe(0.9)
    expect(result.reason).toBe('Unsolicited SEO pitch')
    expect(result.model).toBe(model.modelId)
  })

  test('includes the submission JSON inside the delimiters in the user prompt', async () => {
    const model = mockModelReturning(
      JSON.stringify({
        verdict: 'legit',
        confidence: 0.8,
        reason: 'Genuine enquiry',
      }),
    )

    await classifySubmission({
      source: 'sy-serendipity',
      submission: {
        email: 'guest@example.com',
        message: 'Terse charter request',
      },
      model,
    })

    const prompt = userPromptText(model)
    expect(prompt).toContain('<submission>')
    expect(prompt).toContain('</submission>')
    expect(prompt).toContain(
      JSON.stringify({
        email: 'guest@example.com',
        message: 'Terse charter request',
      }),
    )
  })

  test('fails open to legit when the model call throws', async () => {
    const model = mockModelThrowing('connection refused')

    const result = await classifySubmission({
      source: 'fpp',
      submission: { email: 'user@example.com', message: 'Hi' },
      model,
    })

    expect(result.verdict).toBe('legit')
    expect(result.confidence).toBe(0)
    expect(result.reason).toBe('Classifier failed: connection refused')
    expect(result.model).toBeNull()
  })

  test('fails open to legit when the model returns schema-invalid JSON', async () => {
    const model = mockModelReturning(
      JSON.stringify({
        verdict: 'spam',
        confidence: 5,
        reason: 'Out of range confidence',
      }),
    )

    const result = await classifySubmission({
      source: 'fpp',
      submission: { email: 'user@example.com', message: 'Hi' },
      model,
    })

    expect(result.verdict).toBe('legit')
    expect(result.confidence).toBe(0)
    expect(result.reason).toStartWith('Classifier failed: ')
    expect(result.model).toBeNull()
  })
})

describe('shouldSuppress', () => {
  test('suppresses a high-confidence non-legit verdict', () => {
    expect(shouldSuppress({ verdict: 'marketing', confidence: 0.9 })).toBe(true)
  })

  test('does not suppress a low-confidence non-legit verdict', () => {
    expect(shouldSuppress({ verdict: 'marketing', confidence: 0.5 })).toBe(false)
  })

  test('never suppresses a legit verdict', () => {
    expect(shouldSuppress({ verdict: 'legit', confidence: 0.99 })).toBe(false)
  })
})
