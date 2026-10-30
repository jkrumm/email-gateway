import { describe, expect, test } from 'bun:test'
import { Elysia, status } from 'elysia'
import { createApp } from '../app'
import { httpTelemetry } from './http'
import { _test, type SpanRecord } from './otel'

const attr = (span: SpanRecord, key: string) => span.attributes.find((a) => a.key === key)?.value

function testApp() {
  const sub = new Elysia({ prefix: '/sub' }).get('/items/:id', ({ params }) => ({ id: params.id }))
  return new Elysia()
    .use(httpTelemetry())
    .get('/health', () => ({ ok: true }))
    .use(sub)
    .get('/bad-request', ({ set }) => {
      set.status = 400
      return { message: 'nope' }
    })
    .get('/forbidden', () => status(403, { message: 'no' }))
    .get('/thrown-forbidden', () => {
      throw status(403, { message: 'no' })
    })
    .get('/unavailable', () => status(503, { message: 'down' }))
    .get('/boom', () => {
      throw new Error('db exploded for guest@example.com')
    })
}

// Elysia runs onAfterResponse after the response has been handed back.
const settle = () => Bun.sleep(5)

async function spansFor(path: string, init?: RequestInit) {
  const capture = _test.capture()
  const response = await testApp().handle(new Request(`http://localhost${path}`, init))
  await settle()
  capture.stop()
  return { response, spans: capture.spans }
}

describe('httpTelemetry', () => {
  test('one server span per request with method, route pattern and status', async () => {
    const { response, spans } = await spansFor('/sub/items/4711?token=secret')

    expect(response.status).toBe(200)
    expect(spans).toHaveLength(1)
    const [span] = spans
    expect(span!.kind).toBe(2)
    expect(span!.name).toBe('GET /sub/items/:id')
    expect(attr(span!, 'http.request.method')).toEqual({ stringValue: 'GET' })
    expect(attr(span!, 'http.route')).toEqual({
      stringValue: '/sub/items/:id',
    })
    expect(attr(span!, 'http.response.status_code')).toEqual({
      intValue: '200',
    })
    expect(span!.status.code).toBe(0)
  })

  test('never records the raw URL, query string or headers', async () => {
    const { spans } = await spansFor('/sub/items/4711?token=secret', {
      headers: { authorization: 'Bearer hunter2', cookie: 'session=abc' },
    })

    const json = JSON.stringify(spans)
    expect(json).not.toContain('4711')
    expect(json).not.toContain('secret')
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('session=abc')
  })

  test('5xx from a thrown error -> error status with the exception, scrubbed', async () => {
    const { response, spans } = await spansFor('/boom')

    expect(response.status).toBe(500)
    const [span] = spans
    expect(span!.status.code).toBe(2)
    expect(attr(span!, 'http.response.status_code')).toEqual({
      intValue: '500',
    })
    expect(span!.events?.[0]?.name).toBe('exception')
    expect(JSON.stringify(spans)).not.toContain('guest@example.com')
  })

  test('a returned 5xx status -> error status', async () => {
    const { response, spans } = await spansFor('/unavailable')

    expect(response.status).toBe(503)
    expect(spans[0]!.status.code).toBe(2)
    expect(attr(spans[0]!, 'http.response.status_code')).toEqual({
      intValue: '503',
    })
  })

  test('4xx stays unset, whether set on the context or returned', async () => {
    for (const [path, code] of [
      ['/bad-request', 400],
      ['/forbidden', 403],
      ['/thrown-forbidden', 403],
    ] as const) {
      const { response, spans } = await spansFor(path)
      expect(response.status).toBe(code)
      expect(spans[0]!.status.code).toBe(0)
      expect(attr(spans[0]!, 'http.response.status_code')).toEqual({
        intValue: String(code),
      })
    }
  })

  test('an unmatched path is a 404 span without a route attribute', async () => {
    const { response, spans } = await spansFor('/wp-login.php')

    expect(response.status).toBe(404)
    expect(spans[0]!.name).toBe('GET')
    expect(attr(spans[0]!, 'http.route')).toBeUndefined()
    expect(spans[0]!.status.code).toBe(0)
    expect(JSON.stringify(spans)).not.toContain('wp-login')
  })

  test('/health records no span', async () => {
    const { response, spans } = await spansFor('/health')

    expect(response.status).toBe(200)
    expect(spans).toEqual([])
  })

  test("the real app's hooks also cover mounted plugins and skip /health", async () => {
    const capture = _test.capture()
    const app = createApp()
    await app.handle(new Request('http://localhost/health'))
    await app.handle(new Request('http://localhost/sy-serendipity/requests'))
    await settle()
    capture.stop()

    expect(capture.spans.map((s) => s.name)).toEqual(['GET /sy-serendipity/requests'])
  })
})
