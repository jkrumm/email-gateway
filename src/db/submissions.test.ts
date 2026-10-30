import { describe, expect, test } from 'bun:test'
import { openDatabase } from './client'
import { createSubmissionsRepo, type JevSubmissionResult } from './submissions'

const jev: JevSubmissionResult = {
  verdict: 'spam',
  confidence: 0.9,
  probabilities: { legit: 0.05, spam: 0.9, marketing: 0.05 },
  latencyMs: 800,
  model: 'jev-test',
}

const base = {
  source: 'fpp' as const,
  verdict: 'legit' as const,
  confidence: 0.9,
  reason: 'r',
  model: 'm',
  delivered: true,
  submission: {},
}

function repo() {
  return createSubmissionsRepo(openDatabase(':memory:'))
}

describe('submissions Jev queue', () => {
  test('recordSubmission queues the row only when Jev is pending, and stores LLM latency', () => {
    const submissions = repo()
    submissions.recordSubmission({
      ...base,
      llmLatencyMs: 1500,
      jevPending: true,
    })
    submissions.recordSubmission({ ...base, verdict: 'spam' })

    const rows = submissions.listSubmissions().data
    const queued = rows.find((row) => row.verdict === 'legit')
    const unqueued = rows.find((row) => row.verdict === 'spam')
    expect(queued?.llmLatencyMs).toBe(1500)
    expect(queued?.jev).toEqual({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      verdict: null,
      confidence: null,
      probabilities: null,
      latencyMs: null,
      model: null,
      error: null,
    })
    expect(unqueued?.jev).toBeNull()
  })

  test('claimNextJev returns the stored payload once and completeJev stores the verdict', () => {
    const submissions = repo()
    const { id } = submissions.recordSubmission({
      ...base,
      submission: { message: 'hi', n: 2 },
      jevPending: true,
    })

    const claim = submissions.claimNextJev()!
    expect(claim).toMatchObject({
      id,
      source: 'fpp',
      submission: '{"message":"hi","n":2}',
    })
    expect(submissions.claimNextJev()).toBeNull()

    submissions.completeJev({ id, claimToken: claim.claimToken, result: jev })

    expect(submissions.listSubmissions().data[0]?.jev).toEqual({
      ...jev,
      status: 'done',
      attempts: 1,
      nextAttemptAt: null,
      error: null,
    })
  })

  test('getJevComparison counts only done rows', () => {
    const submissions = repo()
    const complete = (result = jev) =>
      submissions.completeJev({ ...submissions.claimNextJev()!, result })

    submissions.recordSubmission({
      ...base,
      llmLatencyMs: 1000,
      jevPending: true,
    })
    complete()
    submissions.recordSubmission({
      ...base,
      verdict: 'spam',
      llmLatencyMs: 3000,
      jevPending: true,
    })
    complete({ ...jev, latencyMs: 200 })
    submissions.recordSubmission({
      ...base,
      llmLatencyMs: 5000,
      jevPending: true,
    })
    submissions.failJev({ ...submissions.claimNextJev()!, error: 'x' })
    submissions.recordSubmission({ ...base, jevPending: true })
    submissions.recordSubmission(base)

    expect(submissions.getJevComparison({ since: '2000-01-01T00:00:00.000Z' })).toEqual({
      compared: 2,
      agreed: 1,
      agreementRate: 0.5,
      llmMedianLatencyMs: 2000,
      jevMedianLatencyMs: 500,
    })
    expect(submissions.jevQueueCounts()).toEqual({ pending: 2, failed: 0 })
  })

  test('getJevComparison is empty-safe', () => {
    expect(repo().getJevComparison({ since: '2000-01-01T00:00:00.000Z' })).toEqual({
      compared: 0,
      agreed: 0,
      agreementRate: null,
      llmMedianLatencyMs: null,
      jevMedianLatencyMs: null,
    })
  })
})
