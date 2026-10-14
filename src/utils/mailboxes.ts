// Shared by env.ts's validation and providers/imap/config.ts's parsing, so
// the comma-split + trim convention for IMAP_MAILBOXES/GMAIL_IMAP_MAILBOXES
// can't drift between the two.
export function splitMailboxes(value: string): string[] {
  return value
    .split(",")
    .map((mailbox) => mailbox.trim())
    .filter(Boolean);
}

// Telemetry and log lines name a mailbox only by its well-known role: a folder or
// label the owner named themselves could carry personal data, so anything else
// is "other".
const KNOWN_MAILBOX_ROLES = new Set([
  "inbox",
  "spam",
  "junk",
  "sent",
  "archive",
  "drafts",
  "trash",
  "all mail",
  "starred",
  "important",
]);

export function mailboxRole(mailbox: string): string {
  const leaf = (mailbox.split("/").at(-1) ?? "").toLowerCase();
  return KNOWN_MAILBOX_ROLES.has(leaf) ? leaf : "other";
}
