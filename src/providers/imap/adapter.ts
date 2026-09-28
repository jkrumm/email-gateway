import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { Capabilities, FlagChange, Mailbox, SearchQuery } from "../port";
import { validDate } from "../../utils/date";
import { normalizePem } from "../../utils/pem";
import { addressList } from "./address";

// Low-level session/mailbox shape the sync algorithm (src/sync/imap-sync.ts)
// consumes directly: bounded UID-window listing, batched raw-source fetches,
// oversized-message headers-only reads. This stays read-only by default and
// its behaviour is unchanged from the original src/sync/imap-port.ts. The
// generic MailProvider wrapper built on top of it lives in ./provider.ts.
export interface ImapMessageInfo {
  uid: number;
  // Null when the server did not report a size; treated as oversized.
  size: number | null;
  internalDate: Date | null;
}

export interface ImapListing {
  messages: ImapMessageInfo[];
  // True when more messages exist beyond `messages` (limit reached).
  truncated: boolean;
}

// listBefore's richer per-message shape — envelope fields ./provider.ts's
// Envelope needs that the sync algorithm's listAfter has no use for.
export interface ImapEnvelopeInfo extends ImapMessageInfo {
  from: string;
  to: string[];
  subject: string;
  hasAttachments: boolean;
  flags: string[];
}

export interface ImapEnvelopeListing {
  messages: ImapEnvelopeInfo[];
  truncated: boolean;
  // The scan boundary reached (not the lowest returned message's uid, which
  // is tighter when `messages` is non-empty — see provider.ts's imapList).
  // Only meaningful, and only needed, when `messages` is empty and
  // `truncated` is true: a window-budget cap can stop the scan before
  // finding anything, and a cursor built from the last message alone can't
  // express "keep going" in that case.
  nextBeforeUid: number;
}

export interface ImapMoveResult {
  // Both null when the move succeeded but this particular response's COPYUID
  // data didn't include a uid/UIDVALIDITY for it (makeMove already refuses
  // to call messageMove at all when the server lacks MOVE+UIDPLUS, so this
  // isn't that case) — the caller must not build a ref off data it doesn't
  // actually have. Distinct from the command failing outright, which this
  // function reports as `null` (see makeMove).
  uid: number | null;
  uidValidity: string | null;
}

export interface ImapMailbox {
  uidValidity: string;
  // Up to `limit` messages with uid > afterUid, ascending. Only a bounded UID
  // window is queried per round trip, so a large backlog is never listed at
  // once.
  listAfter(afterUid: number, limit: number): Promise<ImapListing>;
  // Up to `limit` messages with uid < beforeUid (or the newest messages when
  // omitted), descending — the newest-first page the generic port serves.
  // Optional: the sync algorithm above never calls it, only ./provider.ts.
  listBefore?(
    beforeUid: number | undefined,
    limit: number,
  ): Promise<ImapEnvelopeListing>;
  // Full RFC 822 sources; a uid the server did not return is absent.
  fetchSources(uids: number[]): Promise<Map<number, Uint8Array>>;
  fetchHeaders(uid: number): Promise<Uint8Array | null>;
  // Which of these uids currently exist in the mailbox.
  existingUids(uids: number[]): Promise<Set<number>>;
  // Present only when opened with { readOnly: false } (SELECT, not EXAMINE) —
  // a STORE/MOVE against an EXAMINE-opened mailbox is a live protocol error,
  // not just a typed one, so these are omitted rather than merely gated.
  setFlags?(uid: number, flags: FlagChange): Promise<void>;
  move?(uid: number, toMailbox: string): Promise<ImapMoveResult | null>;
  // SEARCH needs no write access, so it's on the handle regardless of readOnly.
  search?(query: Omit<SearchQuery, "mailbox">): Promise<number[]>;
  release(): void;
}

export interface ImapSession {
  // Optional: only ./provider.ts (the generic MailProvider wrapper) needs
  // these — the sync algorithm's fakes never implement them.
  capabilities?(): Capabilities;
  listMailboxes?(): Promise<Mailbox[]>;
  // Opens read-only (EXAMINE) unless a write is requested (SELECT) — a
  // mailbox never needs write access just to be listed or read.
  openMailbox(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<ImapMailbox>;
  close(): Promise<void>;
  // Optional: only ./provider.ts's session pool needs this, to tell a dead
  // connection (retry the operation against a freshly opened session) apart
  // from an application-level error (message not found, unsupported
  // operation — never retried). Real sessions report imapflow's own `usable`
  // flag; a fake that doesn't implement it is treated as always healthy.
  isUsable?(): boolean;
}

export interface ImapPort {
  connect(): Promise<ImapSession>;
}

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailboxes: string[];
  tlsCert?: string;
  tlsInsecure: boolean;
}

// The subset of ImapFlow the adapter uses, so tests can supply a fake.
export type ImapClient = Pick<
  ImapFlow,
  | "on"
  | "connect"
  | "logout"
  | "close"
  | "usable"
  | "mailbox"
  | "capabilities"
  | "list"
  | "getMailboxLock"
  | "fetchAll"
  | "fetchOne"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageFlagsSet"
  | "messageMove"
  | "search"
>;

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

// watch()'s dedicated connection needs more of the real client than the
// batch-fetch surface above: it opens a mailbox itself and sits in IDLE.
export type ImapIdleClient = Pick<
  ImapFlow,
  | "on"
  | "off"
  | "connect"
  | "logout"
  | "close"
  | "usable"
  | "mailboxOpen"
  | "idle"
>;

export type ImapIdleClientFactory = (
  options: ImapFlowOptions,
) => ImapIdleClient;

// Plain network timeouts (not an agent budget): a stalled Bridge must fail the
// tick instead of holding the sync lock forever.
export const CONNECTION_TIMEOUT_MS = 30_000;
export const GREETING_TIMEOUT_MS = 15_000;
export const SOCKET_TIMEOUT_MS = 60_000;

// One UID window per FETCH round trip while listing.
const LIST_WINDOW = 2_000;

export function tlsOptions(
  config: Pick<ImapConfig, "tlsCert" | "tlsInsecure">,
) {
  if (config.tlsCert) {
    const pem = normalizePem(config.tlsCert);
    // Pin the exact certificate: trust it as the only anchor AND require the
    // presented certificate to be that very one, so a CA certificate
    // configured by mistake can't vouch for anything else it signed.
    // Hostname matching is skipped: Bridge issues for localhost while we
    // connect over the tailnet.
    const pinned = new X509Certificate(pem).fingerprint256;
    return {
      ca: [pem],
      checkServerIdentity: (
        _host: string,
        cert: { fingerprint256?: string },
      ) =>
        cert.fingerprint256 === pinned
          ? undefined
          : new Error("IMAP server certificate does not match the pinned one"),
    };
  }
  if (config.tlsInsecure) return { rejectUnauthorized: false };
  return {};
}

// Declared from what the server actually advertised at connect time, per
// docs/architecture.md — never assumed from the provider id. LIST/FETCH/
// STORE/SEARCH are core IMAP4rev1 and always available; MOVE and IDLE are
// extensions Bridge and Gmail advertise differently.
function capabilitiesFromClient(client: ImapClient): Capabilities {
  return {
    list: true,
    read: true,
    search: true,
    flag: true,
    // MOVE without UIDPLUS still moves the message, but leaves no way to
    // report the destination uid/UIDVALIDITY — the message would already be
    // gone from the source mailbox by the time move() has to give up and
    // throw. Only advertise the capability when a caller can actually get a
    // usable ref back.
    move: client.capabilities.has("MOVE") && client.capabilities.has("UIDPLUS"),
    send: false,
    idle: client.capabilities.has("IDLE"),
  };
}

function toMailboxInfo(entry: {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string | undefined;
}): Mailbox {
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter,
    specialUse: entry.specialUse,
  };
}

type OpenedMailbox = { uidValidity: bigint; uidNext: number };
type FetchedMessage = Awaited<ReturnType<ImapClient["fetchAll"]>>[number];

function makeListAfter(client: ImapClient, mailbox: OpenedMailbox) {
  return async (afterUid: number, limit: number): Promise<ImapListing> => {
    const found: ImapMessageInfo[] = [];
    let start = afterUid + 1;

    // Explicit `a:b` ranges only return existing messages (unlike `N:*`,
    // which always yields the newest one), and UIDs may be sparse, so walk
    // windows up to UIDNEXT until `limit` is met.
    while (start < mailbox.uidNext && found.length <= limit) {
      const end = start + LIST_WINDOW - 1;
      const messages = await client.fetchAll(
        `${start}:${end}`,
        { uid: true, size: true, internalDate: true },
        { uid: true },
      );
      for (const message of messages) {
        if (message.uid <= afterUid) continue;
        found.push({
          uid: message.uid,
          size: message.size ?? null,
          internalDate: validDate(message.internalDate),
        });
      }
      start = end + 1;
    }

    found.sort((a, b) => a.uid - b.uid);
    return {
      messages: found.slice(0, limit),
      truncated: found.length > limit || start < mailbox.uidNext,
    };
  };
}

// A single-part message can itself be the attachment (no childNodes), not
// just have one nested under a multipart root.
function hasAttachment(
  bodyStructure: FetchedMessage["bodyStructure"],
): boolean {
  if (!bodyStructure) return false;
  if (bodyStructure.disposition === "attachment") return true;
  // An attachment can sit several multipart levels deep (e.g. multipart/
  // related nested inside multipart/mixed) — walk the whole tree, not just
  // the immediate children.
  return Boolean(bodyStructure.childNodes?.some((node) => hasAttachment(node)));
}

function toImapEnvelopeInfo(message: FetchedMessage): ImapEnvelopeInfo {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    size: message.size ?? null,
    internalDate: validDate(message.internalDate),
    from: envelope?.from?.[0]?.address ?? "",
    to: addressList(envelope?.to),
    subject: envelope?.subject ?? "",
    hasAttachments: hasAttachment(message.bodyStructure),
    flags: message.flags ? Array.from(message.flags) : [],
  };
}

// Bounds worst-case round trips per call: a sparse mailbox (many expunged
// UIDs) or a cursor far below any real message would otherwise walk every
// window down to UID 1 hunting for `limit` messages, with no budget. Capped
// here means fewer than `limit` messages on this page and `truncated: true`
// — the next call's cursor picks up exactly where this one stopped, so
// nothing is skipped, it just takes more (bounded) calls.
const MAX_LIST_WINDOWS = 20;

function makeListBefore(client: ImapClient, mailbox: OpenedMailbox) {
  return async (
    beforeUid: number | undefined,
    limit: number,
  ): Promise<ImapEnvelopeListing> => {
    const found: ImapEnvelopeInfo[] = [];
    const ceiling = beforeUid ?? mailbox.uidNext;
    let end = ceiling - 1;
    let windows = 0;

    while (end >= 1 && found.length <= limit && windows < MAX_LIST_WINDOWS) {
      windows++;
      const start = Math.max(1, end - LIST_WINDOW + 1);
      const messages = await client.fetchAll(
        `${start}:${end}`,
        {
          uid: true,
          size: true,
          internalDate: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      );
      for (const message of messages) {
        if (message.uid < ceiling) found.push(toImapEnvelopeInfo(message));
      }
      end = start - 1;
    }

    found.sort((a, b) => b.uid - a.uid);
    return {
      messages: found.slice(0, limit),
      truncated: found.length > limit || end >= 1,
      nextBeforeUid: end + 1,
    };
  };
}

function makeFetchSources(client: ImapClient) {
  return async (uids: number[]): Promise<Map<number, Uint8Array>> => {
    const sources = new Map<number, Uint8Array>();
    if (uids.length === 0) return sources;
    // source fetches use BODY.PEEK, so \Seen is never set.
    const messages = await client.fetchAll(
      uids,
      { uid: true, source: true },
      { uid: true },
    );
    for (const message of messages) {
      if (message.source) sources.set(message.uid, message.source);
    }
    return sources;
  };
}

function makeFetchHeaders(client: ImapClient) {
  return async (uid: number): Promise<Uint8Array | null> => {
    const message = await client.fetchOne(
      String(uid),
      { uid: true, headers: true },
      { uid: true },
    );
    return message ? (message.headers ?? null) : null;
  };
}

function makeExistingUids(client: ImapClient) {
  return async (uids: number[]): Promise<Set<number>> => {
    if (uids.length === 0) return new Set();
    const messages = await client.fetchAll(uids, { uid: true }, { uid: true });
    return new Set(messages.map((message) => message.uid));
  };
}

function makeSetFlags(client: ImapClient) {
  return async (uid: number, flags: FlagChange): Promise<void> => {
    const options = { uid: true };
    if (flags.set) await client.messageFlagsSet(uid, flags.set, options);
    if (flags.add) await client.messageFlagsAdd(uid, flags.add, options);
    if (flags.remove)
      await client.messageFlagsRemove(uid, flags.remove, options);
  };
}

function makeMove(client: ImapClient) {
  return async (
    uid: number,
    toMailbox: string,
  ): Promise<ImapMoveResult | null> => {
    // MOVE without UIDPLUS still relocates the message but gives no way to
    // name it in the destination; UIDPLUS without MOVE means the command
    // itself isn't there to call. Refuse before issuing anything, not after
    // it has already moved.
    if (
      !client.capabilities.has("MOVE") ||
      !client.capabilities.has("UIDPLUS")
    ) {
      throw new Error(
        "move refused: server needs both MOVE and UIDPLUS to move a " +
          "message and report its destination uid/UIDVALIDITY back",
      );
    }
    const result = await client.messageMove(uid, toMailbox, { uid: true });
    if (!result) return null;
    return {
      uid: result.uidMap?.get(uid) ?? null,
      uidValidity: result.uidValidity ? result.uidValidity.toString() : null,
    };
  };
}

function makeSearch(client: ImapClient) {
  return async (query: Omit<SearchQuery, "mailbox">): Promise<number[]> => {
    const result = await client.search(
      {
        ...(query.body ? { body: query.body } : {}),
        ...(query.text ? { text: query.text } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.since ? { since: query.since } : {}),
      },
      { uid: true },
    );
    return result ? Array.from(result) : [];
  };
}

function createMailboxHandle(
  client: ImapClient,
  mailbox: OpenedMailbox,
  lock: { release: () => void },
  readOnly: boolean,
): ImapMailbox {
  return {
    uidValidity: mailbox.uidValidity.toString(),
    listAfter: makeListAfter(client, mailbox),
    listBefore: makeListBefore(client, mailbox),
    fetchSources: makeFetchSources(client),
    fetchHeaders: makeFetchHeaders(client),
    existingUids: makeExistingUids(client),
    search: makeSearch(client),
    // Omitted (not just gated) on a read-only open: calling STORE/MOVE
    // against an EXAMINE-opened mailbox is a live IMAP protocol error, and an
    // absent method surfaces that as a typed error at the call site instead.
    ...(readOnly
      ? {}
      : { setFlags: makeSetFlags(client), move: makeMove(client) }),
    release: () => lock.release(),
  };
}

function buildClientOptions(
  config: ImapConfig,
  { disableAutoIdle = true }: { disableAutoIdle?: boolean } = {},
): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    // imapflow passes `servername: false` for an IP host, which Bun's TLS
    // upgrade rejects ("servername argument must be an string"). Bridge's
    // cert is issued for localhost/127.0.0.1 and SNI is ignored anyway.
    ...(isIP(config.host) ? { servername: "localhost" } : {}),
    secure: false,
    // Refuse to log in unless the connection was upgraded via STARTTLS.
    doSTARTTLS: true,
    auth: { user: config.user, pass: config.password },
    tls: tlsOptions(config),
    logger: false,
    disableAutoIdle,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

function makeClose(client: ImapClient) {
  return async () => {
    if (!client.usable) {
      client.close();
      return;
    }
    try {
      await client.logout();
    } catch {
      client.close();
    }
  };
}

function makeOpenMailbox(client: ImapClient) {
  return async (
    path: string,
    { readOnly = true }: { readOnly?: boolean } = {},
  ): Promise<ImapMailbox> => {
    const lock = await client.getMailboxLock(path, { readOnly });
    const mailbox = client.mailbox;
    if (!mailbox) {
      lock.release();
      throw new Error(`mailbox ${path} did not open`);
    }
    return createMailboxHandle(client, mailbox, lock, readOnly);
  };
}

export function createImapflowPort(
  config: ImapConfig,
  {
    createClient = (options) => new ImapFlow(options),
  }: { createClient?: ImapClientFactory } = {},
): ImapPort {
  return {
    async connect() {
      const client = createClient(buildClientOptions(config));
      // Without a listener an emitted socket error (including timeouts)
      // would crash the process.
      client.on("error", (error: unknown) => {
        console.error("[imap] connection error", { error });
      });

      try {
        await client.connect();
      } catch (error) {
        client.close();
        throw error;
      }

      return {
        close: makeClose(client),
        capabilities: () => capabilitiesFromClient(client),
        async listMailboxes() {
          const entries = await client.list();
          return entries.map(toMailboxInfo);
        },
        openMailbox: makeOpenMailbox(client),
        isUsable: () => client.usable,
      };
    },
  };
}

// watch()'s dedicated long-lived connection (./provider.ts): unlike the
// pooled clients above, this one must NOT set disableAutoIdle — its whole
// job is to sit in IDLE, re-entering it in a loop, rather than being driven
// command-by-command like the batch sync tick's or the session pool's
// connections.
export function createIdleClient(
  config: ImapConfig,
  {
    createClient = (options) => new ImapFlow(options),
  }: { createClient?: ImapIdleClientFactory } = {},
): ImapIdleClient {
  const client = createClient(
    buildClientOptions(config, { disableAutoIdle: false }),
  );
  client.on("error", (error: unknown) => {
    console.error("[imap] idle connection error", { error });
  });
  return client;
}
