import type { Database } from "bun:sqlite";

export type JevStatus = "pending" | "done" | "failed";

// Longer than the Jev call's own 30-min hang guard (src/llm/jev.ts), so a
// claim is never treated as stale while a call could still be running. Also
// covers RollHook briefly running two containers on the same SQLite file.
export const JEV_STALE_CLAIM_MS = 35 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Wait after the Nth consecutive failure (index N-1). The last failure has no
// wait — it is terminal.
const JEV_BACKOFF_MS = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
] as const;

export const JEV_MAX_ATTEMPTS = JEV_BACKOFF_MS.length + 1;

export interface JevFailurePlan {
  status: "pending" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
}

// The state a queue row moves to after one more failed attempt.
export function planJevFailure({
  attempts,
  now,
}: {
  attempts: number;
  now: Date;
}): JevFailurePlan {
  const total = attempts + 1;
  if (total >= JEV_MAX_ATTEMPTS) {
    return { status: "failed", attempts: total, nextAttemptAt: null };
  }

  return {
    status: "pending",
    attempts: total,
    nextAttemptAt: new Date(
      now.getTime() + JEV_BACKOFF_MS[total - 1]!,
    ).toISOString(),
  };
}

export interface JevQueueCounts {
  pending: number;
  failed: number;
}

export interface JevClaim {
  id: string;
  // The `jev_claimed_at` value this claim wrote. Completing or failing the
  // row only takes effect while that value is still on it, so a claim lost to
  // a stale takeover or a re-queue can't clobber the new owner's work.
  claimToken: string;
}

// The claim / complete / fail / count SQL shared by the two Jev queue tables
// (`submissions` and `email_enrichments`); both carry the same jev_* queue
// columns. Identifiers are internal constants, never user input.
export function createJevQueue({
  db,
  table,
  idColumn,
  orderColumn,
}: {
  db: Database;
  table: string;
  idColumn: string;
  orderColumn: string;
}) {
  // Atomically claims the oldest due row: pending, past its backoff, and not
  // held by a fresh claim (a stale one is taken over — see
  // JEV_STALE_CLAIM_MS). One row at a time so a claim never waits behind a
  // long sequential batch and goes stale before its row is judged.
  function claimNext<Extra extends object = object>({
    now = new Date(),
    extraColumns = [],
  }: {
    now?: Date;
    extraColumns?: string[];
  } = {}): (JevClaim & Extra) | null {
    const nowIso = now.toISOString();
    const staleBefore = new Date(
      now.getTime() - JEV_STALE_CLAIM_MS,
    ).toISOString();
    const returning = [
      `${idColumn} AS id`,
      "jev_claimed_at AS claimToken",
      ...extraColumns,
    ].join(", ");

    return (
      db
        .query<JevClaim & Extra, [string, string, string]>(
          `UPDATE ${table} SET jev_claimed_at = ?
           WHERE ${idColumn} = (
             SELECT ${idColumn} FROM ${table}
             WHERE jev_status = 'pending'
               AND (jev_next_attempt_at IS NULL OR jev_next_attempt_at <= ?)
               AND (jev_claimed_at IS NULL OR jev_claimed_at < ?)
             ORDER BY ${orderColumn} ASC
             LIMIT 1
           )
           RETURNING ${returning}`,
        )
        .get(nowIso, nowIso, staleBefore) ?? null
    );
  }

  // Stores the decision; `result` maps decision columns to values. Returns
  // false (and writes nothing) when the claim was lost.
  function complete({
    id,
    claimToken,
    result,
  }: JevClaim & { result: Record<string, string | number | null> }): boolean {
    const columns = Object.keys(result);
    const { changes } = db.run(
      `UPDATE ${table} SET
         jev_status = 'done',
         jev_attempts = jev_attempts + 1,
         jev_next_attempt_at = NULL,
         jev_claimed_at = NULL,
         jev_error = NULL
         ${columns.map((column) => `, ${column} = ?`).join("")}
       WHERE ${idColumn} = ? AND jev_claimed_at = ?`,
      [...columns.map((column) => result[column]!), id, claimToken],
    );
    return changes > 0;
  }

  // Counts one failed attempt: schedules the next one, or gives up for good
  // after JEV_MAX_ATTEMPTS, keeping the last error either way. A no-op when
  // the claim was lost. Immediate transaction: the attempt count is read and
  // advanced under one write lock.
  const failTx = db.transaction(
    ({
      id,
      claimToken,
      error,
      now,
    }: JevClaim & { error: string; now: Date }): boolean => {
      const row = db
        .query<{ jev_attempts: number }, [string, string]>(
          `SELECT jev_attempts FROM ${table}
           WHERE ${idColumn} = ? AND jev_claimed_at = ?`,
        )
        .get(id, claimToken);
      if (!row) return false;

      const plan = planJevFailure({ attempts: row.jev_attempts, now });
      db.run(
        `UPDATE ${table} SET
           jev_status = ?, jev_attempts = jev_attempts + 1,
           jev_next_attempt_at = ?, jev_claimed_at = NULL, jev_error = ?
         WHERE ${idColumn} = ? AND jev_claimed_at = ?`,
        [plan.status, plan.nextAttemptAt, error, id, claimToken],
      );
      return true;
    },
  );

  function fail({
    id,
    claimToken,
    error,
    now = new Date(),
  }: JevClaim & { error: string; now?: Date }): boolean {
    return failTx.immediate({ id, claimToken, error, now });
  }

  function counts(): JevQueueCounts {
    return db
      .query<JevQueueCounts, []>(
        `SELECT COALESCE(SUM(jev_status = 'pending'), 0) AS pending,
                COALESCE(SUM(jev_status = 'failed'), 0) AS failed
         FROM ${table}`,
      )
      .get()!;
  }

  return { claimNext, complete, fail, counts };
}
