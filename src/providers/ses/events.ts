import { z } from "zod";

// Pure mapping from one SES event (the JSON an SNS Notification's `Message`
// carries, published through a configuration set's event destination) to the
// send_log patch it implies. src/db/send-log.ts's recordEventByProviderMessageId
// owns the "status never regresses" rule; this only translates.
export interface SesSendEvent {
  providerMessageId: string;
  status: string;
  lastEvent: string;
}

const sesEventSchema = z.object({
  eventType: z.string(),
  mail: z.object({ messageId: z.string().min(1) }),
  bounce: z.object({ bounceType: z.string().optional() }).optional(),
});

// Send / Open / Click / Subscription and anything unknown are absent on
// purpose: they say nothing about the delivery outcome.
const STATUS_BY_EVENT_TYPE: Readonly<Record<string, string>> = {
  Delivery: "delivered",
  Bounce: "bounced",
  Complaint: "complained",
  Reject: "rejected",
  DeliveryDelay: "delivery_delayed",
  "Rendering Failure": "failed",
};

// Null for a malformed payload or an event type that is ignored.
export function mapSesEvent(payload: unknown): SesSendEvent | null {
  const parsed = sesEventSchema.safeParse(payload);
  if (!parsed.success) return null;

  const { eventType, mail, bounce } = parsed.data;
  if (!Object.hasOwn(STATUS_BY_EVENT_TYPE, eventType)) return null;

  const status = STATUS_BY_EVENT_TYPE[eventType]!;
  const lastEvent =
    eventType === "Bounce" && bounce?.bounceType
      ? `${status}:${bounce.bounceType}`
      : status;
  return { providerMessageId: mail.messageId, status, lastEvent };
}
