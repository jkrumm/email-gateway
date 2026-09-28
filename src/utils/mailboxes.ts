// Shared by env.ts's validation and providers/imap/config.ts's parsing, so
// the comma-split + trim convention for IMAP_MAILBOXES/GMAIL_IMAP_MAILBOXES
// can't drift between the two.
export function splitMailboxes(value: string): string[] {
  return value
    .split(",")
    .map((mailbox) => mailbox.trim())
    .filter(Boolean);
}
