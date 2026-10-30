import { describe, expect, test } from 'bun:test'
import { createLogger } from './log'
import { _test, withSpan } from './otel'

function setup() {
  const out: { level: string; args: unknown[] }[] = []
  const capture = _test.capture()
  const logger = createLogger({
    sinks: {
      log: (...args) => out.push({ level: 'log', args }),
      warn: (...args) => out.push({ level: 'warn', args }),
      error: (...args) => out.push({ level: 'error', args }),
    },
  })
  return { out, capture, logger }
}

describe('createLogger', () => {
  test('stdout gets exactly the arguments the console call had', () => {
    const { out, capture, logger } = setup()
    const meta = { error: new Error('x') }
    logger.info('one')
    logger.warn('two', meta)
    logger.error('three', [1, 2])
    capture.stop()

    expect(out).toEqual([
      { level: 'log', args: ['one'] },
      { level: 'warn', args: ['two', meta] },
      { level: 'error', args: ['three', [1, 2]] },
    ])
  })

  test("each line also ships one OTLP record with the console method's severity", () => {
    const { capture, logger } = setup()
    logger.info('a', { n: 1 })
    logger.warn('b')
    logger.error('c', new Error('boom'))
    capture.stop()

    expect(capture.logs.map((r) => [r.body.stringValue, r.severityText])).toEqual([
      ['a', 'INFO'],
      ['b', 'WARN'],
      ['c', 'ERROR'],
    ])
    expect(capture.logs[0]?.attributes).toContainEqual({
      key: 'n',
      value: { intValue: '1' },
    })
    expect(capture.logs[2]?.attributes).toContainEqual({
      key: 'error',
      value: { stringValue: 'Error: boom' },
    })
  })

  test('a non-object meta (an array) is kept under `meta`', () => {
    const { capture, logger } = setup()
    logger.error('tick', ['INBOX: failed'])
    capture.stop()

    expect(capture.logs[0]?.attributes).toContainEqual({
      key: 'meta',
      value: { stringValue: '["INBOX: failed"]' },
    })
  })

  test('event ships an OTLP record only — no stdout line', () => {
    const { out, capture, logger } = setup()
    logger.event('send.result', { template: 'fpp-sender', status: 'sent' })
    capture.stop()

    expect(out).toEqual([])
    expect(capture.logs[0]?.body.stringValue).toBe('send.result')
    expect(capture.logs[0]?.severityText).toBe('INFO')
  })

  test('records inside a span carry its trace and span id', async () => {
    const { capture, logger } = setup()
    let spanId = ''
    await withSpan('job', {}, async (span) => {
      spanId = span.spanId
      logger.info('inside')
      logger.event('e')
    })
    capture.stop()

    expect(capture.logs.map((r) => r.spanId)).toEqual([spanId, spanId])
  })

  test('addresses and sensitive fields never reach the OTLP copy, but stdout is untouched', () => {
    const { out, capture, logger } = setup()
    logger.error('Email sent failed', {
      to: 'guest@example.com',
      subject: '[redacted]',
      reason: 'no route to guest@example.com',
    })
    capture.stop()

    expect(JSON.stringify(out)).toContain('guest@example.com')
    expect(JSON.stringify(capture.logs)).not.toContain('guest@example.com')
  })
})
