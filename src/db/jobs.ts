import type { Database } from "bun:sqlite";
import { errorMessage } from "../utils/error";

// Generalises src/db/jev-queue.ts's claim/backoff/stale-takeover semantics
// into one table for every async kind (classify, jev_message, jev_submission,
// send, sync_tick, body_prefetch — see docs/architecture.md §Jobs).
//
// This module owns its DDL and issues it against whatever `Database` it is
// given via `ensureJobsSchema` (also run automatically by `createJobQueue`).
// It is deliberately **not** registered in `src/db/migrations.ts` and must
// never run against `${DATA_DIR}/email-gateway.sqlite`: the `jobs` table only
// exists for real in the fresh schema Wave 4 creates (`mail.sqlite`). Today
// it is proven against an in-memory database only (see jobs.test.ts);
// nothing calls it in production yet.

export type JobStatus = "pending" | "done" | "failed";

// Longer than any LLM call's own 30-min hang guard, so a claim is never
// treated as stale while a call could still be running. Also covers
// RollHook briefly running two containers on the same SQLite file.
export const JOB_STALE_CLAIM_MS = 35 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Wait after the Nth consecutive failure (index N-1). The last failure has no
// wait — it is terminal. Identical ladder to src/db/jev-queue.ts.
const JOB_BACKOFF_MS = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
] as const;

export const JOB_MAX_ATTEMPTS = JOB_BACKOFF_MS.length + 1;

// Applied to every scheduled backoff so a burst of jobs failing at the same
// instant doesn't re-batch onto the exact same next_attempt_at and retry in
// lockstep (2026-09-28 Jev 429 incident: identical offsets kept re-triggering
// the same burst). Always additive — a job never gets a shorter wait than the
// ladder says, only a longer one.
const BACKOFF_JITTER_RATIO = 0.2;

function jitteredDelayMs(baseMs: number, random: () => number): number {
  return baseMs + Math.floor(random() * baseMs * BACKOFF_JITTER_RATIO);
}

export interface JobFailurePlan {
  status: Exclude<JobStatus, "done">;
  attempts: number;
  nextAttemptAt: string | null;
}

// The state a job moves to after one more failed attempt. `random` is
// injectable for deterministic tests; defaults to Math.random.
export function planJobFailure({
  attempts,
  now,
  random = Math.random,
}: {
  attempts: number;
  now: Date;
  random?: () => number;
}): JobFailurePlan {
  const total = attempts + 1;
  if (total >= JOB_MAX_ATTEMPTS) {
    return { status: "failed", attempts: total, nextAttemptAt: null };
  }

  return {
    status: "pending",
    attempts: total,
    nextAttemptAt: new Date(
      now.getTime() + jitteredDelayMs(JOB_BACKOFF_MS[total - 1]!, random),
    ).toISOString(),
  };
}

// The state a job moves to after a rate-limited attempt: parks for a short,
// jittered delay and retries **without** spending one of JOB_MAX_ATTEMPTS —
// a 429 is the upstream's fault, not the job's. Left unbounded deliberately:
// a persistent upstream outage keeps retrying at this cadence instead of the
// job going terminally `failed` while the queue itself is healthy. Callers
// decide what counts as rate-limited (jobs.ts stays domain-agnostic); Wave 4
// wires this in for jev_message/jev_submission when they move onto this
// queue, replacing src/db/jev-queue.ts's current all-failures-count-an-
// attempt behaviour that let a 429 burst burn through 17 submissions'
// attempt budgets in 24h (2026-09-28).
export function planJobRateLimited({
  attempts,
  now,
  random = Math.random,
}: {
  attempts: number;
  now: Date;
  random?: () => number;
}): JobFailurePlan {
  return {
    status: "pending",
    attempts,
    nextAttemptAt: new Date(
      now.getTime() + jitteredDelayMs(JOB_BACKOFF_MS[0]!, random),
    ).toISOString(),
  };
}

export interface JobCounts {
  pending: number;
  failed: number;
}

export interface JobClaim {
  id: string;
  kind: string;
  payload: unknown;
  // The `claimed_at` value this claim last wrote. Completing, failing or
  // renewing the job only takes effect while that value is still on it, so a
  // claim lost to a stale takeover can't clobber the new owner's work.
  claimToken: string;
}

const JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')) DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    claimed_at TEXT,
    claimed_by TEXT,
    payload_json TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, next_attempt_at, claimed_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs (kind, status);
`;

export function ensureJobsSchema(db: Database): void {
  db.run(JOBS_SCHEMA);
}

// audio-gateway's "<hostname>:<pid>" pattern: identifies which process holds
// a claim, so a boot reap can release exactly this host's dead-process claims
// immediately instead of waiting out JOB_STALE_CLAIM_MS.
export function defaultClaimedBy(hostname: string, pid: number): string {
  return `${hostname}:${pid}`;
}

// Escapes SQLite LIKE metacharacters so a hostname containing `_` or `%`
// (common in Docker/compose hostnames) can't accidentally match a different
// host's claimed_by value.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export interface JobQueue {
  enqueue(input: {
    kind: string;
    payload: unknown;
    subjectKey?: string | null;
    id?: string;
    now?: Date;
  }): string;
  // Claims the oldest due job: pending, past its backoff, and not held by a
  // fresh claim (a stale one is taken over). `kinds` left `undefined` means
  // unrestricted; an explicit `kinds: []` means match none, not "match any"
  // (a runner only claims kinds it has a handler for, and an empty handler
  // set must claim nothing). One row at a time so a claim never waits behind
  // a long sequential run and goes stale before it is judged. A row whose
  // payload_json can't be parsed is failed on the spot and skipped, so one
  // corrupt row never blocks every row behind it.
  claimNext(input?: { kinds?: string[]; now?: Date }): JobClaim | null;
  // Re-writes claimed_at so a handler still running past JOB_STALE_CLAIM_MS
  // keeps its claim instead of being taken over mid-run. Returns the new
  // claim token, or null if the claim was already lost (stale takeover or a
  // status change) — a caller must stop renewing and let the run finish
  // without touching the row further.
  renewClaim(input: {
    id: string;
    claimToken: string;
    now?: Date;
  }): string | null;
  // Marks a claim done. Returns false (writes nothing) when the claim was
  // lost to a stale takeover.
  complete(input: { id: string; claimToken: string; now?: Date }): boolean;
  // Counts one failed attempt: schedules the next one, or gives up for good
  // after JOB_MAX_ATTEMPTS, keeping the last error either way. Pass
  // `rateLimited: true` to park and reschedule instead, without spending an
  // attempt (see planJobRateLimited) — the caller decides what counts as
  // rate-limited. A no-op when the claim was lost.
  fail(input: {
    id: string;
    claimToken: string;
    error: string;
    now?: Date;
    rateLimited?: boolean;
    random?: () => number;
  }): boolean;
  // Releases every job this host claimed before it last restarted (matched
  // by the hostname prefix of `claimedBy`, any pid) back to pending. Call
  // exactly once at boot, before the runner or anything else claims a job —
  // it has no claim-age check, so calling it again later would steal a claim
  // out from under this same process's own in-flight handler.
  reapOwnStaleClaims(): number;
  counts(): JobCounts;
}

export function createJobQueue({
  db,
  claimedBy,
}: {
  db: Database;
  claimedBy: string;
}): JobQueue {
  ensureJobsSchema(db);
  const hostname = claimedBy.split(":")[0]!;

  function enqueue({
    kind,
    payload,
    subjectKey = null,
    id = crypto.randomUUID(),
    now = new Date(),
  }: {
    kind: string;
    payload: unknown;
    subjectKey?: string | null;
    id?: string;
    now?: Date;
  }): string {
    db.run(
      `INSERT INTO jobs (id, kind, subject_key, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        subjectKey,
        JSON.stringify(payload ?? null),
        now.toISOString(),
      ],
    );
    return id;
  }

  function claimNextRow({ kinds, now }: { kinds?: string[]; now: Date }): {
    id: string;
    kind: string;
    payloadJson: string;
    claimToken: string;
  } | null {
    // `kinds: []` means "restrict to no kinds", i.e. match nothing — distinct
    // from `kinds` left `undefined`, which means unrestricted. Without this,
    // a caller computing an empty kind list (e.g. a runner with no handlers
    // registered) would silently claim any pending job instead of none.
    if (kinds && kinds.length === 0) return null;

    const nowIso = now.toISOString();
    const staleBefore = new Date(
      now.getTime() - JOB_STALE_CLAIM_MS,
    ).toISOString();
    const kindFilter = kinds
      ? `AND kind IN (${kinds.map(() => "?").join(", ")})`
      : "";

    const row = db
      .query<
        { id: string; kind: string; payload_json: string; claimToken: string },
        (string | number)[]
      >(
        `UPDATE jobs SET claimed_at = ?, claimed_by = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (claimed_at IS NULL OR claimed_at < ?)
             ${kindFilter}
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING id, kind, payload_json, claimed_at AS claimToken`,
      )
      .get(nowIso, claimedBy, nowIso, staleBefore, ...(kinds ?? []));

    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      payloadJson: row.payload_json,
      claimToken: row.claimToken,
    };
  }

  function claimNext({
    kinds,
    now = new Date(),
  }: { kinds?: string[]; now?: Date } = {}): JobClaim | null {
    for (;;) {
      const claimed = claimNextRow({ kinds, now });
      if (!claimed) return null;

      try {
        return {
          id: claimed.id,
          kind: claimed.kind,
          payload: JSON.parse(claimed.payloadJson),
          claimToken: claimed.claimToken,
        };
      } catch (error) {
        // A row that can never be parsed would otherwise throw out of every
        // drain pass that reaches it (src/jev/worker.ts avoids exactly this
        // by parsing inside its own per-row guard). Fail just this row —
        // using the claim already taken above — and keep looking.
        try {
          fail({
            id: claimed.id,
            claimToken: claimed.claimToken,
            error: `corrupt payload_json: ${errorMessage(error)}`,
            now,
          });
        } catch (writeError) {
          // The fail() write itself hit a DB error (e.g. SQLITE_BUSY during
          // the two-container deploy overlap) — log and stop here rather
          // than looping forever or throwing out of claimNext. The row
          // stays claimed and is retried once that claim goes stale.
          console.error(
            `[jobs] failed to record corrupt payload_json for job ${claimed.id}`,
            { error: writeError },
          );
          return null;
        }
      }
    }
  }

  function renewClaim({
    id,
    claimToken,
    now = new Date(),
  }: {
    id: string;
    claimToken: string;
    now?: Date;
  }): string | null {
    const nowIso = now.toISOString();
    const { changes } = db.run(
      `UPDATE jobs SET claimed_at = ?
       WHERE id = ? AND claimed_at = ? AND status = 'pending'`,
      [nowIso, id, claimToken],
    );
    return changes > 0 ? nowIso : null;
  }

  function complete({
    id,
    claimToken,
    now = new Date(),
  }: {
    id: string;
    claimToken: string;
    now?: Date;
  }): boolean {
    const { changes } = db.run(
      `UPDATE jobs SET
         status = 'done',
         attempts = attempts + 1,
         next_attempt_at = NULL,
         claimed_at = NULL,
         claimed_by = NULL,
         last_error = NULL,
         finished_at = ?
       WHERE id = ? AND claimed_at = ?`,
      [now.toISOString(), id, claimToken],
    );
    return changes > 0;
  }

  // Immediate transaction: the attempt count is read and advanced under one
  // write lock, matching src/db/jev-queue.ts's failTx (fallow flags the
  // ~18-line overlap; not worth sharing across a two-table jev_*-column
  // queue and this generic one-table queue for the one wave they coexist —
  // jev-queue.ts's consumers move onto this module in Wave 4).
  const failTx = db.transaction(
    ({
      id,
      claimToken,
      error,
      now,
      rateLimited,
      random,
    }: {
      id: string;
      claimToken: string;
      error: string;
      now: Date;
      rateLimited: boolean;
      random: () => number;
    }): boolean => {
      const row = db
        .query<{ attempts: number }, [string, string]>(
          `SELECT attempts FROM jobs WHERE id = ? AND claimed_at = ?`,
        )
        .get(id, claimToken);
      if (!row) return false;

      const plan = rateLimited
        ? planJobRateLimited({ attempts: row.attempts, now, random })
        : planJobFailure({ attempts: row.attempts, now, random });
      db.run(
        `UPDATE jobs SET
           status = ?, attempts = ?,
           next_attempt_at = ?, claimed_at = NULL, claimed_by = NULL,
           last_error = ?, finished_at = ?
         WHERE id = ? AND claimed_at = ?`,
        [
          plan.status,
          plan.attempts,
          plan.nextAttemptAt,
          error,
          plan.status === "failed" ? now.toISOString() : null,
          id,
          claimToken,
        ],
      );
      return true;
    },
  );

  function fail({
    id,
    claimToken,
    error,
    now = new Date(),
    rateLimited = false,
    random = Math.random,
  }: {
    id: string;
    claimToken: string;
    error: string;
    now?: Date;
    rateLimited?: boolean;
    random?: () => number;
  }): boolean {
    return failTx.immediate({
      id,
      claimToken,
      error,
      now,
      rateLimited,
      random,
    });
  }

  function reapOwnStaleClaims(): number {
    const { changes } = db.run(
      `UPDATE jobs SET claimed_at = NULL, claimed_by = NULL
       WHERE status = 'pending' AND claimed_by LIKE ? ESCAPE '\\'`,
      [`${escapeLikePattern(hostname)}:%`],
    );
    return changes;
  }

  function counts(): JobCounts {
    return db
      .query<JobCounts, []>(
        `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending,
                COALESCE(SUM(status = 'failed'), 0) AS failed
         FROM jobs`,
      )
      .get()!;
  }

  return {
    enqueue,
    claimNext,
    renewClaim,
    complete,
    fail,
    reapOwnStaleClaims,
    counts,
  };
}
