import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createSendBodiesRepo } from '../db/send-bodies'
import { openMailDatabase } from '../db/mail-client'
import { createSesSendProvider } from '../providers/ses/send'
import { createShutterflowRoutes } from '../routes/shutterflow'
import { sendMail } from '../utils/send-mail'
import { httpTelemetry } from './http'
import { _test } from './otel'

const CODE = '482913'
const ADDRESS = 'guest@example.com'

// The full path a Shutterflow auth code travels: HTTP span -> route -> sendMail -> SES
// provider span, with the real SES provider over a fake SES client.
async function postCode({ sesFails }: { sesFails: boolean }) {
  const client = {
    send: async () => {
      if (sesFails) {
        // A provider error that (worst case) echoes the mail it rejected.
        throw new Error(`rejected "${CODE} is your code" for ${ADDRESS}`)
      }
      return { MessageId: 'ses-msg-1' }
    },
  }
  const provider = createSesSendProvider({
    client: client as never,
    configurationSetName: 'events',
  })
  const sendBodies = createSendBodiesRepo(openMailDatabase(':memory:'))
  const key = process.env.SHUTTERFLOW_SECRET_KEY ?? ''
  const app = new Elysia().use(httpTelemetry()).use(
    createShutterflowRoutes({
      secretKey: key,
      send: (input) =>
        sendMail({
          ...input,
          provider,
          sendLog: { insertSendLog: () => {} },
          sendBodies,
        }),
    }),
  )

  const capture = _test.capture()
  const response = await app.handle(
    new Request('http://localhost/shutterflow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        kind: 'sign-in',
        to: ADDRESS,
        code: CODE,
        expiresInMinutes: 10,
      }),
    }),
  )
  await Bun.sleep(5)
  capture.stop()
  return { response, capture }
}

describe('a shutterflow-code send in telemetry', () => {
  test('success: spans and events exist, the code and address appear nowhere', async () => {
    const { response, capture } = await postCode({ sesFails: false })

    expect(response.status).toBe(200)
    expect(capture.spans.map((s) => s.name).sort()).toEqual(['POST /shutterflow', 'ses.send'])
    const ses = capture.spans.find((s) => s.name === 'ses.send')!
    expect(ses.attributes).toContainEqual({
      key: 'email.template',
      value: { stringValue: 'shutterflow-code' },
    })
    expect(ses.attributes).toContainEqual({
      key: 'email.source',
      value: { stringValue: 'route' },
    })
    expect(ses.attributes).toContainEqual({
      key: 'outcome',
      value: { stringValue: 'ok' },
    })
    // Same trace: the SES span is a child of the request's span.
    const http = capture.spans.find((s) => s.name === 'POST /shutterflow')!
    expect(ses.parentSpanId).toBe(http.spanId)

    const result = capture.logs.find((l) => l.body.stringValue === 'send.result')
    expect(result?.attributes).toContainEqual({
      key: 'status',
      value: { stringValue: 'sent' },
    })

    const everything = JSON.stringify([capture.spans, capture.logs])
    expect(everything).not.toContain(CODE)
    expect(everything).not.toContain(ADDRESS)
    expect(everything).not.toContain('ses-msg-1')
  })

  test('failure: a provider error echoing the mail leaks nothing; 502 is an error span', async () => {
    const { response, capture } = await postCode({ sesFails: true })

    expect(response.status).toBe(502)
    const ses = capture.spans.find((s) => s.name === 'ses.send')!
    expect(ses.status).toEqual({ code: 2, message: 'Error' })
    expect(ses.events).toBeUndefined()
    const http = capture.spans.find((s) => s.name === 'POST /shutterflow')!
    expect(http.status.code).toBe(2)
    const result = capture.logs.find((l) => l.body.stringValue === 'send.result')
    expect(result?.attributes).toContainEqual({
      key: 'status',
      value: { stringValue: 'failed' },
    })
    expect(result?.severityText).toBe('WARN')

    const everything = JSON.stringify([capture.spans, capture.logs])
    expect(everything).not.toContain(CODE)
    expect(everything).not.toContain(ADDRESS)
  })
})
