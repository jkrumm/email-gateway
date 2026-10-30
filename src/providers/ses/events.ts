import { z } from 'zod'

// Pure mapping from one SES event (the JSON an SNS Notification's `Message`
// carries, published through a configuration set's event destination) to what
// it implies for send_log (status) and send_events (the timeline).
// src/db/send-log.ts's recordProviderEvent owns the "status never regresses"
// rule; this only translates.
//
// Never carries a recipient address: SES puts them in the payload, and the
// webhook must not store them (AGENTS.md). The one free-text field kept, the
// bounce diagnostic code, is scrubbed of anything address-shaped.
export interface SesSendEvent {
  providerMessageId: string
  // SES's own event type ("Send", "Delivery", "Bounce", ...).
  eventType: string
  // The delivery status the event implies; null for a timeline-only event
  // (Send), which is recorded in send_events but must not move send_log.
  status: string | null
  lastEvent: string
  // ISO UTC: the event's own timestamp, the receive time when it has none.
  occurredAt: string
  bounceType?: string
  bounceSubtype?: string
  diagnosticCode?: string
}

const eventTimestampSchema = z.object({ timestamp: z.string().optional() })

const sesEventSchema = z.object({
  eventType: z.string(),
  mail: z.object({
    messageId: z.string().min(1),
    timestamp: z.string().optional(),
  }),
  bounce: z
    .object({
      bounceType: z.string().optional(),
      bounceSubtype: z.string().optional(),
      timestamp: z.string().optional(),
      bouncedRecipients: z.array(z.object({ diagnosticCode: z.string().optional() })).optional(),
    })
    .optional(),
  delivery: eventTimestampSchema.optional(),
  complaint: eventTimestampSchema.optional(),
  deliveryDelay: eventTimestampSchema.optional(),
})

// Send / Open / Click / Subscription and anything unknown that is absent here
// say nothing about the delivery outcome. Send is the exception: it is mapped
// (status null) so the timeline starts at the hand-off.
const STATUS_BY_EVENT_TYPE: Readonly<Record<string, string | null>> = {
  Send: null,
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  Reject: 'rejected',
  DeliveryDelay: 'delivery_delayed',
  'Rendering Failure': 'failed',
}

const MAX_DIAGNOSTIC_CODE_LENGTH = 500
const ADDRESS_PATTERN = /[^\s<>"'(),;]+@[^\s<>"'(),;]+/g

// SMTP diagnostics often quote the rejected address ("550 5.1.1 <a@b.c>
// unknown"): keep the code, drop the address.
function scrubDiagnosticCode(code: string | undefined): string | undefined {
  if (!code) return undefined
  return code.replace(ADDRESS_PATTERN, '[address]').slice(0, MAX_DIAGNOSTIC_CODE_LENGTH)
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

// The timeline label: the event type for a status-less event (Send), the
// status otherwise, with a bounce's type appended.
function lastEventFor(
  eventType: string,
  status: string | null,
  bounceType: string | undefined,
): string {
  if (status === null) return eventType.toLowerCase()
  if (eventType === 'Bounce' && bounceType) return `${status}:${bounceType}`
  return status
}

// The event's own timestamp, from the sub-object SES names after its type.
function ownTimestampOf(
  eventType: string,
  parts: {
    bounce?: { timestamp?: string }
    delivery?: { timestamp?: string }
    complaint?: { timestamp?: string }
    deliveryDelay?: { timestamp?: string }
  },
): string | undefined {
  switch (eventType) {
    case 'Bounce':
      return parts.bounce?.timestamp
    case 'Delivery':
      return parts.delivery?.timestamp
    case 'Complaint':
      return parts.complaint?.timestamp
    case 'DeliveryDelay':
      return parts.deliveryDelay?.timestamp
    default:
      return undefined
  }
}

// Null for a malformed payload or an event type that is ignored. `receivedAt`
// is the fallback for an event without a usable timestamp.
export function mapSesEvent(payload: unknown, receivedAt: Date = new Date()): SesSendEvent | null {
  const parsed = sesEventSchema.safeParse(payload)
  if (!parsed.success) return null

  const { eventType, mail, bounce, delivery, complaint, deliveryDelay } = parsed.data
  if (!Object.hasOwn(STATUS_BY_EVENT_TYPE, eventType)) return null

  const status = STATUS_BY_EVENT_TYPE[eventType] ?? null
  const lastEvent = lastEventFor(eventType, status, bounce?.bounceType)
  const ownTimestamp = ownTimestampOf(eventType, {
    bounce,
    delivery,
    complaint,
    deliveryDelay,
  })
  const occurredAt =
    isoOrNull(ownTimestamp) ?? isoOrNull(mail.timestamp) ?? receivedAt.toISOString()

  const event: SesSendEvent = {
    providerMessageId: mail.messageId,
    eventType,
    status,
    lastEvent,
    occurredAt,
  }
  if (eventType !== 'Bounce') return event

  if (bounce?.bounceType) event.bounceType = bounce.bounceType
  if (bounce?.bounceSubtype) event.bounceSubtype = bounce.bounceSubtype
  const diagnosticCode = scrubDiagnosticCode(bounce?.bouncedRecipients?.[0]?.diagnosticCode)
  if (diagnosticCode) event.diagnosticCode = diagnosticCode
  return event
}
