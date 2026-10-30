import { Elysia, t } from 'elysia'
import { extractBearerToken, timingSafeEqualStrings } from '../auth'
import { env } from '../env'
import AthenaCodeMail, { ATHENA_CODE_KINDS, athenaCodeSubject } from '../emails/athena/code-mail'
import { TEMPLATE_IDS } from '../emails/registry'
import { sendMail } from '../utils/send-mail'
import { log } from '../telemetry/log'

const athenaBody = t.Object({
  kind: t.Union(ATHENA_CODE_KINDS.map((kind) => t.Literal(kind))),
  // One address (a list or a display name fails the email format); the IU-only
  // rule is checked in the handler, case-insensitively.
  to: t.String({ format: 'email', maxLength: 320 }),
  code: t.String({ pattern: '^\\d{6}$' }),
  expiresInMinutes: t.Integer({ minimum: 1, maximum: 15 }),
})

// Athena only mails IU staff, so a leaked key cannot reach anyone else.
const RECIPIENT_DOMAIN = '@iu.org'

// Same shape as /shutterflow: own guard on a fresh instance, so SECRET_KEY
// opens nothing here; unset key -> 404; no spam gate (a person is waiting for
// the code); synchronous send, a provider error is a 502 so Athena can offer a
// retry. The code never reaches a log or send_log (`sensitiveSubject`), and the
// stored copy of the mail has it replaced by `[redacted]`.
export function createAthenaRoutes({
  secretKey,
  fromEmail,
  replyTo,
  send = sendMail,
}: {
  secretKey: string | undefined
  fromEmail?: string | undefined
  replyTo?: string | undefined
  send?: typeof sendMail
}) {
  return new Elysia()
    .onBeforeHandle(({ headers, set }) => {
      if (secretKey === undefined) {
        set.status = 404
        return { message: 'Not Found' }
      }

      const token = extractBearerToken(headers.authorization)
      if (token && timingSafeEqualStrings(token, secretKey)) return

      set.status = 401
      set.headers['WWW-Authenticate'] = `Bearer realm='athena', error="invalid_token"`
      return { message: 'Unauthorized' }
    })
    .post(
      '/athena',
      async ({ body, set }) => {
        if (!body.to.toLowerCase().endsWith(RECIPIENT_DOMAIN)) {
          set.status = 422
          return { message: 'Recipient not allowed' }
        }
        try {
          const props = {
            kind: body.kind,
            code: body.code,
            expiresInMinutes: body.expiresInMinutes,
          }
          await send({
            to: body.to,
            ...(fromEmail ? { from: fromEmail } : {}),
            ...(replyTo ? { replyTo } : {}),
            subject: athenaCodeSubject(body.code),
            template: AthenaCodeMail(props),
            templateProps: props,
            source: TEMPLATE_IDS.athenaCode,
            sensitiveSubject: true,
          })
        } catch (error) {
          // Never the error object: a render failure could embed the props (the code).
          log.error('Athena code send failed', {
            to: body.to,
            reason: error instanceof Error ? error.name : 'unknown',
          })
          set.status = 502
          return { message: 'Send failed' }
        }
        return { message: 'Code sent' }
      },
      { body: athenaBody },
    )
}

export const athenaRoutes = createAthenaRoutes({
  secretKey: env.ATHENA_SECRET_KEY,
  fromEmail: env.ATHENA_FROM_EMAIL,
  replyTo: env.ATHENA_REPLY_TO,
})
