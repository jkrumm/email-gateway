import type { ReactElement } from "react";
import type { Resend } from "resend";
import { resend } from "./resend";
import {
  sendLogRepo,
  type InsertSendLogInput,
  type SendLogRepo,
} from "../db/mail-index";

export const DEFAULT_FROM =
  "Free-Planning-Poker.com <no-reply@free-planning-poker.com>";

// Only what sendMail actually calls — narrower than the full SDK so any
// provider-scoped client that also offers `.emails.send` can be injected
// (e.g. the Resend provider's own read client, once it can send too).
type SendCapableResend = { emails: Pick<Resend["emails"], "send"> };

// A DB error here must never turn an already-sent email into a failed
// response for the caller (that would make them retry and send a
// duplicate). Replaces the old recordOutboundEmail/emailsRepo write: sendMail
// no longer touches the old email-gateway.sqlite store at all.
export function recordSendLog(
  sendLog: Pick<SendLogRepo, "insertSendLog">,
  input: InsertSendLogInput,
): void {
  try {
    sendLog.insertSendLog(input);
  } catch (error) {
    console.error("Failed to persist send_log row", {
      error,
      id: input.id,
    });
  }
}

export async function sendMail({
  from = DEFAULT_FROM,
  to,
  replyTo,
  subject,
  template,
  source,
  resendClient = resend,
  sendLog = sendLogRepo,
}: {
  from?: string;
  to: string;
  replyTo?: string;
  subject: string;
  template: ReactElement;
  // Our template/route id, e.g. "fpp-sender" — stored on the send_log row so
  // the admin API can filter sent mail by what generated it.
  source?: string;
  // Injectable for tests, or a provider-scoped client; defaults to the real
  // singletons in production.
  resendClient?: SendCapableResend;
  sendLog?: Pick<SendLogRepo, "insertSendLog">;
}): Promise<{ id: string; from: string }> {
  const email = await resendClient.emails.send({
    from,
    to,
    replyTo,
    subject,
    react: template,
  });

  if (email.error) {
    console.error("Email sent failed", {
      response: email,
      to,
      from,
      replyTo,
      subject,
    });
    throw new Error(
      `${email.error.statusCode ?? ""} - ${email.error.name} - ${email.error.message}`,
    );
  }

  console.log("Email sent successfully", {
    response: email,
    to,
    from,
    replyTo,
    subject,
  });

  recordSendLog(sendLog, {
    id: email.data.id,
    templateId: source ?? null,
    recipients: [to],
    provider: "resend",
    requestedBy: "route",
  });

  // The resolved sender (DEFAULT_FROM when the caller passed none) — so a
  // caller building a receipt from this never has to re-derive the default.
  return { id: email.data.id, from };
}
