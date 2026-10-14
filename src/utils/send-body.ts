import type { SendBodiesRepo } from "../db/send-bodies";
import { findTemplateEntry, templateSecrets } from "../emails/registry";

const REDACTED = "[redacted]";

// Replaces every occurrence of every secret in the rendered mail.
export function redactRendered(
  rendered: { html: string; text: string },
  secrets: string[],
): { html: string; text: string } {
  let { html, text } = rendered;
  for (const secret of secrets) {
    if (!secret) continue;
    html = html.replaceAll(secret, REDACTED);
    text = text.replaceAll(secret, REDACTED);
  }
  return { html, text };
}

/**
 * Keeps the rendered mail of a dispatched send for review (30 days, pruned by
 * the prune_send_bodies job) — the one helper the inline routes (sendMail)
 * and the send job share, so both store identically. A template that names
 * secrets (registry `redact`) has them replaced first. Fail-open: a failure
 * to store is logged and swallowed, never a failed send; and it fails
 * closed on secrets — a template with a `redact` whose props are missing or
 * unreadable is not stored at all. Never logs a body or the error object
 * (a render or redact error could embed the props).
 */
export function storeSendBody({
  sendBodies,
  sendId,
  rendered,
  templateId,
  templateProps,
}: {
  sendBodies: Pick<SendBodiesRepo, "save">;
  sendId: string;
  rendered: { html: string; text: string };
  // The registry id; absent for an unregistered send (nothing to redact).
  templateId?: string | null;
  templateProps?: unknown;
}): void {
  try {
    const entry = templateId ? findTemplateEntry(templateId) : null;
    const secrets = entry ? templateSecrets(entry, templateProps) : [];
    // Fail closed: a template that names secrets but yields none (props
    // missing or unreadable) cannot be redacted, so it is not stored.
    if (entry?.redact && secrets.length === 0) {
      console.error("Skipped storing send body: no secrets to redact", {
        id: sendId,
        templateId,
      });
      return;
    }
    sendBodies.save({ sendId, ...redactRendered(rendered, secrets) });
  } catch (error) {
    console.error("Failed to store send body", {
      id: sendId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}
