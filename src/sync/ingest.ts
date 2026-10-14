import { createHash } from "node:crypto";
import type { AccountsRepo } from "../db/accounts";
import type { MessagesRepo } from "../db/messages";
import type { Envelope, MailProvider } from "../providers/port";
import { errorMessage } from "../utils/error";
import { mailboxRole } from "../utils/mailboxes";
import { log } from "../telemetry/log";
import { withSpan } from "../telemetry/otel";

// Bounds the backfill pass only (see ingestMailbox below) so a first-run
// backfill never holds the sync_tick job's claim for minutes; the saved
// backfill cursor picks up where this run left off — mirrors
// src/sync/imap-sync.ts's MAX_MESSAGES_PER_MAILBOX_RUN, but in pages rather
// than messages since list() is already page-bounded per provider.
const DEFAULT_MAX_PAGES_PER_RUN = 20;

// MailProvider.list() is a newest-first *browse* cursor, not an incremental
// "what's new since last check" one: called with no cursor it always returns
// the newest page; called with a cursor it returns the next page of *older*
// messages; it returns cursor: undefined once there's nothing older left.
// Treating the plain per-mailbox cursor as an incremental resume point (the
// old design here) meant new mail at the top of the mailbox stopped being
// detected forever the first time a mailbox ever exceeded one page — the
// loop kept paging backward from wherever it last stopped and never
// revisited the top again. Two independent passes fix that:
//
//   - head pass: every call, list(mailbox, undefined) — always the true
//     newest page. This is what actually detects new mail, unconditionally.
//   - backfill pass: a separate progress cursor, stored under
//     `${mailbox}#backfill` in the same cursors map, that pages backward
//     from where the previous call left off until it reaches the bottom
//     (then stores the literal "done" and never resumes). It exists only to
//     walk historical mail into the store once; it plays no part in
//     detecting new mail.
const backfillKey = (mailbox: string) => `${mailbox}#backfill`;

// A stable per-account message key. IMAP's list() is envelope-only: it
// carries no Message-ID (that only exists in the full RFC822 source
// postal-mime parses on read(), see src/providers/imap/adapter.ts's
// parseImapSource) — so the key is derived from mailbox+uidValidity+uid. This cannot unify the same physical message across
// two mailboxes (e.g. an archive move mints a new row instead of a new
// location on the existing one) the way src/sync/imap-sync.ts's Message-ID-
// based stableId could. That is an accepted gap of envelope-only sync for
// this wave, not a bug: a later wave can re-key a message once its body (and
// therefore its real Message-ID) has been fetched at classify time.
function messageKey(accountId: string, envelope: Envelope): string {
  const ref = envelope.ref;
  const identity = `${ref.provider}:${ref.mailbox}:${ref.uidValidity}:${ref.uid}`;
  return createHash("sha256").update(`${accountId}:${identity}`).digest("hex");
}

export function accountIdFor(
  provider: Pick<MailProvider, "id" | "account">,
): string {
  return `${provider.id}:${provider.account}`;
}

export interface IngestMailboxResult {
  new: number;
  errors: string[];
}

// Envelope-only ingest of one mailbox through the provider port, replacing
// src/sync/imap-sync.ts's byte-batching algorithm
// (docs/architecture.md §Provider port, §Jobs). Never fetches a body — that
// happens live, on read(), from the classify job. Runs the head pass and,
// unless backfill has already finished, the backfill pass described above.
async function ingestMailboxPages({
  provider,
  mailbox,
  accounts,
  messages,
  maxPagesPerRun = DEFAULT_MAX_PAGES_PER_RUN,
  enqueueClassify = () => {},
  now = () => new Date(),
  stats,
}: {
  provider: MailProvider;
  mailbox: string;
  accounts: AccountsRepo;
  messages: MessagesRepo;
  // Bounds the backfill pass only — the head pass is always exactly one page.
  maxPagesPerRun?: number;
  // Injected rather than done inside ingestMailbox itself, so this module
  // stays provider-agnostic and testable without a real job queue — the
  // composition root (src/sync/composition.ts) wires the real job enqueue.
  enqueueClassify?: (key: string) => void;
  now?: () => Date;
  // Filled in as pages arrive, for the caller's span.
  stats: { fetched: number };
}): Promise<IngestMailboxResult> {
  const accountId = accountIdFor(provider);
  accounts.upsertAccount({
    id: accountId,
    provider: provider.id,
    address: provider.account,
  });

  const errors: string[] = [];
  let newCount = 0;

  // Shared by both passes so a message the head pass already saw this tick
  // is never double-counted or re-enqueued when the backfill pass revisits
  // it: knownMessageKeys() is queried fresh per page, and upsertMessage()
  // from an earlier page has already landed by the time a later one runs.
  function ingestPage(items: Envelope[]): void {
    stats.fetched += items.length;
    const nowIso = now().toISOString();
    const keys = items.map((envelope) => messageKey(accountId, envelope));
    const known = messages.knownMessageKeys(keys);

    items.forEach((envelope, index) => {
      const key = keys[index]!;
      const isNew = !known.has(key);
      const ref = envelope.ref;

      messages.upsertMessage(
        {
          key,
          account: accountId,
          // Every configured mailbox is inbound, whatever its name (Sent included).
          direction: "inbound",
          fromAddress: envelope.from || null,
          toAddresses: envelope.to,
          cc: envelope.cc ?? null,
          bcc: null,
          replyTo: null,
          subject: envelope.subject || null,
          // Envelope.date is null when the provider reported no usable date
          // (never fabricated here). Passed straight through, possibly null —
          // messages.ts's upsertMessage only falls back to `now` (the second
          // arg below) on this message's first-ever insert, and preserves the
          // already-stored date on a null re-sight instead of advancing it to
          // a fresh "now" every tick (which would otherwise make a message
          // with no provider date float to the top of anything sorted by
          // date DESC, forever).
          date: envelope.date,
          size: envelope.size,
          hasAttachments: envelope.hasAttachments,
          threadKey: envelope.threadKey ?? null,
          flags: envelope.flags,
        },
        nowIso,
      );

      messages.upsertLocation(key, {
        mailbox,
        uidValidity: ref.uidValidity,
        uid: ref.uid,
        providerRef: ref,
        lastSeenAt: nowIso,
      });

      if (isNew) {
        newCount++;
        try {
          enqueueClassify(key);
        } catch (error) {
          // The message row is already stored, so a jobs-table write
          // failure here must not abort the rest of this page/run — but it
          // does mean this message stays unclassified until something else
          // re-enqueues it (a future re-ingest sees it as already-known and
          // won't). Logged rather than silent so the gap is at least
          // visible.
          log.error(`[ingest] failed to enqueue classify for ${key}`, {
            error,
          });
        }
      }
    });
  }

  try {
    const key = backfillKey(mailbox);
    let backfillCursor = accounts.getAccount(accountId)?.cursors[key];
    // A fresh mailbox or one just reset after a stale-cursor error (below)
    // is about to seed backfill progress straight from this head call's own
    // cursor — that seed needs a real, truncation-based cursor, not the
    // CONDSTORE fast path's always-`undefined` one (indistinguishable from
    // "genuinely nothing older"), so skip it on exactly this call.
    const needsBackfillSeed =
      backfillCursor === undefined || backfillCursor === "restart";

    // Head pass: always the true newest page, regardless of backfill state.
    const head = await provider.list(mailbox, undefined, {
      skipFastPath: needsBackfillSeed,
    });
    ingestPage(head.items);

    if (needsBackfillSeed) {
      // See the comment above: the head pass just ran with skipFastPath, so
      // head.cursor is genuinely "nothing older" when undefined, not an
      // artifact of the fast path.
      backfillCursor = head.cursor ?? "done";
      accounts.updateCursor(accountId, key, backfillCursor);
    }

    if (backfillCursor !== "done") {
      let cursor: string | undefined = backfillCursor;
      for (let page = 0; page < maxPagesPerRun; page++) {
        const result = await provider.list(mailbox, cursor);
        ingestPage(result.items);

        if (!result.cursor) {
          // "done" is permanent: nothing ever resumes a finished backfill.
          // If this mailbox accumulates more new mail between two ticks than
          // fits in one head page (LIST_PAGE_LIMIT, e.g. the container was
          // down that long), the excess older-than-the-head-page backlog is
          // never picked up — the head pass alone can't catch up, since it
          // is always exactly one page. A real fix needs the head pass
          // itself to walk backward adaptively (keep paging while it keeps
          // finding unknown messages, stop at the first already-known one)
          // rather than resuming "done" backfill. Accepted gap for this
          // wave (docs/architecture.md's known gaps) — no live caller
          // depends on backfill completeness yet.
          accounts.updateCursor(accountId, key, "done");
          break;
        }
        cursor = result.cursor;
        accounts.updateCursor(accountId, key, cursor);
      }
    }

    accounts.recordSuccess(accountId, now().toISOString());
  } catch (error) {
    const message = errorMessage(error);
    errors.push(`${mailbox}: ${message}`);
    // Only the backfill pass ever calls list() with a defined cursor
    // (the head pass always passes undefined), so this specific error can
    // only mean the stored backfill cursor names a UIDVALIDITY that no
    // longer exists (the mailbox was recreated) — it would fail identically
    // forever otherwise. Reset it so the next tick re-seeds backfill from
    // the head pass's own continuation point instead of retrying a cursor
    // that can never succeed again.
    if (message.includes("stale list() cursor")) {
      accounts.updateCursor(accountId, backfillKey(mailbox), "restart");
    }
    accounts.recordError(accountId, message, now().toISOString());
  }

  return { new: newCount, errors };
}

// The `imap.sync` client span and `sync.tick` event around one mailbox's ingest. Attributes
// are the provider, the mailbox ROLE, and counts — never an address, subject or message id.
// (`sync.tick` carries no lag figure: the age of the newest envelope cannot tell a stalled
// sync from a quiet mailbox, so a stall is the ABSENCE of ok `sync.tick` events.)
export function ingestMailbox(
  params: Omit<Parameters<typeof ingestMailboxPages>[0], "stats">,
): Promise<IngestMailboxResult> {
  const role = mailboxRole(params.mailbox);
  return withSpan(
    "imap.sync",
    { "mail.provider": params.provider.id, "mail.mailbox": role },
    async (span) => {
      const stats = { fetched: 0 };
      const result = await ingestMailboxPages({ ...params, stats });
      const outcome = result.errors.length > 0 ? "error" : "ok";
      span.setAttributes({
        outcome,
        "sync.fetched": stats.fetched,
        "sync.ingested": result.new,
      });
      // Role-based text: the raw error strings embed the folder path.
      if (outcome === "error") span.setStatus("error", `${role}: sync failed`);
      log.event(
        "sync.tick",
        {
          provider: params.provider.id,
          mailbox: role,
          outcome,
          fetched: stats.fetched,
          ingested: result.new,
        },
        outcome === "error" ? "warn" : "info",
      );
      return result;
    },
    "client",
  );
}
