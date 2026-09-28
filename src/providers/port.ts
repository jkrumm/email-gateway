import type { ReactElement } from "react";

// The one interface every mailbox sits behind (docs/architecture.md
// §Provider port). A new mailbox is a new adapter, not a new code path.
// Capabilities are declared per adapter instance from what the server
// actually advertises, never assumed from the provider id.

export type ProviderId = "proton" | "gmail" | "resend";

export interface Capabilities {
  list: boolean;
  read: boolean;
  search: boolean;
  flag: boolean;
  move: boolean;
  send: boolean;
  idle: boolean;
}

// Provider-specific and opaque to callers: an IMAP ref names a mailbox/UID
// pair (IMAP UIDs are only unique within one mailbox+UIDVALIDITY) plus the
// account it came from — `provider` alone doesn't distinguish two Gmail
// accounts (Wave 8), so a ref must never be accepted by a *different*
// account's adapter instance even when the provider kind matches. A Resend
// ref names a Resend email id plus which list it came from.
export type MessageRef =
  | {
      provider: "proton" | "gmail";
      account: string;
      mailbox: string;
      uidValidity: string;
      uid: number;
    }
  | { provider: "resend"; id: string; mailbox: string };

export interface Mailbox {
  path: string;
  name: string;
  delimiter?: string;
  specialUse?: string;
}

export interface Envelope {
  ref: MessageRef;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  // Null when the provider reported no usable date — never fabricated.
  date: string | null;
  size: number | null;
  hasAttachments: boolean;
  flags: string[];
  threadKey?: string;
}

export interface MessageAttachment {
  filename: string | null;
  contentType: string;
  size: number;
}

export interface Message extends Envelope {
  html: string | null;
  text: string | null;
  attachments: MessageAttachment[];
}

export interface SearchQuery {
  mailbox?: string;
  body?: string;
  text?: string;
  from?: string;
  since?: Date;
}

export interface FlagChange {
  add?: string[];
  remove?: string[];
  set?: string[];
}

export interface OutboundDraft {
  from?: string;
  to: string;
  replyTo?: string;
  subject: string;
  template: ReactElement;
  // Our own template/route id, stored on the outbound row.
  source?: string;
}

export interface SentReceipt {
  id: string;
  to: string;
  from: string;
}

// Opaque pagination token; a provider's own list() is the only thing that
// interprets it.
export type Cursor = string | undefined;

export interface Page<T> {
  items: T[];
  cursor: Cursor;
}

export type Unsubscribe = () => void;

export interface ListOptions {
  // Forces a full newest-page scan even when a provider's CONDSTORE fast
  // path could otherwise answer a cursorless call — the fast path always
  // returns `cursor: undefined`, indistinguishable from "genuinely nothing
  // older than this page" (src/sync/ingest.ts needs that distinction the
  // one time it seeds backfill progress from a head page's cursor: a fresh
  // or just-reset mailbox must get a real, truncation-based cursor, not an
  // ambiguous one from a CONDSTORE shortcut).
  skipFastPath?: boolean;
}

export interface MailProvider {
  readonly id: ProviderId;
  // hello@…, me@gmail.com, the Resend sending domain.
  readonly account: string;
  capabilities(): Promise<Capabilities>;
  listMailboxes(): Promise<Mailbox[]>;
  // Newest first, bounded — never lists an unbounded backlog in one call.
  list(
    mailbox: string,
    cursor: Cursor,
    options?: ListOptions,
  ): Promise<Page<Envelope>>;
  read(ref: MessageRef): Promise<Message>;
  // Provider-side; may lag the provider's own index by up to a minute.
  search(query: SearchQuery): Promise<MessageRef[]>;
  setFlags(ref: MessageRef, flags: FlagChange): Promise<void>;
  move(ref: MessageRef, toMailbox: string): Promise<MessageRef>;
  send(draft: OutboundDraft): Promise<SentReceipt>;
  // IDLE / push. Optional: not every adapter can watch.
  watch?(mailbox: string, onChange: () => void): Promise<Unsubscribe>;
}

// Throw from a method a provider's own capabilities() reports as false, so a
// caller that skips the capability check fails loud instead of silently
// no-op-ing.
export function unsupported(provider: ProviderId, method: string): Error {
  return new Error(`${provider} adapter does not support ${method}`);
}
