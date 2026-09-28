import { createElement, type ComponentType } from "react";
import { resend as defaultResendClient } from "../utils/resend";
import { sendLogRepo as defaultSendLog } from "../db/mail-index";
import type { SendLogRepo } from "../db/send-log";
import { emailRegistry } from "../emails/registry";
import type { JobHandler } from "./runner";

// The `send` job kind's queue-plumbing (docs/architecture.md §Jobs: "sends
// become jobs"). Nothing enqueues this yet — Wave 4 deliberately keeps the
// contact-form routes' own notification email synchronous (see AGENTS.md and
// the wave report's Left Behind); this handler exists for Wave 7/8's template
// test-send and agent `POST /api/sends`, which will insert the send_log row
// and enqueue this job with its id before this handler ever runs.
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
  resendClient = defaultResendClient,
  sendLog = defaultSendLog,
}: {
  resendClient?: Pick<typeof defaultResendClient, "emails">;
  sendLog?: Pick<SendLogRepo, "recordProviderResult" | "getSendLog">;
} = {}): JobHandler {
  return async (payload) => {
    const input = payload as SendJobPayload;

    // Idempotency guard: resendClient.emails.send runs before
    // recordProviderResult's UPDATE. If that UPDATE throws (e.g.
    // SQLITE_BUSY during the two-container deploy overlap), the runner's
    // at-least-once retry would otherwise call send() again and duplicate
    // the customer email. A row already recorded as sent means this job is
    // already done in every way that matters — skip straight to success.
    const existing = sendLog.getSendLog(input.id);
    if (existing?.status === "sent" && existing.providerMessageId) return;

    const entry = emailRegistry.find((item) => item.id === input.templateName);
    if (!entry) {
      throw new Error(
        `send job ${input.id}: unknown template "${input.templateName}"`,
      );
    }

    // templateProps has no per-template schema until Wave 7/8's template
    // registry grows one — a single cast down to each entry's own component
    // type is the accepted gap until then (narrower than `never`, which
    // disabled type checking on this call entirely).
    const element = createElement(
      entry.component as unknown as ComponentType<Record<string, unknown>>,
      input.templateProps as Record<string, unknown>,
    );

    // Resend's own idempotency key (CreateEmailRequestOptions.idempotencyKey,
    // node_modules/resend/dist/index.d.mts) is the second line of defense: if
    // this handler genuinely runs twice for the same send_log row (a process
    // crash mid-handler, not just the recordProviderResult write below
    // throwing), Resend refuses the duplicate itself instead of sending it.
    const email = await resendClient.emails.send(
      {
        from: input.from,
        to: input.to,
        replyTo: input.replyTo,
        subject: input.subject,
        react: element,
      },
      { idempotencyKey: input.id },
    );

    if (email.error) {
      throw new Error(`${email.error.name} - ${email.error.message}`);
    }

    // A write failure here must never propagate: the email already sent, so
    // the runner's at-least-once retry on a thrown error would call send()
    // again and duplicate it (mirrors recordSendLog's pattern in
    // src/utils/send-mail.ts). Resend's idempotencyKey above is what actually
    // stops that retry from sending twice.
    try {
      sendLog.recordProviderResult(input.id, {
        providerMessageId: email.data.id,
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
