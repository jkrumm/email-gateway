import type { Database } from "bun:sqlite";
import {
  createJobQueue,
  JOB_STALE_CLAIM_MS,
  type JobClaim,
  type JobQueue,
} from "../db/jobs";
import { errorMessage } from "../utils/error";
import { isRateLimitError } from "./rate-limit";

// A handler may be re-run in full for a job it already completed if the
// completion write itself fails (DB busy during the RollHook deploy
// overlap) or if its claim is stolen mid-run — both are no-ops that leave
// the job claimed-but-pending rather than surfacing an error. Every handler
// must therefore be safe to run more than once for the same payload.
export type JobHandler = (payload: unknown) => Promise<void>;

export interface JobRunner {
  register(kind: string, handler: JobHandler): void;
  // Releases this host's dead-process claims. Call once at boot, before the
  // runner starts claiming.
  reapOwnStaleClaims(): number;
  // Claims and runs one due job among the registered kinds. Returns whether
  // a job ran. No timeout on the handler call itself — a slow handler is not
  // a stuck one (rules/agent-limits.md); handlers that call an LLM use
  // src/jobs/idle-watchdog.ts for their own liveness check. The claim is
  // renewed periodically while the handler runs, so a call outliving
  // JOB_STALE_CLAIM_MS keeps its claim instead of being taken over mid-run.
  runOnce(now?: Date): Promise<boolean>;
  // Runs registered jobs until none are due. Returns how many ran. Re-reads
  // the clock for every iteration (unless `now` is fixed by the caller, as
  // tests do) so a job failing late in a long drain still gets its backoff
  // computed against the current time, not a stale start time.
  drain(now?: Date): Promise<number>;
}

// Comfortably inside JOB_STALE_CLAIM_MS so a renewal always lands well before
// the claim would otherwise go stale.
const DEFAULT_RENEW_INTERVAL_MS = Math.floor(JOB_STALE_CLAIM_MS / 3);

// Keeps a claim alive for as long as its handler runs, by periodically
// re-writing claimed_at. Every write here (and every other DB write this
// module makes) is guarded: a throw would otherwise escape as an unhandled
// timer error and crash the whole process, exactly during the deploy-overlap
// DB contention this module exists to survive. A missed renewal just risks a
// stale takeover, never a crash.
function startClaimRenewal({
  queue,
  claim,
  intervalMs,
}: {
  queue: JobQueue;
  claim: JobClaim;
  intervalMs: number;
}): { currentToken: () => string; stop: () => void } {
  let claimToken = claim.claimToken;
  const timer = setInterval(() => {
    try {
      const renewed = queue.renewClaim({ id: claim.id, claimToken });
      if (renewed) {
        claimToken = renewed;
      } else {
        // Claim already lost (stale takeover) — nothing left to renew.
        clearInterval(timer);
      }
    } catch (error) {
      console.error(
        `[jobs] failed to renew claim for ${claim.kind} job ${claim.id}`,
        { error },
      );
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return { currentToken: () => claimToken, stop: () => clearInterval(timer) };
}

// Records the handler's outcome. A DB error here must not abort the rest of
// drain()'s loop (mirrors src/jev/worker.ts's drainQueue keeping outcome
// writes outside the judged work's own try/catch) — log and move on. A
// `false` return from the queue means the claim was already lost (most
// likely a renewal that stopped succeeding for the whole stale window): some
// other process may be running or may re-run this job, a silent
// double-execution risk worth surfacing even though there's nothing left for
// this call to do about it.
function recordOutcome({
  write,
  claim,
  verb,
}: {
  write: () => boolean;
  claim: JobClaim;
  verb: "done" | "failed";
}): void {
  try {
    if (!write()) {
      console.error(
        `[jobs] ${claim.kind} job ${claim.id} ${verb}, but its claim was already lost — may run again elsewhere`,
      );
    }
  } catch (error) {
    console.error(
      `[jobs] failed to record ${claim.kind} job ${claim.id} as ${verb}`,
      { error },
    );
  }
}

export function createJobRunner({
  db,
  claimedBy,
  queue = createJobQueue({ db, claimedBy }),
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
}: {
  db: Database;
  claimedBy: string;
  queue?: JobQueue;
  renewIntervalMs?: number;
}): JobRunner {
  if (renewIntervalMs >= JOB_STALE_CLAIM_MS) {
    throw new Error(
      `renewIntervalMs (${renewIntervalMs}ms) must be below JOB_STALE_CLAIM_MS (${JOB_STALE_CLAIM_MS}ms), or a claim would go stale before it is ever renewed`,
    );
  }

  const handlers = new Map<string, JobHandler>();

  function register(kind: string, handler: JobHandler): void {
    if (handlers.has(kind)) {
      throw new Error(`a handler is already registered for job kind "${kind}"`);
    }
    handlers.set(kind, handler);
  }

  function claimForHandlers(kinds: string[], now: Date): JobClaim | null {
    try {
      return queue.claimNext({ kinds, now });
    } catch (error) {
      // Same reasoning as recordOutcome: a DB error here (SQLITE_BUSY during
      // the deploy overlap) must not abort drain()'s loop — report no job
      // ran this pass and let the next scheduled pass retry.
      console.error(`[jobs] failed to claim a job`, { error });
      return null;
    }
  }

  async function runOnce(now = new Date()): Promise<boolean> {
    const kinds = [...handlers.keys()];
    if (kinds.length === 0) return false;

    const claim = claimForHandlers(kinds, now);
    if (!claim) return false;

    const handler = handlers.get(claim.kind)!;
    const renewal = startClaimRenewal({
      queue,
      claim,
      intervalMs: renewIntervalMs,
    });

    try {
      await handler(claim.payload);
    } catch (error) {
      console.error(`[jobs] ${claim.kind} job ${claim.id} failed`, { error });
      renewal.stop();
      recordOutcome({
        claim,
        verb: "failed",
        write: () =>
          queue.fail({
            id: claim.id,
            claimToken: renewal.currentToken(),
            error: errorMessage(error),
            now: new Date(),
            rateLimited: isRateLimitError(error),
          }),
      });
      return true;
    }

    renewal.stop();
    recordOutcome({
      claim,
      verb: "done",
      write: () =>
        queue.complete({
          id: claim.id,
          claimToken: renewal.currentToken(),
          now: new Date(),
        }),
    });
    return true;
  }

  async function drain(now?: Date): Promise<number> {
    let count = 0;
    while (await runOnce(now)) count++;
    return count;
  }

  return {
    register,
    reapOwnStaleClaims: () => queue.reapOwnStaleClaims(),
    runOnce,
    drain,
  };
}
