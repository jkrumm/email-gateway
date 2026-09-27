import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import PostalMime, { type Address, type Email } from "postal-mime";
import {
  createEmailsRepo,
  type EmailsRepo,
  type UpsertEmailInput,
} from "../db/emails";
import { createImapStateRepo, type ImapStateRepo } from "../db/imap-state";
import { validDate } from "../utils/date";
import { errorMessage } from "../utils/error";
import type {
  ImapMailbox,
  ImapMessageInfo,
  ImapPort,
} from "../providers/imap/adapter";
import type { ImapSyncSummary } from "./types";

// The container has 256 MB: bigger messages are stored headers-only, and one
// FETCH never holds more than BATCH_BYTES of raw source.
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const BATCH_BYTES = 10 * 1024 * 1024;
export const BATCH_MESSAGES = 50;
// After this many consecutive runs held at the same uid, stop waiting for it.
export const MAX_CONSECUTIVE_HOLDS = 12;
// Bounds one tick so a first-run backfill never holds the sync lock (and an
// HTTP-triggered sync) for minutes; the cursor picks up where it left off.
const MAX_MESSAGES_PER_MAILBOX_RUN = 500;
const UNKNOWN_SENDER = "unknown@invalid";

export type ParseMessage = (raw: Uint8Array) => Promise<Email>;

const parseWithPostalMime: ParseMessage = (raw) => PostalMime.parse(raw);

function formatAddress(address: Address): string {
  if (!address.address) return address.name ?? "";
  return address.name
    ? `${address.name} <${address.address}>`
    : address.address;
}

function flattenAddresses(addresses: Address[] | undefined): string[] {
  return (addresses ?? []).flatMap((address) =>
    address.group ? flattenAddresses(address.group) : [formatAddress(address)],
  );
}

function optionalList(addresses: Address[] | undefined): string[] | undefined {
  const list = flattenAddresses(addresses);
  return list.length > 0 ? list : undefined;
}

function formatSize(bytes: number | null): string {
  return bytes === null
    ? "unknown size"
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isOversized(info: ImapMessageInfo): boolean {
  return info.size === null || info.size > MAX_MESSAGE_BYTES;
}

function contentHash(raw: Uint8Array | null): string | null {
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}

// UID-independent identity of message content, used when there is no
// Message-ID: a rescan after a UIDVALIDITY reset must map to the same row.
function contentFingerprint({
  info,
  hash,
}: {
  info: ImapMessageInfo;
  hash: string | null;
}): string {
  const received = validDate(info.internalDate)?.toISOString() ?? "";
  return `${info.size ?? "?"}|${received}|${hash ?? "none"}`;
}

// Keyed per mailbox: the same message may sit in INBOX and Spam. With neither
// a Message-ID nor a real content hash nothing identifies the message, so the
// uid (+ uidValidity) is the discriminator — a duplicate after a UIDVALIDITY
// reset is better than two different messages silently sharing a row.
function stableId({
  mailbox,
  messageId,
  hash,
  fingerprint,
  uid,
  uidValidity,
}: {
  mailbox: string;
  messageId: string | undefined;
  hash: string | null;
  fingerprint: string;
  uid: number;
  uidValidity: string;
}): string {
  const trimmed = messageId?.trim();
  const identity =
    trimmed ||
    (hash ? fingerprint : `${fingerprint}|uid:${uidValidity}:${uid}`);
  const key = `${mailbox}\n${identity}`;
  return `imap:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function receivedAt({
  info,
  headerDate,
}: {
  info: ImapMessageInfo;
  headerDate?: string;
}): string {
  return (
    validDate(info.internalDate) ??
    validDate(headerDate) ??
    new Date()
  ).toISOString();
}

interface PreparedMessage {
  info: ImapMessageInfo;
  input: UpsertEmailInput;
  // Metadata-only stand-in, used if storing `input` throws.
  fallback: UpsertEmailInput;
}

interface MessageScope {
  mailbox: string;
  uidValidity: string;
  info: ImapMessageInfo;
}

// Fields shared by the full row and its metadata-only stand-in. Both use the
// same id scheme, so a stand-in for a message with a known Message-ID lands on
// the id the full row would have had.
function baseInput({
  scope,
  messageId,
  hash,
  headerDate,
}: {
  scope: MessageScope;
  messageId?: string;
  hash: string | null;
  headerDate?: string;
}): Pick<
  UpsertEmailInput,
  | "id"
  | "direction"
  | "provider"
  | "mailbox"
  | "insertOnly"
  | "messageId"
  | "contentHash"
  | "createdAt"
> {
  const { mailbox, uidValidity, info } = scope;
  return {
    id: stableId({
      mailbox,
      messageId,
      hash,
      fingerprint: contentFingerprint({ info, hash }),
      uid: info.uid,
      uidValidity,
    }),
    direction: "inbound",
    provider: "imap",
    mailbox,
    insertOnly: true,
    messageId: messageId?.trim() || null,
    contentHash: hash,
    createdAt: receivedAt({ info, headerDate }),
  };
}

function metadataOnlyInput({
  scope,
  messageId,
  hash,
  subject,
  text,
}: {
  scope: MessageScope;
  messageId?: string;
  hash: string | null;
  subject: string;
  text: string;
}): UpsertEmailInput {
  return {
    ...baseInput({ scope, messageId, hash }),
    fromAddress: UNKNOWN_SENDER,
    toAddresses: [],
    subject,
    text,
    attachments: [],
  };
}

async function prepareMessage({
  scope,
  raw,
  parse,
  degrade,
}: {
  scope: MessageScope;
  // Full source, or the header block for an oversized message; null when even
  // the headers could not be fetched.
  raw: Uint8Array | null;
  parse: ParseMessage;
  degrade: (message: string) => void;
}): Promise<PreparedMessage> {
  const { info } = scope;
  const oversized = isOversized(info);
  const hash = contentHash(raw);
  const standIn = (messageId?: string) =>
    metadataOnlyInput({
      scope,
      messageId,
      hash,
      subject: raw ? "(unparseable message)" : "(headers unavailable)",
      text: raw
        ? "[Message could not be parsed.]"
        : "[Message headers could not be fetched.]",
    });

  if (!raw) {
    degrade(`uid ${info.uid} headers unavailable, stored metadata only`);
    const fallback = standIn();
    return { info, input: fallback, fallback };
  }

  let parsed: Email;
  try {
    parsed = await parse(raw);
  } catch (error) {
    degrade(
      `uid ${info.uid} unparseable (${errorMessage(error)}), stored metadata only`,
    );
    const fallback = standIn();
    return { info, input: fallback, fallback };
  }

  try {
    const input: UpsertEmailInput = {
      ...baseInput({
        scope,
        messageId: parsed.messageId,
        hash,
        headerDate: parsed.date,
      }),
      fromAddress: parsed.from ? formatAddress(parsed.from) : UNKNOWN_SENDER,
      toAddresses: flattenAddresses(parsed.to),
      cc: optionalList(parsed.cc),
      bcc: optionalList(parsed.bcc),
      replyTo: optionalList(parsed.replyTo),
      subject: parsed.subject?.trim() || "(no subject)",
      html: oversized ? null : (parsed.html ?? null),
      text: oversized
        ? `[Body not stored: message is ${formatSize(info.size)}, over the ${formatSize(MAX_MESSAGE_BYTES)} limit.]`
        : (parsed.text ?? null),
      // Metadata only, like the Resend inbound rows. Sizes are measured here
      // so the attachment bytes can be collected right away.
      attachments: oversized
        ? []
        : parsed.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.mimeType,
            size:
              typeof attachment.content === "string"
                ? Buffer.byteLength(attachment.content)
                : attachment.content.byteLength,
          })),
    };
    return { info, input, fallback: standIn(parsed.messageId) };
  } catch (error) {
    degrade(
      `uid ${info.uid} unparseable (${errorMessage(error)}), stored metadata only`,
    );
    const fallback = standIn(parsed.messageId);
    return { info, input: fallback, fallback };
  }
}

// Consecutive small messages share one FETCH; an oversized message is always
// its own (headers-only) group.
export function planBatches(messages: ImapMessageInfo[]): ImapMessageInfo[][] {
  const batches: ImapMessageInfo[][] = [];
  let current: ImapMessageInfo[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const message of messages) {
    if (isOversized(message)) {
      flush();
      batches.push([message]);
      continue;
    }
    const size = message.size ?? 0;
    if (current.length >= BATCH_MESSAGES || currentBytes + size > BATCH_BYTES) {
      flush();
    }
    current.push(message);
    currentBytes += size;
  }
  flush();

  return batches;
}

interface MailboxContext {
  db: Database;
  path: string;
  mailbox: ImapMailbox;
  emails: EmailsRepo;
  state: ImapStateRepo;
  parse: ParseMessage;
  maxPerRun: number;
  errors: string[];
  // Records a per-message degradation: returned in `errors` and persisted as
  // the mailbox's health warning.
  degrade: (message: string) => void;
}

// Loads one batch. Returns the messages that are safe to store and the uid
// the cursor may advance to; a message the server still has but did not
// return is never skipped — the batch stops before it.
async function loadBatch(
  context: MailboxContext,
  batch: ImapMessageInfo[],
): Promise<{
  prepared: PreparedMessage[];
  advanceTo: number | null;
  heldAt: number | null;
}> {
  const { mailbox, path, parse, errors, degrade } = context;
  const sources = new Map<number, Uint8Array | null>();
  let heldAt: number | null = null;

  const [first] = batch;
  if (!first) return { prepared: [], advanceTo: null, heldAt };

  if (isOversized(first)) {
    sources.set(first.uid, await mailbox.fetchHeaders(first.uid));
  } else {
    const fetched = await mailbox.fetchSources(batch.map((m) => m.uid));
    for (const [uid, raw] of fetched) sources.set(uid, raw);
  }

  const missing = batch.filter((info) => !sources.get(info.uid));
  const gone = new Set<number>();
  if (missing.length > 0) {
    const existing = await mailbox.existingUids(missing.map((m) => m.uid));
    for (const info of missing) {
      if (!existing.has(info.uid)) gone.add(info.uid);
      // Oversized + headers null but present: stored metadata-only below.
      else if (!isOversized(info)) heldAt ??= info.uid;
    }
  }

  const prepared: PreparedMessage[] = [];
  let advanceTo: number | null = null;
  for (const info of batch) {
    if (heldAt !== null && info.uid >= heldAt) break;
    advanceTo = info.uid;
    if (gone.has(info.uid)) {
      errors.push(
        `imap ${path}: uid ${info.uid} expunged before fetch, skipped`,
      );
      continue;
    }
    // One message at a time; release the raw source as soon as it is parsed.
    prepared.push(
      await prepareMessage({
        scope: { mailbox: path, uidValidity: mailbox.uidValidity, info },
        raw: sources.get(info.uid) ?? null,
        parse,
        degrade,
      }),
    );
    sources.delete(info.uid);
  }

  return { prepared, advanceTo, heldAt };
}

async function syncMailbox(
  context: MailboxContext,
): Promise<{ newCount: number }> {
  const { db, path, mailbox, emails, state, maxPerRun, degrade } = context;
  const stored = state.getCursor(path);
  const uidValidityChanged = stored?.uidValidity !== mailbox.uidValidity;
  // UIDVALIDITY changed: the old UIDs mean nothing, rescan from the start.
  // Stable ids make the rescan a no-op for known messages, not a second copy.
  let lastUid = stored && !uidValidityChanged ? stored.lastUid : 0;

  const listing = await mailbox.listAfter(lastUid, maxPerRun);
  if (listing.truncated) {
    console.info(
      `[imap] ${path}: capped at ${listing.messages.length} messages this run, more pending`,
    );
  }

  // Rows and cursor land together (validity + uid are saved in one statement),
  // so a failure leaves neither half-written.
  const persist = db.transaction(
    (prepared: PreparedMessage[], cursorUid: number) => {
      const known = emails.knownEmailIds(
        prepared.flatMap((p) => [p.input.id, p.fallback.id]),
      );
      let added = 0;
      for (const { input, fallback } of prepared) {
        // Insert-only keeps the stored row, but a *different* message
        // reusing its Message-ID deserves a trace.
        const storedHash = input.contentHash
          ? emails.getContentHash(input.id)
          : null;
        if (storedHash && storedHash !== input.contentHash) {
          degrade(
            `${input.messageId ?? input.id} reused with different content, kept the stored row`,
          );
        }

        let storedId = input.id;
        try {
          emails.upsertEmail(input);
        } catch (error) {
          degrade(
            `uid store failed for ${input.id} (${errorMessage(error)}), stored metadata only`,
          );
          // If even the stand-in can't be stored this is a database problem:
          // let it abort the batch so the cursor holds.
          emails.upsertEmail(fallback);
          storedId = fallback.id;
        }
        if (!known.has(storedId)) added++;
        known.add(storedId);
      }
      state.saveCursor(path, {
        uidValidity: mailbox.uidValidity,
        lastUid: cursorUid,
      });
      return added;
    },
  );

  let newCount = 0;
  for (const batch of planBatches(listing.messages)) {
    const { prepared, advanceTo, heldAt } = await loadBatch(context, batch);

    if (advanceTo !== null) {
      newCount += persist(prepared, advanceTo);
      lastUid = advanceTo;
    }
    if (heldAt === null) continue;

    const holds = state.recordHold(path, heldAt);
    const heldInfo = batch.find((info) => info.uid === heldAt);
    if (holds < MAX_CONSECUTIVE_HOLDS || !heldInfo) {
      throw new Error(
        `uid ${heldAt} exists but returned no source; cursor held at ${lastUid}, retrying next run`,
      );
    }

    // The server keeps listing a message it never returns: stop letting it
    // wedge the mailbox. Store a stand-in, move past it, and flag it. The
    // rest of the batch is picked up from the cursor on the next run.
    degrade(
      `uid ${heldAt} returned no source in ${holds} consecutive runs, stored a metadata-only stand-in and moved on`,
    );
    const scope = {
      mailbox: path,
      uidValidity: mailbox.uidValidity,
      info: heldInfo,
    };
    const standIn = metadataOnlyInput({
      scope,
      hash: null,
      subject: "(message unavailable)",
      text: `[Message could not be fetched after ${holds} attempts.]`,
    });
    newCount += persist(
      [{ info: heldInfo, input: standIn, fallback: standIn }],
      heldAt,
    );
    lastUid = heldAt;
    break;
  }

  // Record the UIDVALIDITY even for an empty mailbox.
  if (uidValidityChanged && listing.messages.length === 0) {
    state.saveCursor(path, { uidValidity: mailbox.uidValidity, lastUid });
  }
  state.clearHold(path);

  return { newCount };
}

function summarizeWarnings(degraded: string[]): string | undefined {
  if (degraded.length === 0) return undefined;
  const shown = degraded.slice(0, 3).join("; ");
  const more = degraded.length - 3;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

export async function syncImap({
  db,
  port,
  mailboxes,
  parse = parseWithPostalMime,
  maxPerRun = MAX_MESSAGES_PER_MAILBOX_RUN,
}: {
  db: Database;
  port: ImapPort;
  mailboxes: string[];
  parse?: ParseMessage;
  maxPerRun?: number;
}): Promise<{ summary: ImapSyncSummary; errors: string[] }> {
  const emails = createEmailsRepo(db);
  const state = createImapStateRepo(db);
  const errors: string[] = [];
  const summary: ImapSyncSummary = { new: 0 };

  const failMailbox = (path: string, error: unknown) => {
    const message = errorMessage(error);
    errors.push(`imap ${path}: ${message}`);
    state.recordError(path, message);
  };

  let session;
  try {
    session = await port.connect();
  } catch (error) {
    const message = `connect: ${errorMessage(error)}`;
    errors.push(`imap ${message}`);
    for (const path of mailboxes) state.recordError(path, message);
    return { summary, errors };
  }

  try {
    for (const path of mailboxes) {
      let mailbox: ImapMailbox;
      try {
        mailbox = await session.openMailbox(path);
      } catch (error) {
        failMailbox(path, error);
        continue;
      }

      const degraded: string[] = [];
      try {
        const { newCount } = await syncMailbox({
          db,
          path,
          mailbox,
          emails,
          state,
          parse,
          maxPerRun,
          errors,
          degrade: (message) => {
            errors.push(`imap ${path}: ${message}`);
            degraded.push(message);
          },
        });
        summary.new += newCount;
        state.recordSuccess(path, { warning: summarizeWarnings(degraded) });
      } catch (error) {
        failMailbox(path, error);
      } finally {
        mailbox.release();
      }
    }
  } finally {
    await session.close().catch(() => undefined);
  }

  return { summary, errors };
}
