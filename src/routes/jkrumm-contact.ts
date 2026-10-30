import { Elysia, t } from 'elysia'
import { env } from '../env'
import JkrummContactReceiverMail from '../emails/jkrumm/contact-receiver-mail'
import { TEMPLATE_IDS } from '../emails/registry'
import { gateSubmission } from '../spam/gate'
import { splitCsv } from '../utils/csv'
import { sendMail } from '../utils/send-mail'

const PATH = '/jkrumm-contact'

const jkrummContactBody = t.Object({
  name: t.Nullable(t.String({ maxLength: 200 })),
  email: t.String({ format: 'email', maxLength: 320 }),
  message: t.String({ minLength: 1, maxLength: 5000 }),
  // Honeypot: a real visitor never fills it.
  website: t.Optional(t.String()),
})

// The name is untrusted free text on an unauthenticated route: drop anything
// that could break out of the display-name part of the header.
function replyToFor(name: string | null, email: string): string {
  const display = name?.replace(/[\r\n<>",;]/g, ' ').trim()
  return display ? `${display} <${email}>` : email
}

export interface JkrummContactDeps {
  // Allowed browser Origins; empty/undefined -> the route 404s.
  origins?: string[]
  gate?: typeof gateSubmission
  send?: typeof sendMail
  receiverEmail?: string
  fromEmail?: string
}

// The one send route with no bearer: the personal site is static, so it
// cannot hold SECRET_KEY. Its protections are the Origin allow-list, the
// honeypot, the spam gate and Traefik's rate limit. The Origin header is
// browser-enforced, not a secret — it stops other sites' visitors, not curl.
export function createJkrummContactRoutes({
  origins = splitCsv(env.JKRUMM_CONTACT_ORIGINS) ?? [],
  gate = gateSubmission,
  send = sendMail,
  receiverEmail = env.JKRUMM_CONTACT_RECEIVER_EMAIL ?? env.RECEIVER_EMAIL,
  fromEmail = env.JKRUMM_CONTACT_FROM_EMAIL,
}: JkrummContactDeps = {}) {
  const allowed = new Set(origins)
  const corsHeaders = (origin: string) => ({
    'access-control-allow-origin': origin,
    vary: 'Origin',
  })

  // onRequest runs before body validation, so a bad Origin is a 403 even with
  // an invalid body, and every response (422 included) carries the CORS
  // headers a browser needs to read it.
  return new Elysia()
    .onRequest(({ request, set }) => {
      if (new URL(request.url).pathname.replace(/\/+$/, '') !== PATH) return
      if (request.method !== 'POST' && request.method !== 'OPTIONS') return
      if (allowed.size === 0) return new Response('Not Found', { status: 404 })

      const origin = request.headers.get('origin')
      if (!origin || !allowed.has(origin)) {
        return new Response('Forbidden', { status: 403 })
      }

      Object.assign(set.headers, corsHeaders(origin))
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(origin),
            'access-control-allow-methods': 'POST',
            'access-control-allow-headers': 'Content-Type',
            'access-control-max-age': '86400',
          },
        })
      }
    })
    .post(
      PATH,
      async ({ body }) => {
        const response = { message: 'Message sent successfully' }
        if (body.website) return response

        const submission = {
          name: body.name,
          email: body.email,
          message: body.message,
        }
        await gate({
          source: 'jkrumm-contact',
          submission,
          deliver: async ({ subjectPrefix }) => {
            await send({
              to: receiverEmail,
              from: fromEmail,
              replyTo: replyToFor(body.name, body.email),
              subject: `${subjectPrefix}jkrumm.com – Contact message`,
              template: JkrummContactReceiverMail(submission),
              source: TEMPLATE_IDS.jkrummContactReceiver,
            })
          },
        })

        return response
      },
      { body: jkrummContactBody },
    )
}

export const jkrummContactRoutes = createJkrummContactRoutes()
