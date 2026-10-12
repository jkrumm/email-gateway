import { Elysia } from "elysia";
import { sendLogRepo } from "../db/mail-index";
import type { SendLogRepo } from "../db/send-log";
import { env } from "../env";
import { mapSesEvent } from "../providers/ses/events";
import {
  createSnsVerifier,
  snsMessageSchema,
  trustedSnsUrl,
  type SnsMessage,
  type SnsVerifier,
} from "../providers/ses/sns-verify";

const MAX_BODY_BYTES = 256 * 1024;
const CONFIRM_FETCH_TIMEOUT_MS = 5_000;

// Reads the request body as text, but never more than MAX_BODY_BYTES: a
// declared Content-Length over the cap is refused before reading, and the
// stream is counted chunk by chunk and cancelled the moment the total passes
// it (a chunked or lying-Content-Length body is never buffered whole). Returns
// BODY_TOO_LARGE on overflow: a throw from an Elysia parser surfaces as a 400
// parse error, so the handler turns the sentinel into the 413 instead.
const BODY_TOO_LARGE = Symbol("body too large");

async function readCappedText(
  request: Request,
): Promise<string | typeof BODY_TOO_LARGE> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    return BODY_TOO_LARGE;
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return BODY_TOO_LARGE;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Amazon SNS -> send_log. SES publishes delivery events to an SNS topic, and
// SNS POSTs them here (as text/plain). The route is public by necessity: the
// only authentication is SNS's own message signature (sns-verify.ts), after
// the TopicArn pin; rate limiting is Traefik's. Raw message delivery must stay
// OFF on the topic, since the signed SNS envelope is what gets verified.
// Unset topic ARN (or region) -> the path 404s. Logs carry event types and
// message ids only, never the payload (recipient addresses).
//
// A replayed, captured signed Notification is accepted on purpose: the
// send_log status-rank guard makes it a no-op or an identical re-apply of the
// same event, so Timestamp freshness is deliberately not enforced.
// A DB write failure is likewise left to surface as a 5xx on purpose: SNS
// retries a non-2xx, and the rank guard makes the retry idempotent.
export function createSesWebhookRoutes({
  topicArn,
  region,
  verifier = region ? createSnsVerifier({ region }) : undefined,
  fetch: fetchUrl = fetch,
  sendLog = sendLogRepo,
}: {
  topicArn: string | undefined;
  region: string | undefined;
  verifier?: SnsVerifier;
  // Used only to confirm a subscription (GET SubscribeURL).
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sendLog?: SendLogRepo;
}) {
  async function confirmSubscription(message: SnsMessage, snsRegion: string) {
    const url = message.SubscribeURL
      ? trustedSnsUrl(message.SubscribeURL, snsRegion)
      : null;
    if (!url) {
      console.warn(
        `ses webhook: SubscriptionConfirmation ${message.MessageId} has no trusted SubscribeURL`,
      );
      return;
    }
    try {
      // redirect: "error" — a 3xx must not walk the GET off the pinned host.
      const response = await fetchUrl(url.href, {
        signal: AbortSignal.timeout(CONFIRM_FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      console.log(
        `ses webhook: confirmed subscription ${message.MessageId} for ${message.TopicArn}`,
      );
    } catch (error) {
      console.warn(
        `ses webhook: confirming subscription ${message.MessageId} failed`,
        error,
      );
    }
  }

  function recordNotification(message: SnsMessage) {
    let event: unknown;
    try {
      event = JSON.parse(message.Message);
    } catch {
      console.warn(
        `ses webhook: Notification ${message.MessageId} Message is not JSON, ignored`,
      );
      return;
    }

    const mapped = mapSesEvent(event);
    if (!mapped) {
      const eventType =
        typeof event === "object" && event !== null && "eventType" in event
          ? String(event.eventType)
          : "unknown";
      console.log(
        `ses webhook: ignored ${eventType} event (notification ${message.MessageId})`,
      );
      return;
    }

    const changed = sendLog.recordEventByProviderMessageId(
      "ses",
      mapped.providerMessageId,
      { status: mapped.status, lastEvent: mapped.lastEvent },
    );
    if (changed === 0) {
      console.log(
        `ses webhook: ${mapped.lastEvent} for ${mapped.providerMessageId} not applied (no such send or stale)`,
      );
    }
  }

  return new Elysia().post(
    "/webhooks/ses",
    async ({ body, set }) => {
      if (!topicArn || !region || !verifier) {
        set.status = 404;
        return { message: "Not Found" };
      }

      if (body === BODY_TOO_LARGE) {
        set.status = 413;
        return { message: "Payload Too Large" };
      }

      let json: unknown;
      try {
        json = JSON.parse(String(body));
      } catch {
        set.status = 400;
        return { message: "Bad Request" };
      }
      const parsed = snsMessageSchema.safeParse(json);
      if (!parsed.success) {
        set.status = 400;
        return { message: "Bad Request" };
      }
      const message = parsed.data;

      // Before any network fetch: a message for another topic never makes us
      // fetch its (attacker-chosen) certificate.
      if (message.TopicArn !== topicArn) {
        set.status = 403;
        return { message: "Forbidden" };
      }

      let verified = false;
      try {
        verified = await verifier.verify(message);
      } catch (error) {
        console.warn(
          `ses webhook: verifying ${message.MessageId} failed`,
          error,
        );
      }
      if (!verified) {
        set.status = 403;
        return { message: "Forbidden" };
      }

      if (message.Type === "SubscriptionConfirmation") {
        await confirmSubscription(message, region);
      } else if (message.Type === "Notification") {
        recordNotification(message);
      }
      return { ok: true };
    },
    // SNS posts text/plain, so Elysia's JSON parser would not run anyway;
    // this reads whatever arrives, capped.
    { parse: ({ request }) => readCappedText(request) },
  );
}

export const sesWebhookRoutes = createSesWebhookRoutes({
  topicArn: env.SES_SNS_TOPIC_ARN,
  region: env.SES_REGION,
});
