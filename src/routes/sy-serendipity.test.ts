import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createSySerendipityRoutes } from './sy-serendipity'
import { TEMPLATE_IDS } from '../emails/registry'
import type { gateSubmission } from '../spam/gate'
import type { sendMail } from '../utils/send-mail'

type Sent = Parameters<typeof sendMail>[0]

const body = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  numberOfPeople: null,
  destination: null,
  duration: null,
  arrivalDate: null,
  departureDate: null,
  phone: null,
  message: 'Hello',
}

function setup({ deliver = true, failSend }: { deliver?: boolean; failSend?: string } = {}) {
  const sent: Sent[] = []
  const gate = (async ({ deliver: run }) => {
    if (deliver) await run({ subjectPrefix: '' })
    return { delivered: deliver }
  }) as typeof gateSubmission
  const send = (async (input: Sent) => {
    if (input.source === failSend) throw new Error('sandbox rejected')
    sent.push(input)
    return { id: 'm', from: 'f' }
  }) as typeof sendMail
  const app = new Elysia().use(createSySerendipityRoutes({ gate, send }))
  const post = () =>
    app.handle(
      new Request('http://localhost/sy-serendipity', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.SECRET_KEY}`,
        },
        body: JSON.stringify(body),
      }),
    )
  return { sent, post }
}

describe('POST /sy-serendipity', () => {
  test("sends the receiver mail, then the requester's confirmation", async () => {
    const { sent, post } = setup()
    const response = await post()

    expect(response.status).toBe(200)
    expect(sent.map((mail) => [mail.source, mail.to])).toEqual([
      [TEMPLATE_IDS.sySerendipityRequest, 'sy-receiver@example.com'],
      [TEMPLATE_IDS.sySerendipityConfirmation, 'jane@example.com'],
    ])
  })

  test('sends no confirmation for a submission the gate held', async () => {
    const { sent, post } = setup({ deliver: false })
    const response = await post()

    expect(response.status).toBe(200)
    expect(sent).toEqual([])
  })

  test('a failing confirmation never fails the request', async () => {
    const { sent, post } = setup({
      failSend: TEMPLATE_IDS.sySerendipityConfirmation,
    })
    const response = await post()

    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
  })
})
