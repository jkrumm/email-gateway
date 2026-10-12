import { render } from "@react-email/render";
import type { ReactElement } from "react";

// The outbound half of a mail provider, kept separate from MailProvider
// (src/providers/port.ts): sending is provider-neutral and driven by a
// pre-rendered message, while MailProvider is the mailbox read/sync surface.
// Every implementation throws on a failed send; callers never inspect a
// provider-specific error shape.
export interface SendMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  // Forwarded as the provider's own idempotency key when it supports one —
  // the send job passes its send_log row id so a re-run cannot duplicate.
  idempotencyKey?: string;
}

export interface SendStatus {
  status: string;
  lastEvent: string;
}

export interface SendProvider {
  id: string;
  send(message: SendMessage): Promise<{ providerMessageId: string }>;
  // Delivery state for a previously sent message. Optional: a provider
  // without a status read-back is skipped by the send_log reconcile job.
  status?(providerMessageId: string): Promise<SendStatus>;
}

// Rendered once per send, so a provider never has to know about React.
export async function renderTemplate(
  element: ReactElement,
): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}
