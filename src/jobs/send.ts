import { renderTemplate, type SendProvider } from "../providers/send-port";
import { sendProviderByName } from "../providers/send-registry";
import { sendLogRepo as defaultSendLog } from "../db/mail-index";
import { SEND_CLAIM_STALE_MS, type SendLogRepo } from "../db/send-log";
import { findTemplateEntry, renderTemplateElement } from "../emails/registry";
import type { JobHandler } from "./runner";

// The `send` job kind (docs/architecture.md §Jobs: "sends become jobs"):
// template test-send and agent `POST /api/sends` insert the send_log row and
// enqueue this job with its id; the contact-form routes send inline and
// enqueue nothing.
export interface SendJobPayload {
  // The send_log row id, already inserted by the caller before enqueueing.
  id: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  // A React element can't survive payload_json — the registered template's
  // id and the props to render it with are stored instead (src/emails/
  // registry.ts), and re-rendered here.
  templateName: string;
  templateProps: unknown;
}

export function createSendHandler({
  providerByName = sendProviderByName,
  sendLog = defaultSendLog,
}: {
  providerByName?: (name: string) => SendProvider | null;
  sendLog?: Pick<
    SendLogRepo,
    "recordProviderResult" | "getSendLog" | "claimSend" | "releaseSend"
  >;
} = {}): JobHandler {
  return async (payload) => {
    const input = payload as SendJobPayload;

    // Idempotency guard: provider.send runs before recordProviderResult's
    // UPDATE. If that UPDATE throws (e.g. SQLITE_BUSY during the
    // two-container deploy overlap), the runner's at-least-once retry would
    // otherwise call send() again and duplicate the customer email. A row
    // already recorded as sent means this job is already done in every way
    // that matters — skip straight to success. Any recorded provider message
    // id counts, not only status "sent": the SES event webhook may have
    // advanced the row to "delivered", and a provider without an idempotency
    // key (SES) would send the mail a second time.
    const existing = sendLog.getSendLog(input.id);
    if (existing?.providerMessageId) return;

    // The provider was chosen at enqueue time (enqueueTemplateSend) and
    // stored on the row, so a row written under another provider name is
    // never rerouted to this one.
    if (!existing) {
      throw new Error(`send job ${input.id}: no send_log row`);
    }
    const provider = providerByName(existing.provider);
    if (!provider) {
      throw new Error(
        `send job ${input.id}: unknown provider "${existing.provider}"`,
      );
    }

    const entry = findTemplateEntry(input.templateName);
    if (!entry) {
      throw new Error(
        `send job ${input.id}: unknown template "${input.templateName}"`,
      );
    }

    const { html, text } = await renderTemplate(
      renderTemplateElement(entry, input.templateProps),
    );

    // The read above and the send below race when two containers overlap on
    // a deploy: both could see no provider message id and both send, which a
    // provider without an idempotency key (SES) cannot refuse. Claim the row
    // atomically first. Not claimed means another worker is mid-send (a fresh
    // claim) — throw so the runner retries later; never report success for a
    // send this worker did not make. A claim older than SEND_CLAIM_STALE_MS
    // belongs to a crashed worker and is taken over.
    //
    // Accepted gap: the claim stops two LIVE workers from both sending. It
    // does not cover an ambiguous outcome — SES accepted the message but the
    // response or the recordProviderResult write was lost — which can send
    // again once the claim goes stale (SEND_CLAIM_STALE_MS), because SES has
    // no idempotency key.
    const staleBefore = new Date(
      Date.now() - SEND_CLAIM_STALE_MS,
    ).toISOString();
    const claim = sendLog.claimSend(input.id, staleBefore);
    if (!claim) {
      throw new Error(
        `send job ${input.id}: another worker holds the send claim, retrying later`,
      );
    }

    // The provider's own idempotency key is the second line of defense: if
    // this handler genuinely runs twice for the same send_log row (a process
    // crash mid-handler, not just the recordProviderResult write below
    // throwing), the provider refuses the duplicate itself instead of
    // sending it.
    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.send({
        from: input.from,
        to: input.to,
        replyTo: input.replyTo,
        subject: input.subject,
        html,
        text,
        idempotencyKey: input.id,
      }));
    } catch (error) {
      // Nothing was sent: hand the claim back so the retry can take it.
      sendLog.releaseSend(input.id, claim);
      throw error;
    }

    // A write failure here must never propagate: the email already sent, so
    // the runner's at-least-once retry on a thrown error would call send()
    // again and duplicate it (mirrors recordSendLog's pattern in
    // src/utils/send-mail.ts). The idempotencyKey above is what actually
    // stops that retry from sending twice.
    try {
      sendLog.recordProviderResult(input.id, {
        providerMessageId,
        status: "sent",
      });
    } catch (error) {
      console.error("Failed to record send_log provider result", {
        error,
        id: input.id,
      });
    }
  };
}
