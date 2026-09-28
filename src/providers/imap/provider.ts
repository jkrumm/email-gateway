import PostalMime, { type Email } from "postal-mime";
import { addressList } from "./address";
import { validDate } from "../../utils/date";
import type {
  Capabilities,
  Envelope,
  FlagChange,
  ListOptions,
  Mailbox,
  MailProvider,
  Message,
  MessageAttachment,
  MessageRef,
  Page,
  ProviderId,
  SearchQuery,
  Unsubscribe,
} from "../port";
import { unsupported } from "../port";
import {
  createIdleClient as createIdleClientFromAdapter,
  createImapflowPort,
  type ImapConfig,
  type ImapEnvelopeInfo,
  type ImapIdleClient,
  type ImapPort,
  type ImapSession,
} from "./adapter";

// The two IMAP-backed provider ids; Resend has its own adapter. Derived from
// port.ts's ProviderId so a new provider id can't drift out of sync here.
export type ImapProviderId = Exclude<ProviderId, "resend">;

const LIST_PAGE_LIMIT = 500;

// No calls into a pooled provider instance for this long closes its
// connection, freeing the slot against Bridge's connection limit; the next
// call reconnects. Overridable per instance (tests use a short window).
const DEFAULT_POOL_IDLE_MS = 5 * 60 * 1000;

type MailboxHandle = Awaited<ReturnType<ImapSession["openMailbox"]>>;

interface PooledSession {
  session: ImapSession;
  mailboxPath: string | null;
  readOnly: boolean | null;
  mailboxHandle: MailboxHandle | null;
}

// A dead connection (closed socket, protocol error) is retried once against
// a freshly opened session; an application-level error (message not found,
// an unsupported operation) never is. `isUsable` is how the two are told
// apart — see adapter.ts's ImapSession.isUsable.
function isUsable(session: ImapSession): boolean {
  return session.isUsable ? session.isUsable() : true;
}

// Reused per `createImapProvider` instance: one IMAP connection, serialized
// so concurrent calls into the same provider never race commands down one
// socket, reopening the mailbox only when the call needs a different one
// (or a different SELECT/EXAMINE mode) than what's currently open, and
// idle-closing after `idleCloseMs` with no calls. Kept entirely separate from
// watch()'s own dedicated long-lived IDLE connection below.
function createSessionPool(port: ImapPort, idleCloseMs: number) {
  let pooled: PooledSession | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Concurrent calls chain through this instead of racing multiple commands
  // down one connection; an operation's own failure never stalls the next
  // one queued behind it.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    tail = tail.then(
      () => op(),
      () => op(),
    );
    return tail as Promise<T>;
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function resetIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void invalidate();
    }, idleCloseMs);
    idleTimer.unref();
  }

  async function invalidate(): Promise<void> {
    const current = pooled;
    pooled = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!current) return;
    if (current.mailboxHandle) {
      try {
        current.mailboxHandle.release();
      } catch {
        // best-effort: releasing a lock on a connection we're discarding
        // anyway must never mask the real failure that triggered this.
      }
    }
    try {
      await current.session.close();
    } catch {
      // the connection is already presumed dead.
    }
  }

  async function ensureSession(): Promise<ImapSession> {
    if (pooled) return pooled.session;
    const session = await port.connect();
    pooled = {
      session,
      mailboxPath: null,
      readOnly: null,
      mailboxHandle: null,
    };
    return session;
  }

  // Cache-check-and-open against an already-resolved session, factored out of
  // ensureMailbox() so runWithMailbox() below can run it *inside* its own
  // try/catch — a session that died between calls (not mid-fn) must hit the
  // same dead-connection retry path (see PLAN.md Wave 4 review round 2, bug 3).
  async function openMailboxOn(
    session: ImapSession,
    path: string,
    readOnly: boolean,
  ): Promise<MailboxHandle> {
    const state = pooled;
    /* v8 ignore next */
    if (!state)
      throw new Error("imap session pool: session lost after connect");
    if (
      state.mailboxPath === path &&
      state.readOnly === readOnly &&
      state.mailboxHandle
    ) {
      return state.mailboxHandle;
    }
    if (state.mailboxHandle) {
      try {
        state.mailboxHandle.release();
      } catch {
        // best-effort: replacing this mailbox handle anyway.
      }
    }
    const mailbox = await session.openMailbox(path, { readOnly });
    state.mailboxPath = path;
    state.readOnly = readOnly;
    state.mailboxHandle = mailbox;
    return mailbox;
  }

  async function ensureMailbox(
    path: string,
    readOnly: boolean,
  ): Promise<{ session: ImapSession; mailbox: MailboxHandle }> {
    const session = await ensureSession();
    const mailbox = await openMailboxOn(session, path, readOnly);
    return { session, mailbox };
  }

  // The idle-close timer is armed only in the `finally` below, after `fn`
  // settles — arming it up front would let it fire mid-operation on a call
  // that outlasts `idleCloseMs` and invalidate a perfectly healthy, still
  // in-flight session (see PLAN.md Wave 4 review, bug 2).
  async function runWithSession<T>(
    fn: (session: ImapSession) => Promise<T>,
  ): Promise<T> {
    const session = await ensureSession();
    clearIdleTimer();
    try {
      return await fn(session);
    } catch (error) {
      if (isUsable(session)) throw error;
      await invalidate();
      const fresh = await ensureSession();
      return await fn(fresh);
    } finally {
      resetIdleTimer();
    }
  }

  async function runWithMailbox<T>(
    path: string,
    readOnly: boolean,
    fn: (mailbox: MailboxHandle) => Promise<T>,
  ): Promise<T> {
    const session = await ensureSession();
    clearIdleTimer();
    try {
      // Opening the mailbox lives inside this try too — a pooled session that
      // died between the previous call and this one fails right here (not
      // inside fn), and must hit the same dead-connection retry below rather
      // than bypass it and leave the dead session cached for every
      // subsequent call.
      const mailbox = await openMailboxOn(session, path, readOnly);
      return await fn(mailbox);
    } catch (error) {
      if (isUsable(session)) throw error;
      // A dead connection after a mutating command (setFlags/move, readOnly
      // === false) leaves the outcome unknown — the server may have already
      // applied it before the socket dropped. Replaying it here could
      // double-apply a STORE/MOVE, so only invalidate the dead session (the
      // *next*, unrelated call gets a fresh one) and let the original error
      // propagate instead of retrying. Read-only calls stay idempotent to
      // retry, unchanged.
      if (!readOnly) {
        await invalidate();
        throw error;
      }
      await invalidate();
      const fresh = await ensureMailbox(path, readOnly);
      return await fn(fresh.mailbox);
    } finally {
      resetIdleTimer();
    }
  }

  return {
    withSession: <T>(fn: (session: ImapSession) => Promise<T>): Promise<T> =>
      enqueue(() => runWithSession(fn)),
    withMailbox: <T>(
      path: string,
      options: { readOnly?: boolean },
      fn: (mailbox: MailboxHandle) => Promise<T>,
    ): Promise<T> =>
      enqueue(() => runWithMailbox(path, options.readOnly ?? true, fn)),
  };
}

type SessionPool = ReturnType<typeof createSessionPool>;

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
    // X-GM-THRID (Gmail) when the server advertised it; absent for Bridge.
    ...(info.threadKey ? { threadKey: info.threadKey } : {}),
  };
}

async function imapCapabilities(
  pool: SessionPool,
  id: ImapProviderId,
): Promise<Capabilities> {
  return pool.withSession(async (session) => {
    if (!session.capabilities) throw unsupported(id, "capabilities");
    // watch() now exists, so idle reflects exactly what the low-level
    // session derived from the server's real CAPABILITY response — never
    // hardcoded here.
    return session.capabilities();
  });
}

async function imapListMailboxes(
  pool: SessionPool,
  id: ImapProviderId,
): Promise<Mailbox[]> {
  return pool.withSession(async (session) => {
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

// modseqByMailbox is keyed by `${mailboxPath}:${uidValidity}`, not the bare
// path: a recreated mailbox (a Gmail label rebuild) resets the server's
// modseq counter, and a bookmark issued under the old UIDVALIDITY read
// against the new one would report "nothing changed" — silently and
// permanently, since a CONDSTORE server never errors on a modseq that just
// happens to be higher than anything it currently has. Scoping the key by
// UIDVALIDITY makes a recreation look like "no bookmark yet" instead.
function modseqKey(mailboxPath: string, uidValidity: string): string {
  return `${mailboxPath}:${uidValidity}`;
}

// Drops every OTHER modseqKey entry for this mailbox path — called only when
// bootstrapping a fresh bookmark under a new UIDVALIDITY, so any entry that
// doesn't match `keep` is provably from a superseded (recreated) incarnation
// of this same mailbox and will never be read again. Without this, a
// long-lived process accumulates one dead entry per recreation, forever.
function pruneStaleModseqKeys(
  modseqByMailbox: Map<string, bigint>,
  mailboxPath: string,
  keep: string,
): void {
  const prefix = `${mailboxPath}:`;
  for (const key of modseqByMailbox.keys()) {
    if (key !== keep && key.startsWith(prefix)) {
      modseqByMailbox.delete(key);
    }
  }
}

interface ImapListContext {
  id: ImapProviderId;
  account: string;
  mailboxPath: string;
  mailbox: MailboxHandle;
  bookmarked: bigint | undefined;
  modseqByMailbox: Map<string, bigint>;
}

// The changedSince fast path for imapList's plain head call (no cursor, once
// a previous full scan left a modseq bookmark): one FETCH returns everything
// that changed since, instead of re-listing the newest UID window every tick.
// Returns undefined (fall through to the full scan) when the mailbox has no
// bookmark yet, the server has no CONDSTORE, the changed set doesn't fit one
// page (truncated changed-set can't paginate by modseq alone without risking
// a skip), or the caller passed `skipFastPath: true` — its result's
// `cursor` is always `undefined`, which the caller can't tell apart from a
// genuine "nothing older than this page" (see ListOptions.skipFastPath).
async function imapListChangedSince(
  ctx: ImapListContext,
): Promise<Page<Envelope> | undefined> {
  const { id, account, mailboxPath, mailbox, bookmarked, modseqByMailbox } =
    ctx;
  if (bookmarked === undefined || !mailbox.listChangedSince) return undefined;

  const changed = await mailbox.listChangedSince(bookmarked, LIST_PAGE_LIMIT);
  if (changed.truncated) {
    // Silent otherwise: the bookmark correctly stays put (never advances
    // past what fit), so every subsequent tick retries the identical
    // changedSince call and truncates again — a mailbox can get stuck this
    // way indefinitely (a bulk operation touching more than one page's
    // worth of messages). Worth a line so it shows up as a real signal
    // rather than looking like a quiet, permanently degraded sync.
    console.error(
      `[imap] ${mailboxPath} has more CONDSTORE changes than fit one page ` +
        `(limit ${LIST_PAGE_LIMIT}); falling back to a full scan this tick`,
    );
    return undefined;
  }

  if (changed.highestModseq > bookmarked) {
    modseqByMailbox.set(
      modseqKey(mailboxPath, mailbox.uidValidity),
      changed.highestModseq,
    );
  }
  return {
    items: changed.messages.map((info) =>
      toEnvelope(id, account, mailboxPath, mailbox.uidValidity, info),
    ),
    cursor: undefined,
  };
}

// Whether a bookmark actually exists is tracked separately from the
// `bookmarked` value imapListChangedSince gets to use: `skipFastPath` must
// suppress *using* an existing bookmark without making the bootstrap guard
// in bootstrapBookmarkIfColdStart below believe none exists — those are
// different facts, and conflating them (reading "existing" off the same,
// option-suppressed value) previously let a forced full scan re-seed an
// already-precise bookmark with a coarser one that a UID-window scan's
// limited results don't actually back up.
interface BookmarkLookup {
  modseqKeyForMailbox: string;
  hasExistingBookmark: boolean;
  bookmarked: bigint | undefined;
}

function resolveBookmark(
  mailboxPath: string,
  mailbox: MailboxHandle,
  parsed: ReturnType<typeof parseCursor>,
  modseqByMailbox: Map<string, bigint>,
  options: ListOptions | undefined,
): BookmarkLookup {
  const modseqKeyForMailbox = modseqKey(mailboxPath, mailbox.uidValidity);
  const hasExistingBookmark =
    parsed === undefined && modseqByMailbox.has(modseqKeyForMailbox);
  const bookmarked =
    hasExistingBookmark && !options?.skipFastPath
      ? modseqByMailbox.get(modseqKeyForMailbox)
      : undefined;
  return { modseqKeyForMailbox, hasExistingBookmark, bookmarked };
}

// A full head scan only bootstraps the bookmark on a true cold start — no
// prior bookmark for this mailbox+UIDVALIDITY (checked directly against the
// map by resolveBookmark above, not the possibly skipFastPath-suppressed
// `bookmarked` value). A call that already had one but landed here anyway
// (the fast path's changed set didn't fit one page, or the caller explicitly
// asked to skip it) must NOT re-bookmark: this UID-window scan covers only
// the newest page, not the whole changed set the server reported, so
// advancing the bookmark past it would drop whatever fell outside this
// window forever instead of retrying it next tick.
function bootstrapBookmarkIfColdStart(
  lookup: BookmarkLookup,
  mailboxPath: string,
  mailbox: MailboxHandle,
  parsed: ReturnType<typeof parseCursor>,
  modseqByMailbox: Map<string, bigint>,
): void {
  if (
    parsed !== undefined ||
    lookup.hasExistingBookmark ||
    mailbox.highestModseq === undefined
  ) {
    return;
  }
  // A bootstrap under a new UIDVALIDITY (mailbox recreation) is the one
  // moment this mailbox's OLD key is known to be dead — prune it so a
  // long-lived process doesn't accumulate one stale entry per recreation
  // forever.
  pruneStaleModseqKeys(
    modseqByMailbox,
    mailboxPath,
    lookup.modseqKeyForMailbox,
  );
  modseqByMailbox.set(lookup.modseqKeyForMailbox, mailbox.highestModseq);
}

// Newest-first bounded page over one mailbox; cursor is `uidValidity:uid` for
// the lowest message returned so far, so the next call continues below it
// and can detect a mailbox recreated in between. A plain head call (no
// cursor) tries the CONDSTORE fast path above first, unless the caller asked
// to skip it — see imapListChangedSince's own comment for both.
async function imapList(
  pool: SessionPool,
  id: ImapProviderId,
  account: string,
  mailboxPath: string,
  cursor: string | undefined,
  modseqByMailbox: Map<string, bigint>,
  options: ListOptions | undefined,
): Promise<Page<Envelope>> {
  const parsed = parseCursor(cursor);
  return pool.withMailbox(mailboxPath, {}, async (mailbox) => {
    if (!mailbox.listBefore) throw unsupported(id, "list");

    const lookup = resolveBookmark(
      mailboxPath,
      mailbox,
      parsed,
      modseqByMailbox,
      options,
    );
    const fastPath = await imapListChangedSince({
      id,
      account,
      mailboxPath,
      mailbox,
      bookmarked: lookup.bookmarked,
      modseqByMailbox,
    });
    if (fastPath) return fastPath;

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
    bootstrapBookmarkIfColdStart(
      lookup,
      mailboxPath,
      mailbox,
      parsed,
      modseqByMailbox,
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
  pool: SessionPool,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
): Promise<Message> {
  assertOwnProvider(id, account, ref);
  return pool.withMailbox(ref.mailbox, {}, async (mailbox) => {
    assertFreshRef(ref, mailbox.uidValidity);
    const sources = await mailbox.fetchSources([ref.uid]);
    const raw = sources.get(ref.uid);
    if (!raw) throw new Error(`uid ${ref.uid} not found in ${ref.mailbox}`);
    return parseImapSource(ref, raw);
  });
}

async function imapSearch(
  pool: SessionPool,
  id: ImapProviderId,
  account: string,
  query: SearchQuery,
): Promise<MessageRef[]> {
  const mailboxPath = query.mailbox ?? "INBOX";
  return pool.withMailbox(mailboxPath, {}, async (mailbox) => {
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
  pool: SessionPool,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
  flags: FlagChange,
): Promise<void> {
  assertOwnProvider(id, account, ref);
  return pool.withMailbox(ref.mailbox, { readOnly: false }, async (mailbox) => {
    assertFreshRef(ref, mailbox.uidValidity);
    if (!mailbox.setFlags) throw unsupported(id, "setFlags");
    await mailbox.setFlags(ref.uid, flags);
  });
}

async function imapMove(
  pool: SessionPool,
  id: ImapProviderId,
  account: string,
  ref: MessageRef,
  toMailbox: string,
): Promise<MessageRef> {
  assertOwnProvider(id, account, ref);
  return pool.withMailbox(ref.mailbox, { readOnly: false }, async (mailbox) => {
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
  });
}

// Reconnect backoff for watch()'s dedicated connection: same shape as
// src/db/jobs.ts's backoff jitter (base + up to 20% jitter), doubled each
// attempt up to a 5-minute cap, reset to the floor on every successful
// reconnect.
const IDLE_RECONNECT_INITIAL_MS = 5_000;
const IDLE_RECONNECT_MAX_MS = 5 * 60 * 1000;
const IDLE_RECONNECT_JITTER_RATIO = 0.2;

function idleReconnectDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(
    IDLE_RECONNECT_INITIAL_MS * 2 ** attempt,
    IDLE_RECONNECT_MAX_MS,
  );
  return base + Math.floor(random() * base * IDLE_RECONNECT_JITTER_RATIO);
}

function defaultIdleReconnectWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// watch()'s own dedicated connection, deliberately separate from the pooled
// session above: IDLE blocks the connection for any other command until it
// ends, so it can never share a socket with list()/read()/etc.
async function imapWatch(
  config: ImapConfig,
  mailboxPath: string,
  onChange: () => void,
  {
    createIdleClient = createIdleClientFromAdapter,
    wait = defaultIdleReconnectWait,
    random = Math.random,
  }: {
    createIdleClient?: (config: ImapConfig) => ImapIdleClient;
    wait?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<Unsubscribe> {
  let stopped = false;
  let client: ImapIdleClient | null = null;
  let attempt = 0;
  // A dropped connection fires both the idle loop's rejected idle() and the
  // client's own 'close'/'error' events — guard against starting two
  // concurrent reconnect loops for the same drop.
  let reconnecting = false;
  // Only true once a connectAndIdle() has actually finished connecting and
  // opening the mailbox. Until then, handleDrop() must stay inert: the very
  // first connect (or its mailboxOpen) failing already rejects watch()'s own
  // promise via the `await connectAndIdle()` below, and its caller has no
  // Unsubscribe yet to ever stop a reconnect loop — without this guard a bad
  // first connection would retry forever in the background.
  let everConnected = false;

  function handleDrop(): void {
    if (stopped || reconnecting || !everConnected) return;
    reconnecting = true;
    void reconnectLoop();
  }

  // Stable references so detachListeners() below can remove exactly these
  // listeners later via off(event, listener) — an anonymous arrow passed to
  // on() can never be un-registered by reference.
  const handleChange = (): void => onChange();

  function attachListeners(current: ImapIdleClient): void {
    current.on("exists", handleChange);
    current.on("expunge", handleChange);
    current.on("flags", handleChange);
    current.on("close", handleDrop);
    current.on("error", handleDrop);
  }

  // Removes only the listeners attachListeners() added above, scoped by both
  // event and exact function reference — never the bare, no-argument
  // removeAllListeners(). adapter.ts's createIdleClient attaches its own
  // 'error' listener directly to the socket specifically so an emitted
  // socket error can't crash the process (an EventEmitter with zero 'error'
  // listeners rethrows synchronously). Stripping it here, right before
  // discarding a client that's dying/dead, would leave nothing listening for
  // a late error the socket routinely still emits during teardown (see
  // PLAN.md Wave 4 review round 2, bug 1).
  function detachListeners(current: ImapIdleClient): void {
    current.off("exists", handleChange);
    current.off("expunge", handleChange);
    current.off("flags", handleChange);
    current.off("close", handleDrop);
    current.off("error", handleDrop);
  }

  async function idleLoop(current: ImapIdleClient): Promise<void> {
    try {
      // idle() resolves when IDLE ends (RFC's ~29-minute cap, or another
      // command interrupting it) — re-enter it to keep watching.
      while (!stopped && client === current) {
        await current.idle();
      }
    } catch (error) {
      // A reconnect may already have swapped `client` to a new connection by
      // the time this *stale* connection's pending idle() finally rejects
      // (its socket was torn down already, just slow to report it). That
      // drop belongs to a connection already superseded — treating it as
      // fresh here would start a second reconnect loop and tear down the
      // just-established replacement (see PLAN.md Wave 4 review round 2,
      // bug 2).
      if (client !== current) return;
      console.error("[imap] watch idle loop failed", { mailboxPath, error });
      handleDrop();
    }
  }

  async function connectAndIdle(): Promise<void> {
    // Detach and close the outgoing client (if any) before the new one ever
    // connects: left listening, a late close/error on it would fire
    // handleDrop() again and start a second, redundant reconnect once this
    // one succeeds and resets `reconnecting` — plus it leaks the connection
    // on Bridge's side.
    const previous = client;
    const current = createIdleClient(config);
    client = current;
    if (previous) {
      detachListeners(previous);
      previous.logout().catch(() => {
        // the socket may already be dead.
      });
    }
    attachListeners(current);
    try {
      await current.connect();
      await current.mailboxOpen(mailboxPath, { readOnly: true });
    } catch (error) {
      detachListeners(current);
      if (client === current) client = null;
      try {
        current.close();
      } catch {
        // the socket may already be dead.
      }
      throw error;
    }
    everConnected = true;
    attempt = 0;
    reconnecting = false;
    void idleLoop(current);
  }

  async function reconnectLoop(): Promise<void> {
    if (stopped) return;
    const delay = idleReconnectDelayMs(attempt, random);
    attempt++;
    console.error("[imap] watch connection dropped, reconnecting", {
      mailboxPath,
      delayMs: delay,
    });
    await wait(delay);
    if (stopped) return;
    try {
      await connectAndIdle();
    } catch (error) {
      console.error("[imap] watch reconnect failed", { mailboxPath, error });
      void reconnectLoop();
    }
  }

  await connectAndIdle();

  return () => {
    stopped = true;
    const current = client;
    client = null;
    if (!current) return;
    detachListeners(current);
    current.logout().catch(() => {
      // the socket may already be dead.
    });
  };
}

export function createImapProvider(
  config: ImapConfig,
  {
    id,
    account,
    port = createImapflowPort(config),
    poolIdleMs = DEFAULT_POOL_IDLE_MS,
    createIdleClient,
    idleReconnectWait,
    idleReconnectRandom,
  }: {
    id: ImapProviderId;
    account: string;
    port?: ImapPort;
    poolIdleMs?: number;
    // watch()-only overrides, for tests: its dedicated connection never
    // touches the session pool above.
    createIdleClient?: (config: ImapConfig) => ImapIdleClient;
    idleReconnectWait?: (ms: number) => Promise<void>;
    idleReconnectRandom?: () => number;
  },
): MailProvider {
  const pool = createSessionPool(port, poolIdleMs);
  // CONDSTORE bookmarks are process-local: a restart just costs one full head
  // scan per mailbox and re-bootstraps the bookmark. Never persisted, so a
  // stale bookmark can't survive a mailbox recreation either.
  const modseqByMailbox = new Map<string, bigint>();
  return {
    id,
    account,
    capabilities: () => imapCapabilities(pool, id),
    listMailboxes: () => imapListMailboxes(pool, id),
    list: (mailboxPath, cursor, options) =>
      imapList(
        pool,
        id,
        account,
        mailboxPath,
        cursor,
        modseqByMailbox,
        options,
      ),
    read: (ref) => imapRead(pool, id, account, ref),
    search: (query) => imapSearch(pool, id, account, query),
    setFlags: (ref, flags) => imapSetFlags(pool, id, account, ref, flags),
    move: (ref, toMailbox) => imapMove(pool, id, account, ref, toMailbox),
    async send() {
      throw unsupported(id, "send");
    },
    watch: (mailboxPath, onChange) =>
      imapWatch(config, mailboxPath, onChange, {
        createIdleClient,
        wait: idleReconnectWait,
        random: idleReconnectRandom,
      }),
  };
}
