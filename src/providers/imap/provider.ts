import PostalMime, { type Email } from "postal-mime";
import { addressList } from "./address";
import { validDate } from "../../utils/date";
import type {
  Capabilities,
  Envelope,
  FlagChange,
  Mailbox,
  MailProvider,
  Message,
  MessageAttachment,
  MessageRef,
  Page,
  ProviderId,
  SearchQuery,
} from "../port";
import { unsupported } from "../port";
import {
  createImapflowPort,
  type ImapConfig,
  type ImapEnvelopeInfo,
  type ImapPort,
  type ImapSession,
} from "./adapter";

// The two IMAP-backed provider ids; Resend has its own adapter. Derived from
// port.ts's ProviderId so a new provider id can't drift out of sync here.
export type ImapProviderId = Exclude<ProviderId, "resend">;

const LIST_PAGE_LIMIT = 500;

// Wraps the low-level port (./adapter.ts) into the generic MailProvider
// (docs/architecture.md §Provider port). Each call opens its own short-lived
// session — nothing in this wave keeps one open across calls, since the sync
// tick already manages its own connection lifecycle via the low-level port.
async function withImapSession<T>(
  port: ImapPort,
  fn: (session: ImapSession) => Promise<T>,
): Promise<T> {
  const session = await port.connect();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function withImapMailbox<T>(
  port: ImapPort,
  path: string,
  options: { readOnly?: boolean },
  fn: (mailbox: Awaited<ReturnType<ImapSession["openMailbox"]>>) => Promise<T>,
): Promise<T> {
  return withImapSession(port, async (session) => {
    const mailbox = await session.openMailbox(path, options);
    try {
      return await fn(mailbox);
    } finally {
      mailbox.release();
    }
  });
}

type ImapRef = Extract<MessageRef, { provider: "proton" | "gmail" }>;

// Every IMAP entry point takes this first, with no I/O yet: a ref for the
// wrong provider kind (proton ref against a gmail MailProvider, or a resend
// ref against either) OR a *different account of the same kind* (two Gmail
// accounts, Wave 8) is detectable for free — `provider` alone doesn't name
// which account issued the ref.
function assertOwnProvider(
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
): asserts ref is ImapRef {
  if (ref.provider !== id) {
    throw new Error(
      `adapter for "${id}" received a ref for provider "${ref.provider}"`,
    );
  }
  if (ref.account !== account) {
    throw new Error(
      `adapter for account "${account}" received a ref for account ` +
        `"${ref.account}"`,
    );
  }
}

// A persisted ref names a mailbox+UIDVALIDITY+uid triple. If the mailbox was
// recreated (UIDVALIDITY bump) since the ref was handed out, that uid can now
// name an unrelated message — never silently act on it.
function assertFreshRef(ref: ImapRef, currentUidValidity: string): void {
  if (ref.uidValidity !== currentUidValidity) {
    throw new Error(
      `stale ref: ${ref.mailbox} uid ${ref.uid} was issued for UIDVALIDITY ` +
        `${ref.uidValidity}, mailbox is now at ${currentUidValidity}`,
    );
  }
}

function toEnvelope(
  id: ImapProviderId,
  account: string,
  mailboxPath: string,
  uidValidity: string,
  info: ImapEnvelopeInfo,
): Envelope {
  return {
    ref: {
      provider: id,
      account,
      mailbox: mailboxPath,
      uidValidity,
      uid: info.uid,
    },
    from: info.from,
    to: info.to,
    subject: info.subject,
    date: info.internalDate ? info.internalDate.toISOString() : null,
    size: info.size,
    hasAttachments: info.hasAttachments,
    flags: info.flags,
  };
}

async function imapCapabilities(
  port: ImapPort,
  id: ImapProviderId,
): Promise<Capabilities> {
  return withImapSession(port, async (session) => {
    if (!session.capabilities) throw unsupported(id, "capabilities");
    return {
      ...session.capabilities(),
      // The server may advertise IDLE, but createImapProvider doesn't
      // implement watch() yet — never claim a capability calling it would
      // hit a missing method instead of a typed error.
      idle: false,
    };
  });
}

async function imapListMailboxes(
  port: ImapPort,
  id: ImapProviderId,
): Promise<Mailbox[]> {
  return withImapSession(port, async (session) => {
    if (!session.listMailboxes) throw unsupported(id, "listMailboxes");
    return session.listMailboxes();
  });
}

// A cursor names a uid *scoped to the UIDVALIDITY that issued it* — without
// that, a cursor spanning a mailbox recreation (UIDVALIDITY bump) between
// pages would silently reinterpret its uid against the new mailbox and skip
// everything at or above it. A garbage cursor must fail loud too, not
// silently read as NaN and turn into an empty "pagination ended" page.
function parseCursor(
  cursor: string | undefined,
): { uidValidity: string; uid: number } | undefined {
  if (cursor === undefined) return undefined;
  const [uidValidity, uidPart] = cursor.split(":");
  // Number("") is 0, not NaN — reject it explicitly rather than treating an
  // empty part as a valid uid.
  const uid =
    uidPart === "" || uidPart === undefined ? Number.NaN : Number(uidPart);
  // IMAP UIDs start at 1: a cursor of 0 isn't "the start of the mailbox", it
  // is garbage that would make listBefore(0, …) return an empty page and
  // look like pagination legitimately ended.
  if (!uidValidity || !Number.isInteger(uid) || uid < 1) {
    throw new Error(`invalid list() cursor: "${cursor}"`);
  }
  return { uidValidity, uid };
}

// Newest-first bounded page over one mailbox; cursor is `uidValidity:uid` for
// the lowest message returned so far, so the next call continues below it
// and can detect a mailbox recreated in between.
async function imapList(
  port: ImapPort,
  id: ImapProviderId,
  account: string,
  mailboxPath: string,
  cursor: string | undefined,
): Promise<Page<Envelope>> {
  const parsed = parseCursor(cursor);
  return withImapMailbox(port, mailboxPath, {}, async (mailbox) => {
    if (!mailbox.listBefore) throw unsupported(id, "list");
    if (parsed && parsed.uidValidity !== mailbox.uidValidity) {
      throw new Error(
        `stale list() cursor: issued for UIDVALIDITY ${parsed.uidValidity}, ` +
          `mailbox ${mailboxPath} is now at ${mailbox.uidValidity}`,
      );
    }
    const window = await mailbox.listBefore(parsed?.uid, LIST_PAGE_LIMIT);
    const items = window.messages.map((info) =>
      toEnvelope(id, account, mailboxPath, mailbox.uidValidity, info),
    );
    const last = window.messages[window.messages.length - 1];
    // Prefer the lowest returned message's uid (tighter — a window that had
    // more than `limit` hits gets revisited from exactly the right spot);
    // fall back to the scan boundary when the page came back empty (a
    // window-budget cap can stop the scan before finding anything), so an
    // empty-but-truncated page never collapses into "pagination ended".
    const nextUid = last?.uid ?? window.nextBeforeUid;
    return {
      items,
      cursor: window.truncated
        ? `${mailbox.uidValidity}:${nextUid}`
        : undefined,
    };
  });
}

function toMessageAttachments(
  attachments: Email["attachments"],
): MessageAttachment[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.mimeType,
    size:
      typeof attachment.content === "string"
        ? Buffer.byteLength(attachment.content)
        : attachment.content.byteLength,
  }));
}

async function parseImapSource(
  ref: MessageRef,
  raw: Uint8Array,
): Promise<Message> {
  const parsed = await PostalMime.parse(raw);
  const attachments = toMessageAttachments(parsed.attachments);
  const cc = addressList(parsed.cc);
  return {
    ref,
    from: parsed.from?.address ?? "",
    to: addressList(parsed.to),
    ...(cc.length > 0 ? { cc } : {}),
    subject: parsed.subject ?? "",
    // parsed.date is postal-mime's raw, unvalidated Date header — go through
    // the same validDate() gate list()/toEnvelope() use, so a malformed
    // header becomes null instead of flowing through as garbage.
    date: validDate(parsed.date)?.toISOString() ?? null,
    size: raw.byteLength,
    hasAttachments: attachments.length > 0,
    // Flags live on the IMAP server, not in the RFC822 source this parses —
    // fetchSources() doesn't fetch them. list()'s Envelope has them (a
    // FETCH ... FLAGS already happens there); read() would need its own
    // FETCH ... FLAGS to fill this in, not yet wired.
    flags: [],
    html: parsed.html ?? null,
    text: parsed.text ?? null,
    attachments,
  };
}

async function imapRead(
  port: ImapPort,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
): Promise<Message> {
  assertOwnProvider(id, account, ref);
  return withImapMailbox(port, ref.mailbox, {}, async (mailbox) => {
    assertFreshRef(ref, mailbox.uidValidity);
    const sources = await mailbox.fetchSources([ref.uid]);
    const raw = sources.get(ref.uid);
    if (!raw) throw new Error(`uid ${ref.uid} not found in ${ref.mailbox}`);
    return parseImapSource(ref, raw);
  });
}

async function imapSearch(
  port: ImapPort,
  id: ImapProviderId,
  account: string,
  query: SearchQuery,
): Promise<MessageRef[]> {
  const mailboxPath = query.mailbox ?? "INBOX";
  return withImapMailbox(port, mailboxPath, {}, async (mailbox) => {
    if (!mailbox.search) throw unsupported(id, "search");
    const uids = await mailbox.search(query);
    return uids.map((uid) => ({
      provider: id,
      account,
      mailbox: mailboxPath,
      uidValidity: mailbox.uidValidity,
      uid,
    }));
  });
}

async function imapSetFlags(
  port: ImapPort,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
  flags: FlagChange,
): Promise<void> {
  assertOwnProvider(id, account, ref);
  return withImapMailbox(
    port,
    ref.mailbox,
    { readOnly: false },
    async (mailbox) => {
      assertFreshRef(ref, mailbox.uidValidity);
      if (!mailbox.setFlags) throw unsupported(id, "setFlags");
      await mailbox.setFlags(ref.uid, flags);
    },
  );
}

async function imapMove(
  port: ImapPort,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
  toMailbox: string,
): Promise<MessageRef> {
  assertOwnProvider(id, account, ref);
  return withImapMailbox(
    port,
    ref.mailbox,
    { readOnly: false },
    async (mailbox) => {
      assertFreshRef(ref, mailbox.uidValidity);
      if (!mailbox.move) throw unsupported(id, "move");
      const moved = await mailbox.move(ref.uid, toMailbox);
      if (!moved) {
        throw new Error(`move of uid ${ref.uid} to ${toMailbox} failed`);
      }
      if (moved.uid === null || moved.uidValidity === null) {
        throw new Error(
          `move of uid ${ref.uid} to ${toMailbox} succeeded, but the server ` +
            "reported no destination UID/UIDVALIDITY (no UIDPLUS) — refusing " +
            "to build a ref that might target the wrong message",
        );
      }
      return {
        provider: id,
        account,
        mailbox: toMailbox,
        uidValidity: moved.uidValidity,
        uid: moved.uid,
      };
    },
  );
}

export function createImapProvider(
  config: ImapConfig,
  {
    id,
    account,
    port = createImapflowPort(config),
  }: { id: ImapProviderId; account: string; port?: ImapPort },
): MailProvider {
  return {
    id,
    account,
    capabilities: () => imapCapabilities(port, id),
    listMailboxes: () => imapListMailboxes(port, id),
    list: (mailboxPath, cursor) =>
      imapList(port, id, account, mailboxPath, cursor),
    read: (ref) => imapRead(port, id, account, ref),
    search: (query) => imapSearch(port, id, account, query),
    setFlags: (ref, flags) => imapSetFlags(port, id, account, ref, flags),
    move: (ref, toMailbox) => imapMove(port, id, account, ref, toMailbox),
    async send() {
      throw unsupported(id, "send");
    },
    // watch() (IDLE) is left unimplemented: `disableAutoIdle: true` in
    // adapter.ts is deliberate (a batch-fetching sync tick must never block
    // in IDLE), so a real implementation needs its own connection lifecycle.
    // Wave 4 wires this against a live Bridge/Gmail connection, where the
    // idle/event interplay can actually be verified.
  };
}
