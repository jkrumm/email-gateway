import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createApp } from '../app'
import { openMailDatabase } from '../db/mail-client'
import { createMailSubmissionsRepo, type InsertSubmissionInput } from '../db/mail-submissions'
import { createSySerendipityRequestsRoutes } from './sy-serendipity-requests'

const READ_KEY = 'read-key-0123456789-0123456789-0123'
const API_KEY = 'test-api-key-1234567890'

function setup(readKey: string | null = READ_KEY) {
  const db = openMailDatabase(':memory:')
  const submissions = createMailSubmissionsRepo(db)
  const app = new Elysia().use(
    createSySerendipityRequestsRoutes({
      readKey: readKey ?? undefined,
      submissions,
    }),
  )

  // insertSubmission stamps "now"; pin received_at so ordering and `since`
  // are deterministic.
  function seed(receivedAt: string, overrides: Partial<InsertSubmissionInput> = {}) {
    const record = submissions.insertSubmission({
      source: 'sy-serendipity',
      verdict: 'legit',
      confidence: 0.9,
      reason: 'secret llm reason',
      model: 'secret-model',
      delivered: true,
      submission: { email: 'guest@example.com', firstName: 'Ada' },
      ...overrides,
    })
    db.run('UPDATE submissions SET received_at = ? WHERE id = ?', [receivedAt, record.id])
    return record
  }

  function get(path = '', token: string | null = READ_KEY) {
    return app.handle(
      new Request(`http://localhost/sy-serendipity/requests${path}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
    )
  }

  return { app, submissions, seed, get }
}

describe('GET /sy-serendipity/requests auth', () => {
  test('missing token is 401 { message: Unauthorized }', async () => {
    const response = await setup().get('', null)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Unauthorized' })
  })

  test('wrong token is 401', async () => {
    const response = await setup().get('', 'wrong-token')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Unauthorized' })
  })

  test('SECRET_KEY and API_KEY values are rejected', async () => {
    const { get } = setup()

    expect((await get('', process.env.SECRET_KEY!)).status).toBe(401)
    expect((await get('', API_KEY)).status).toBe(401)
  })

  test('a non-Bearer scheme is 401', async () => {
    const response = await setup().app.handle(
      new Request('http://localhost/sy-serendipity/requests', {
        headers: { authorization: `Basic ${READ_KEY}` },
      }),
    )

    expect(response.status).toBe(401)
  })

  test('unset key 404s the route, even with a token', async () => {
    const response = await setup(null).get()

    expect(response.status).toBe(404)
  })
})

describe('GET /sy-serendipity/requests data', () => {
  test('returns only sy-serendipity rows, newest first, with all verdicts', async () => {
    const { seed, get } = setup()
    seed('2026-10-01T10:00:00.000Z')
    seed('2026-10-03T10:00:00.000Z', { verdict: 'spam', delivered: false })
    seed('2026-10-02T10:00:00.000Z', { source: 'fpp' })
    seed('2026-10-02T09:00:00.000Z', { verdict: 'marketing' })

    const response = await get()
    const body = (await response.json()) as {
      requests: { receivedAt: string; verdict: string; delivered: boolean }[]
      total: number
    }

    expect(response.status).toBe(200)
    expect(body.total).toBe(3)
    expect(body.requests.map((r) => [r.receivedAt, r.verdict, r.delivered])).toEqual([
      ['2026-10-03T10:00:00.000Z', 'spam', false],
      ['2026-10-02T09:00:00.000Z', 'marketing', true],
      ['2026-10-01T10:00:00.000Z', 'legit', true],
    ])
  })

  test('projects the form fields and leaks no classifier or jev data', async () => {
    const { seed, submissions, get } = setup()
    const record = seed('2026-10-01T10:00:00.000Z', {
      submission: {
        firstName: 'Ada',
        lastName: null,
        email: 'ada@example.com',
        numberOfPeople: '4',
        message: 'Hello',
      },
    })
    submissions.saveJevResult(record.id, {
      verdict: 'legit',
      confidence: 0.99,
      probabilities: { legit: 0.99 },
      latencyMs: 10,
      model: 'jev-secret-model',
    })

    const text = await (await get()).text()

    expect(JSON.parse(text).requests[0]).toEqual({
      id: record.id,
      receivedAt: '2026-10-01T10:00:00.000Z',
      verdict: 'legit',
      delivered: true,
      firstName: 'Ada',
      lastName: null,
      email: 'ada@example.com',
      phone: null,
      numberOfPeople: '4',
      destination: null,
      duration: null,
      arrivalDate: null,
      departureDate: null,
      message: 'Hello',
    })
    expect(text).not.toContain('secret')
    expect(text).not.toContain('jev')
  })

  test('since is inclusive and accepts offsets; total counts the window', async () => {
    const { seed, get } = setup()
    seed('2026-10-01T10:00:00.000Z')
    seed('2026-10-02T10:00:00.000Z')
    seed('2026-10-03T10:00:00.000Z')

    const body = (await (
      await get(`?since=${encodeURIComponent('2026-10-02T12:00:00+02:00')}`)
    ).json()) as { requests: { receivedAt: string }[]; total: number }

    expect(body.total).toBe(2)
    expect(body.requests.map((r) => r.receivedAt)).toEqual([
      '2026-10-03T10:00:00.000Z',
      '2026-10-02T10:00:00.000Z',
    ])
  })

  test('limit caps the rows but total stays the full count', async () => {
    const { seed, get } = setup()
    seed('2026-10-01T10:00:00.000Z')
    seed('2026-10-02T10:00:00.000Z')
    seed('2026-10-03T10:00:00.000Z')

    const body = (await (await get('?limit=2')).json()) as {
      requests: { receivedAt: string }[]
      total: number
    }

    expect(body.total).toBe(3)
    expect(body.requests.map((r) => r.receivedAt)).toEqual([
      '2026-10-03T10:00:00.000Z',
      '2026-10-02T10:00:00.000Z',
    ])
  })

  test('limit defaults to 100', async () => {
    const { seed, get } = setup()
    for (let i = 0; i < 101; i++) {
      seed(new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())
    }

    const body = (await (await get()).json()) as {
      requests: unknown[]
      total: number
    }

    expect(body.requests).toHaveLength(100)
    expect(body.total).toBe(101)
  })

  test('invalid limit or since is 422', async () => {
    const { get } = setup()

    expect((await get('?limit=0')).status).toBe(422)
    expect((await get('?limit=201')).status).toBe(422)
    expect((await get('?since=yesterday')).status).toBe(422)
  })
})

describe('mounted in createApp', () => {
  test('is not behind the MAIL_HOST gate and ignores SECRET_KEY', async () => {
    const app = createApp({ mailHost: 'mail.test' })
    const request = (token: string) =>
      app.handle(
        new Request('http://other.test/sy-serendipity/requests', {
          headers: { host: 'other.test', authorization: `Bearer ${token}` },
        }),
      )

    expect((await request(process.env.SECRET_KEY!)).status).toBe(401)
    expect((await request(process.env.SY_SERENDIPITY_READ_KEY!)).status).toBe(200)
  })

  test('the read key does not open the send route', async () => {
    const response = await createApp().handle(
      new Request('http://localhost/sy-serendipity', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.SY_SERENDIPITY_READ_KEY}`,
        },
        body: JSON.stringify({
          firstName: null,
          lastName: null,
          email: 'guest@example.com',
          numberOfPeople: null,
          destination: null,
          duration: null,
          arrivalDate: null,
          departureDate: null,
          phone: null,
          message: null,
        }),
      }),
    )

    expect(response.status).toBe(400)
  })
})
