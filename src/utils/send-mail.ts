import type { ReactElement } from "react";
import {
  sendLogRepo,
  type InsertSendLogInput,
  type SendLogRepo,
} from "../db/mail-index";
import { renderTemplate, type SendProvider } from "../providers/send-port";
import { sendProviderFor } from "../providers/send-registry";

export const DEFAULT_FROM =
  "Free-Planning-Poker.com <no-reply@free-planning-poker.com>";

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
  provider = sendProviderFor(source),
  sendLog = sendLogRepo,
}: {
  from?: string;
  to: string;
  replyTo?: string;
  subject: string;
  template: ReactElement;
  // Our template/route id, e.g. "fpp-sender" — stored on the send_log row so
  // the admin API can filter sent mail by what generated it, and the key
  // SEND_PROVIDERS picks the provider by.
  source?: string;
  // Injectable for tests, or a provider-scoped send provider; defaults to the
  // one SEND_PROVIDERS selects for `source`.
  provider?: SendProvider;
  sendLog?: Pick<SendLogRepo, "insertSendLog">;
}): Promise<{ id: string; from: string }> {
  const { html, text } = await renderTemplate(template);

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await provider.send({
      from,
      to,
      replyTo,
      subject,
      html,
      text,
    }));
  } catch (error) {
    console.error("Email sent failed", {
      provider: provider.id,
      error,
      to,
      from,
      replyTo,
      subject,
    });
    throw error;
  }

  console.log("Email sent successfully", {
    provider: provider.id,
    providerMessageId,
    to,
    from,
    replyTo,
    subject,
  });

  recordSendLog(sendLog, {
    // Provider-independent: two providers' message ids could collide on
    // INSERT OR IGNORE, and the id must not change with the provider.
    id: crypto.randomUUID(),
    templateId: source ?? null,
    recipients: [to],
    provider: provider.id,
    providerMessageId,
    status: "sent",
    requestedBy: "route",
  });

  // The resolved sender (DEFAULT_FROM when the caller passed none) — so a
  // caller building a receipt from this never has to re-derive the default.
  return { id: providerMessageId, from };
}
