import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./client";
import {
  JOB_MAX_ATTEMPTS,
  JOB_STALE_CLAIM_MS,
  createJobQueue,
  defaultClaimedBy,
  ensureJobsSchema,
  planJobFailure,
  planJobRateLimited,
} from "./jobs";

const noJitter = () => 0;

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLAIMED_BY = defaultClaimedBy("host-a", 111);

interface JobRow {
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

function jobState(db: Database, id: string): JobRow {
  return db
    .query<JobRow, [string]>(
      `SELECT status, attempts, next_attempt_at, last_error FROM jobs WHERE id = ?`,
    )
    .get(id)!;
}

function setup(kind = "classify") {
  const db = openDatabase(":memory:");
  ensureJobsSchema(db);
  const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
  const id = queue.enqueue({ kind, payload: { hello: "world" }, now: T0 });
  return { db, queue, id };
}

describe("defaultClaimedBy", () => {
  test("joins hostname and pid", () => {
    expect(defaultClaimedBy("host-a", 111)).toBe("host-a:111");
  });
});

describe("planJobFailure", () => {
  test("backs off 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h and gives up on the 9th failure", () => {
    const waits = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR];
    waits.push(12 * HOUR, 24 * HOUR);

    for (const [attempts, wait] of waits.entries()) {
      expect(planJobFailure({ attempts, now: T0, random: noJitter })).toEqual({
        status: "pending",
        attempts: attempts + 1,
        nextAttemptAt: at(wait).toISOString(),
      });
    }

    expect(JOB_MAX_ATTEMPTS).toBe(9);
    expect(planJobFailure({ attempts: 8, now: T0, random: noJitter })).toEqual({
      status: "failed",
      attempts: 9,
      nextAttemptAt: null,
    });
  });

  test("jitter only ever adds delay, up to the configured ratio, never subtracts", () => {
    const zero = planJobFailure({ attempts: 0, now: T0, random: () => 0 });
    const max = planJobFailure({ attempts: 0, now: T0, random: () => 1 });

    expect(zero.nextAttemptAt).toBe(at(MINUTE).toISOString());
    // random() = 1 is the ratio's upper bound: base + 20%.
    expect(max.nextAttemptAt).toBe(at(MINUTE + 0.2 * MINUTE).toISOString());
  });

  test("terminal failure has no next attempt to jitter", () => {
    expect(planJobFailure({ attempts: 8, now: T0, random: () => 1 })).toEqual({
      status: "failed",
      attempts: 9,
      nextAttemptAt: null,
    });
  });
});

describe("planJobRateLimited", () => {
  test("reschedules on the first backoff rung without incrementing attempts", () => {
    const plan = planJobRateLimited({ attempts: 4, now: T0, random: noJitter });

    expect(plan).toEqual({
      status: "pending",
      attempts: 4,
      nextAttemptAt: at(MINUTE).toISOString(),
    });
  });

  test("never goes terminal no matter how many prior attempts", () => {
    const plan = planJobRateLimited({
      attempts: JOB_MAX_ATTEMPTS + 10,
      now: T0,
      random: noJitter,
    });

    expect(plan.status).toBe("pending");
    expect(plan.attempts).toBe(JOB_MAX_ATTEMPTS + 10);
  });
});

describe("createJobQueue", () => {
  test("enqueue then claimNext round-trips the payload", () => {
    const { queue } = setup();
    const claim = queue.claimNext({ now: T0 });

    expect(claim).toMatchObject({
      kind: "classify",
      payload: { hello: "world" },
    });
  });

  test("claimNext only returns kinds asked for", () => {
    const { queue } = setup("classify");
    expect(queue.claimNext({ kinds: ["send"], now: T0 })).toBeNull();
    expect(queue.claimNext({ kinds: ["classify"], now: T0 })).not.toBeNull();
  });

  test("claimNext({ kinds: [] }) matches nothing, unlike an omitted kinds", () => {
    const { queue } = setup("classify");
    expect(queue.claimNext({ kinds: [], now: T0 })).toBeNull();
    expect(queue.claimNext({ now: T0 })).not.toBeNull();
  });

  test("a fresh claim is not reclaimed, a stale one is", () => {
    const { queue } = setup();
    expect(queue.claimNext({ now: T0 })).not.toBeNull();

    expect(
      queue.claimNext({ now: at(JOB_STALE_CLAIM_MS - MINUTE) }),
    ).toBeNull();
    expect(
      queue.claimNext({ now: at(JOB_STALE_CLAIM_MS + MINUTE) }),
    ).not.toBeNull();
  });

  test("complete marks the job done and it is never claimed again", () => {
    const { db, queue, id } = setup();
    const claim = queue.claimNext({ now: T0 })!;

    expect(queue.complete({ ...claim, now: T0 })).toBe(true);
    expect(queue.claimNext({ now: at(1000 * HOUR) })).toBeNull();
    expect(jobState(db, id)).toMatchObject({ status: "done", attempts: 1 });
    expect(queue.counts()).toEqual({ pending: 0, failed: 0 });
  });

  test("a failure counts one attempt, schedules the backoff and keeps the error", () => {
    const { db, queue, id } = setup();
    const claim = queue.claimNext({ now: T0 })!;

    expect(
      queue.fail({
        ...claim,
        error: "429 high demand",
        now: T0,
        random: noJitter,
      }),
    ).toBe(true);

    expect(jobState(db, id)).toEqual({
      status: "pending",
      attempts: 1,
      next_attempt_at: at(MINUTE).toISOString(),
      last_error: "429 high demand",
    });
    expect(
      queue.claimNext({ now: new Date(at(MINUTE).getTime() - 1) }),
    ).toBeNull();
    expect(queue.claimNext({ now: at(MINUTE) })).not.toBeNull();
  });

  test("fail with rateLimited never spends an attempt, however many times it recurs", () => {
    const { db, queue, id } = setup();

    for (let i = 0; i < JOB_MAX_ATTEMPTS + 3; i++) {
      const claim = queue.claimNext({ now: at(i * HOUR) })!;
      queue.fail({
        ...claim,
        error: "429 high demand",
        now: at(i * HOUR),
        rateLimited: true,
        random: noJitter,
      });
    }

    const state = jobState(db, id);
    expect(state.status).toBe("pending");
    expect(state.attempts).toBe(0);
    expect(
      queue.claimNext({ now: at((JOB_MAX_ATTEMPTS + 3) * HOUR) }),
    ).not.toBeNull();
  });

  test("walks the full schedule and ends failed after JOB_MAX_ATTEMPTS", () => {
    const { db, queue, id } = setup();
    let clock = T0;

    for (let attempt = 1; attempt < JOB_MAX_ATTEMPTS; attempt++) {
      const claim = queue.claimNext({ now: clock })!;
      queue.fail({ ...claim, error: "boom", now: clock });
      const state = jobState(db, id);
      expect([state.status, state.attempts]).toEqual(["pending", attempt]);
      clock = new Date(state.next_attempt_at!);
    }

    const lastClaim = queue.claimNext({ now: clock })!;
    queue.fail({ ...lastClaim, error: "boom", now: clock });

    expect(jobState(db, id)).toEqual({
      status: "failed",
      attempts: JOB_MAX_ATTEMPTS,
      next_attempt_at: null,
      last_error: "boom",
    });
    expect(queue.counts()).toEqual({ pending: 0, failed: 1 });
    expect(queue.claimNext({ now: at(1000 * HOUR) })).toBeNull();
  });

  test("after a stale takeover the old claim's late writes are no-ops and attempts are not double-counted", () => {
    const { db, queue, id } = setup();
    const oldClaim = queue.claimNext({ now: T0 })!;
    const newClaim = queue.claimNext({ now: at(JOB_STALE_CLAIM_MS + MINUTE) })!;

    expect(
      queue.fail({
        ...oldClaim,
        error: "boom",
        now: at(JOB_STALE_CLAIM_MS + 2 * MINUTE),
      }),
    ).toBe(false);
    expect(queue.complete({ ...oldClaim, now: T0 })).toBe(false);
    expect(jobState(db, id)).toMatchObject({ status: "pending", attempts: 0 });

    expect(queue.complete({ ...newClaim, now: T0 })).toBe(true);
    expect(queue.fail({ ...oldClaim, error: "boom", now: T0 })).toBe(false);
    expect(jobState(db, id)).toMatchObject({
      status: "done",
      attempts: 1,
      last_error: null,
    });
  });

  test("a claim can only be used once", () => {
    const { queue } = setup();
    const claim = queue.claimNext({ now: T0 })!;

    expect(queue.complete({ ...claim, now: T0 })).toBe(true);
    expect(queue.complete({ ...claim, now: T0 })).toBe(false);
    expect(queue.fail({ ...claim, error: "boom", now: T0 })).toBe(false);
  });

  test("failing or completing an unknown id is a no-op", () => {
    const { queue } = setup();
    const unknown = { id: "does-not-exist", claimToken: "x" };

    expect(queue.complete({ ...unknown, now: T0 })).toBe(false);
    expect(queue.fail({ ...unknown, error: "boom", now: T0 })).toBe(false);
  });

  test("reapOwnStaleClaims releases only this host's claims, immediately", () => {
    const db = openDatabase(":memory:");
    ensureJobsSchema(db);
    const queueA = createJobQueue({ db, claimedBy: "host-a:111" });
    const queueB = createJobQueue({ db, claimedBy: "host-b:222" });

    queueA.enqueue({ kind: "classify", payload: {}, id: "a", now: T0 });
    queueA.enqueue({ kind: "classify", payload: {}, id: "b", now: T0 });
    queueA.claimNext({ now: T0 }); // claims row "a"
    queueB.claimNext({ now: T0 }); // claims row "b"

    // Neither claim is stale yet, so a plain claimNext sees nothing.
    expect(queueA.claimNext({ now: T0 })).toBeNull();

    expect(queueA.reapOwnStaleClaims()).toBe(1);
    expect(queueA.claimNext({ now: T0 })).not.toBeNull();
    expect(queueB.claimNext({ now: T0 })).toBeNull();
  });

  test("counts totals pending and failed across every kind", () => {
    const db = openDatabase(":memory:");
    ensureJobsSchema(db);
    const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
    queue.enqueue({ kind: "classify", payload: {}, id: "a", now: T0 });
    queue.enqueue({ kind: "send", payload: {}, id: "b", now: T0 });

    const claim = queue.claimNext({ kinds: ["classify"], now: T0 })!;
    queue.complete({ ...claim, now: T0 });

    expect(queue.counts()).toEqual({ pending: 1, failed: 0 });
  });

  test("a claim exactly at the stale threshold is not yet reclaimed", () => {
    const { queue } = setup();
    queue.claimNext({ now: T0 });

    expect(queue.claimNext({ now: at(JOB_STALE_CLAIM_MS) })).toBeNull();
    expect(queue.claimNext({ now: at(JOB_STALE_CLAIM_MS + 1) })).not.toBeNull();
  });

  test("renewClaim extends a live claim so it survives past the stale threshold", () => {
    const { queue } = setup();
    const claim = queue.claimNext({ now: T0 })!;

    const renewedToken = queue.renewClaim({
      ...claim,
      now: at(JOB_STALE_CLAIM_MS - MINUTE),
    });
    expect(renewedToken).not.toBeNull();

    // Reclaiming relative to the original claim time would now find it
    // stale; relative to the renewed time it is still fresh.
    expect(
      queue.claimNext({ now: at(JOB_STALE_CLAIM_MS + MINUTE) }),
    ).toBeNull();
    expect(
      queue.complete({ id: claim.id, claimToken: renewedToken!, now: T0 }),
    ).toBe(true);
  });

  test("renewClaim returns null once the claim is already lost", () => {
    const { queue } = setup();
    const claim = queue.claimNext({ now: T0 })!;
    queue.complete({ ...claim, now: T0 });

    expect(queue.renewClaim({ ...claim, now: T0 })).toBeNull();
  });

  test("a row with corrupt payload_json fails only that row and claimNext moves on", () => {
    const db = openDatabase(":memory:");
    const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
    queue.enqueue({ kind: "classify", payload: {}, id: "bad", now: T0 });
    db.run(`UPDATE jobs SET payload_json = 'not json' WHERE id = 'bad'`);
    queue.enqueue({
      kind: "classify",
      payload: { ok: true },
      id: "good",
      now: T0,
    });

    const claim = queue.claimNext({ now: T0 });
    expect(claim).toMatchObject({ id: "good", payload: { ok: true } });

    const bad = jobState(db, "bad");
    expect(bad.status).toBe("pending");
    expect(bad.attempts).toBe(1);
    expect(bad.last_error).toContain("corrupt payload_json");
  });

  test("finished_at is set on terminal failure, not just on completion", () => {
    const db = openDatabase(":memory:");
    const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    let clock = T0;

    for (let attempt = 1; attempt < JOB_MAX_ATTEMPTS; attempt++) {
      const claim = queue.claimNext({ now: clock })!;
      queue.fail({ ...claim, error: "boom", now: clock });
      clock = new Date(jobState(db, id).next_attempt_at!);
    }
    queue.fail({
      ...queue.claimNext({ now: clock })!,
      error: "boom",
      now: clock,
    });

    const finishedAt = db
      .query<{ finished_at: string | null }, [string]>(
        `SELECT finished_at FROM jobs WHERE id = ?`,
      )
      .get(id)!.finished_at;
    expect(finishedAt).toBe(clock.toISOString());
  });

  test('enqueue with an undefined payload round-trips to null, not the string "undefined"', () => {
    const db = openDatabase(":memory:");
    const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
    const id = queue.enqueue({
      kind: "classify",
      payload: undefined,
      now: T0,
    });

    const claim = queue.claimNext({ now: T0 });
    expect(claim).toMatchObject({ id, payload: null });
  });

  test("enqueue rejects a duplicate explicit id and round-trips subjectKey", () => {
    const db = openDatabase(":memory:");
    const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
    queue.enqueue({
      kind: "classify",
      payload: {},
      id: "dup",
      subjectKey: "email:in_1",
      now: T0,
    });

    expect(() =>
      queue.enqueue({ kind: "classify", payload: {}, id: "dup", now: T0 }),
    ).toThrow();

    const row = db
      .query<{ subject_key: string | null }, [string]>(
        `SELECT subject_key FROM jobs WHERE id = ?`,
      )
      .get("dup")!;
    expect(row.subject_key).toBe("email:in_1");
  });

  test("reapOwnStaleClaims does not match a different host whose name shares a prefix via an underscore", () => {
    const db = openDatabase(":memory:");
    const queueA = createJobQueue({ db, claimedBy: "host_a:111" });
    const queueOther = createJobQueue({ db, claimedBy: "hostxa:222" });

    queueA.enqueue({ kind: "classify", payload: {}, id: "a", now: T0 });
    queueOther.enqueue({ kind: "classify", payload: {}, id: "b", now: T0 });
    queueA.claimNext({ now: T0 }); // claims row "a"
    queueOther.claimNext({ now: T0 }); // claims row "b"

    expect(queueA.reapOwnStaleClaims()).toBe(1);
    // Row "a" (host_a's own) is released; row "b" (hostxa's) must not be —
    // an unescaped `_` in the LIKE pattern would treat it as a wildcard and
    // release both.
    expect(jobState(db, "a").status).toBe("pending");
    const rowB = db
      .query<{ claimed_by: string | null }, [string]>(
        `SELECT claimed_by FROM jobs WHERE id = ?`,
      )
      .get("b")!;
    expect(rowB.claimed_by).toBe("hostxa:222");
  });
});
