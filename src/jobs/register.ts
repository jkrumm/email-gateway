import { hostname } from "node:os";
import { defaultClaimedBy } from "../db/jobs";
import { mailDb } from "../db/mail-index";
import { enqueueSyncTick, jobQueue as queue } from "./queue";
import { createJobRunner } from "./runner";
import { createClassifyHandler } from "./classify";
import { createJevMessageHandler, createJevSubmissionHandler } from "./jev";
import { createSendHandler } from "./send";
import {
  createSyncTickHandler,
  defaultMailboxesFor,
} from "../sync/composition";
import { configuredProviders } from "../providers/from-env";
import type { MailProvider, Unsubscribe } from "../providers/port";

// Boot composition for every async source (docs/architecture.md §Jobs),
// replacing src/sync/index.ts's startSync, src/enrich/worker.ts's
// startEnrichmentWorker and src/jev/worker.ts's startJevWorker. A leased job
// is the "two containers, one SQLite" lock now — no in-memory flags.
const SYNC_INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 10_000;
// IDLE can fire several events in a burst (e.g. a multi-message deliver); the
// job system's own claim already prevents duplicate concurrent ticks, so this
// only needs to collapse a burst into roughly one enqueue.
const IDLE_DEBOUNCE_MS = 5_000;

export function startJobSystem(): void {
  if (process.env.NODE_ENV === "test") return;

  const claimedBy = defaultClaimedBy(hostname(), process.pid);
  const runner = createJobRunner({ db: mailDb, claimedBy, queue });

  // Once, before anything else claims (src/db/jobs.ts's reapOwnStaleClaims
  // doc comment — it has no claim-age check, so it must never run twice).
  runner.reapOwnStaleClaims();

  const enqueueClassify = (key: string): void => {
    queue.enqueue({ kind: "classify", payload: { key }, subjectKey: key });
  };
  const enqueueJevMessage = (key: string): void => {
    queue.enqueue({ kind: "jev_message", payload: { key }, subjectKey: key });
  };
  // No dedupe against an already-pending sync_tick: src/db/jobs.ts's
  // enqueue() has no kind-level uniqueness, but the handler is idempotent
  // (re-lists from the saved cursor), so an occasional duplicate pending row
  // just means one tick's work runs twice in a row — cheaper than adding a
  // pre-enqueue existence check for a case the job system already makes safe.
  const tick = (): void => enqueueSyncTick(queue);

  runner.register("sync_tick", createSyncTickHandler({ enqueueClassify }));
  runner.register("classify", createClassifyHandler({ enqueueJevMessage }));
  runner.register("jev_message", createJevMessageHandler());
  runner.register("jev_submission", createJevSubmissionHandler());
  runner.register("send", createSendHandler());

  // Guards against a new poll() tick starting a second drain() while the
  // previous one is still running a long handler (an LLM call or IMAP read,
  // neither bounded by a wall-clock ceiling per rules/agent-limits.md).
  // Without this, two concurrent sync_tick handlers for the same account
  // could race src/db/accounts.ts's updateCursor, and concurrent
  // classify/jev_message/jev_submission claims lose the queue's only
  // implicit throttle on LLM call concurrency (the 2026-09-28 Jev 429
  // incident src/db/jobs.ts's own comment cites).
  let draining = false;
  const poll = (): void => {
    if (draining) return;
    draining = true;
    void runner
      .drain()
      .catch((error) => {
        console.error("[jobs] drain failed", { error });
      })
      .finally(() => {
        draining = false;
      });
  };
  poll();
  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref();

  const firstRun = setTimeout(() => {
    tick();
    const tickTimer = setInterval(tick, SYNC_INTERVAL_MS);
    tickTimer.unref();
  }, FIRST_RUN_DELAY_MS);
  firstRun.unref();

  void wireImapIdle(tick);
}

// watch() kicks a (debounced) sync_tick per configured IMAP mailbox that
// reports idle capability. Returns the Unsubscribe for each mailbox watched
// (unused by wireImapIdle below — the process only ever stops by exiting),
// so a future caller that does need to stop watching has it without a
// signature change.
// One provider's own capabilities check + mailbox watches — factored out so
// wireImapIdle can run every provider's setup concurrently instead of one
// provider's slow/half-open connect delaying every account after it in the
// list (real-time IDLE coverage for those accounts would otherwise wait out
// imapflow's own connect timeout first).
async function wireProviderIdle(
  provider: MailProvider,
  enqueueSyncTick: () => void,
): Promise<Unsubscribe[]> {
  if (provider.id === "resend" || !provider.watch) return [];

  const capabilities = await provider.capabilities().catch((error) => {
    console.error("[imap] failed to read capabilities for watch()", {
      error,
    });
    return null;
  });
  if (!capabilities?.idle) return [];

  const unsubscribes: Unsubscribe[] = [];
  // Each IMAP provider watches only its own configured mailboxes — Proton's
  // list must not be opened on the Gmail account, or vice versa.
  for (const mailbox of defaultMailboxesFor(provider)) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(enqueueSyncTick, IDLE_DEBOUNCE_MS);
      debounceTimer.unref();
    };

    try {
      const unsubscribe = await provider.watch(mailbox, onChange);
      unsubscribes.push(unsubscribe);
      console.log(`[imap] watching ${mailbox} for changes (IDLE)`);
    } catch (error) {
      console.error(`[imap] failed to start watch() on ${mailbox}`, {
        error,
      });
    }
  }
  return unsubscribes;
}

async function wireImapIdle(enqueueSyncTick: () => void): Promise<void> {
  const providers = configuredProviders();
  const results = await Promise.allSettled(
    providers.map((provider) => wireProviderIdle(provider, enqueueSyncTick)),
  );
  // wireProviderIdle already catches/logs every failure it can attribute to
  // a specific provider's capabilities()/watch() call — this only catches
  // something unexpected escaping it outright (e.g. defaultMailboxesFor's
  // own env parsing throwing), which allSettled would otherwise swallow
  // with no signal at all.
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `[imap] wireProviderIdle failed unexpectedly for ${providers[index]!.id}`,
        { error: result.reason },
      );
    }
  });
  // Every returned Unsubscribe is intentionally left uncollected here — the
  // process only ever stops by exiting, per wireProviderIdle's own doc
  // comment, so there is nothing that would ever call one.
}
