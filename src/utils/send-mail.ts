import type { ReactElement } from 'react'
import {
  sendBodiesRepo,
  sendLogRepo,
  type InsertSendLogInput,
  type SendBodiesRepo,
  type SendLogRepo,
} from '../db/mail-index'
import { renderTemplate, type SendProvider } from '../providers/send-port'
import { sendProvider } from '../providers/send-registry'
import { storeSendBody } from './send-body'
import { emitSendResult } from './send-result'
import { log } from '../telemetry/log'
import { errorName } from '../telemetry/otel-format'

export const DEFAULT_FROM = 'Free-Planning-Poker.com <no-reply@free-planning-poker.com>'

// A DB error here must never turn an already-sent email into a failed
// response for the caller (that would make them retry and send a
// duplicate). Replaces the old recordOutboundEmail/emailsRepo write: sendMail
// no longer touches the old email-gateway.sqlite store at all.
export function recordSendLog(
  sendLog: Pick<SendLogRepo, 'insertSendLog'>,
  input: InsertSendLogInput,
): void {
  try {
    sendLog.insertSendLog(input)
  } catch (error) {
    log.error('Failed to persist send_log row', {
      error,
      id: input.id,
    })
  }
}

// What requested a send, as send_log.requested_by and the provider's `source`
// tag: the inline routes are all "route".
const ROUTE_SOURCE = 'route'

/**
 * Sends one rendered template through the send provider, records a send_log
 * row and keeps the (redacted) rendered mail for review. The returned `id` is the PROVIDER's message id (what the
 * caller can look up at the provider), not the send_log row id, which is a
 * separate random UUID.
 */
export async function sendMail({
  from = DEFAULT_FROM,
  to,
  replyTo,
  subject,
  template,
  source,
  sensitiveSubject = false,
  templateProps,
  provider = sendProvider(),
  sendLog = sendLogRepo,
  sendBodies = sendBodiesRepo,
}: {
  from?: string
  to: string
  replyTo?: string
  subject: string
  template: ReactElement
  // Our template/route id, e.g. "fpp-sender" — stored on the send_log row so
  // the admin API can filter sent mail by what generated it.
  source?: string
  // The subject carries a secret (an auth code): logs say "[redacted]".
  sensitiveSubject?: boolean
  // The props `template` was built from: the registry's `redact` reads the
  // secrets (an auth code) to blank out of the stored body from them. A
  // template that names secrets is not stored without them.
  templateProps?: unknown
  // Injectable for tests; defaults to the SES provider.
  provider?: SendProvider
  sendLog?: Pick<SendLogRepo, 'insertSendLog'>
  sendBodies?: Pick<SendBodiesRepo, 'save'>
}): Promise<{ id: string; from: string }> {
  const { html, text } = await renderTemplate(template)
  const loggedSubject = sensitiveSubject ? '[redacted]' : subject
  // Provider-independent: two providers' message ids could collide on
  // INSERT OR IGNORE, and the id must not change with the provider.
  const sendId = crypto.randomUUID()

  let providerMessageId: string
  try {
    ;({ providerMessageId } = await provider.send({
      from,
      to,
      replyTo,
      subject,
      html,
      text,
      tags: {
        ...(source ? { template: source } : {}),
        source: ROUTE_SOURCE,
      },
    }))
  } catch (error) {
    emitSendResult({
      template: source ?? 'unspecified',
      source: ROUTE_SOURCE,
      status: 'failed',
    })
    log.error('Email sent failed', {
      provider: provider.id,
      // A sensitive send's failure text could echo the rendered mail (the
      // auth code), so only the error's name is logged for it.
      error: sensitiveSubject ? errorName(error) : error,
      to,
      from,
      replyTo,
      subject: loggedSubject,
    })
    throw error
  }

  emitSendResult({
    template: source ?? 'unspecified',
    source: ROUTE_SOURCE,
    status: 'sent',
  })
  log.info('Email sent successfully', {
    provider: provider.id,
    providerMessageId,
    to,
    from,
    replyTo,
    subject: loggedSubject,
  })

  recordSendLog(sendLog, {
    id: sendId,
    templateId: source ?? null,
    recipients: [to],
    provider: provider.id,
    providerMessageId,
    status: 'sent',
    requestedBy: ROUTE_SOURCE,
  })
  storeSendBody({
    sendBodies,
    sendId,
    rendered: { html, text },
    templateId: source,
    templateProps,
  })

  // The resolved sender (DEFAULT_FROM when the caller passed none) — so a
  // caller building a receipt from this never has to re-derive the default.
  return { id: providerMessageId, from }
}
