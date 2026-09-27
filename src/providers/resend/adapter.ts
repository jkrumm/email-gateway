import { sendMail } from "../../utils/send-mail";
import { toIsoTimestamp } from "../../utils/date";
import type { ResendSendClient } from "./client";
import type {
  Capabilities,
  Envelope,
  MailProvider,
  Mailbox,
  Message,
  MessageRef,
  OutboundDraft,
  Page,
  SentReceipt,
} from "../port";
import { unsupported } from "../port";

const PAGE_LIMIT = 100;

// Resend has no folders; the two lists src/sync/resend-sync.ts already reads
// (sent history, receiving history) stand in as the provider's two mailboxes.
type ResendMailboxPath = "sent" | "received";

function isResendMailbox(path: string): path is ResendMailboxPath {
  return path === "sent" || path === "received";
}

function ref(id: string, mailbox: ResendMailboxPath): MessageRef {
  return { provider: "resend", id, mailbox };
}

function toEnvelope(
  item: {
    id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
  },
  mailbox: ResendMailboxPath,
): Envelope {
  return {
    ref: ref(item.id, mailbox),
    from: item.from,
    to: item.to,
    subject: item.subject,
    // Resend's created_at isn't ISO (e.g. "2026-09-15 07:15:57.115000+00");
    // the IMAP provider's date is true ISO, so both sides of the shared
    // Envelope.date must go through the same normalizer.
    date: toIsoTimestamp(item.created_at),
    size: null,
    hasAttachments: false,
    flags: [],
  };
}

// send() + the history reads src/sync/resend-sync.ts uses, as a MailProvider.
// Send-only: no folders to search/flag/move, so those methods always reject —
// callers must check capabilities() first, per docs/architecture.md's
// capability gate.
export function createResendProvider({
  account,
  resend,
}: {
  account: string;
  resend: ResendSendClient;
}): MailProvider {
  return {
    id: "resend",
    account,
    async capabilities(): Promise<Capabilities> {
      return {
        list: true,
        read: true,
        search: false,
        flag: false,
        move: false,
        send: true,
        idle: false,
      };
    },
    async listMailboxes(): Promise<Mailbox[]> {
      return [
        { path: "sent", name: "Sent" },
        { path: "received", name: "Received" },
      ];
    },
    async list(mailboxPath, cursor): Promise<Page<Envelope>> {
      if (!isResendMailbox(mailboxPath)) {
        throw new Error(`resend adapter has no mailbox "${mailboxPath}"`);
      }
      const page =
        mailboxPath === "received"
          ? await resend.emails.receiving.list({
              limit: PAGE_LIMIT,
              after: cursor,
            })
          : await resend.emails.list({ limit: PAGE_LIMIT, after: cursor });
      if (page.error) throw new Error(page.error.message);

      const { data, has_more } = page.data;
      const items = data.map((item) => toEnvelope(item, mailboxPath));
      const last = data[data.length - 1];
      return { items, cursor: has_more && last ? last.id : undefined };
    },
    async read(messageRef): Promise<Message> {
      if (messageRef.provider !== "resend") {
        throw new Error(
          `adapter for "resend" received a ref for provider "${messageRef.provider}"`,
        );
      }
      const { id, mailbox } = messageRef;
      if (!isResendMailbox(mailbox)) {
        throw new Error(`resend adapter has no mailbox "${mailbox}"`);
      }
      const full =
        mailbox === "received"
          ? await resend.emails.receiving.get(id)
          : await resend.emails.get(id);
      if (full.error) throw new Error(full.error.message);

      const data = full.data;
      const attachments =
        "attachments" in data
          ? data.attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.content_type,
              size: attachment.size,
            }))
          : [];

      return {
        ref: messageRef,
        from: data.from,
        to: data.to,
        subject: data.subject,
        date: toIsoTimestamp(data.created_at),
        size: null,
        hasAttachments: attachments.length > 0,
        flags: [],
        html: data.html ?? null,
        text: data.text ?? null,
        attachments,
      };
    },
    async search() {
      throw unsupported("resend", "search");
    },
    async setFlags() {
      throw unsupported("resend", "setFlags");
    },
    async move() {
      throw unsupported("resend", "move");
    },
    async send(draft: OutboundDraft): Promise<SentReceipt> {
      const receipt = await sendMail({
        from: draft.from,
        to: draft.to,
        replyTo: draft.replyTo,
        subject: draft.subject,
        template: draft.template,
        source: draft.source,
        // This provider's own client, not the send-route singleton — a
        // provider built against a different Resend account must send
        // through that account, not silently fall back to the default one.
        resendClient: resend,
      });
      // sendMail's own resolved `from` (its default, not draft.from ?? account)
      // — so the receipt never claims a sender different from the one used.
      return { id: receipt.id, to: draft.to, from: receipt.from };
    },
  };
}
