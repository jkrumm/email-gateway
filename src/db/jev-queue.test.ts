import { describe, expect, test } from "bun:test";
import { openDatabase } from "./client";
import {
  JEV_MAX_ATTEMPTS,
  JEV_STALE_CLAIM_MS,
  planJevFailure,
  type JevClaim,
} from "./jev-queue";
import { createSubmissionsRepo } from "./submissions";

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("planJevFailure", () => {
  test("backs off 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h and gives up on the 9th failure", () => {
    const waits = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR];
    waits.push(12 * HOUR, 24 * HOUR);

    for (const [attempts, wait] of waits.entries()) {
      expect(planJevFailure({ attempts, now: T0 })).toEqual({
        status: "pending",
        attempts: attempts + 1,
        nextAttemptAt: at(wait).toISOString(),
      });
    }

    expect(JEV_MAX_ATTEMPTS).toBe(9);
    expect(planJevFailure({ attempts: 8, now: T0 })).toEqual({
      status: "failed",
      attempts: 9,
      nextAttemptAt: null,
    });
  });
});

// The two queue tables share one implementation; every behaviour below runs
// against both through this adapter.
interface Harness {
  enqueue(): void;
  claimNext(now?: Date): JevClaim | null;
  complete(claim: JevClaim): boolean;
  fail(claim: JevClaim, now?: Date): boolean;
  state(): {
    status: string;
    attempts: number;
    nextAttemptAt: string | null;
    error: string | null;
  };
  counts(): { pending: number; failed: number };
  // A different row than the one enqueued last, with a claim on it.
  unknownClaim(): JevClaim;
}

function submissionsHarness(): Harness {
  const submissions = createSubmissionsRepo(openDatabase(":memory:"));
  const result = {
    verdict: "spam" as const,
    confidence: 0.9,
    probabilities: null,
    latencyMs: 5,
    model: "jev",
  };
  return {
    enqueue: () =>
      void submissions.recordSubmission({
        source: "fpp",
        verdict: "legit",
        confidence: 0.9,
        reason: "r",
        model: "m",
        delivered: true,
        submission: {},
        jevPending: true,
      }),
    claimNext: (now) => submissions.claimNextJev({ now }),
    complete: (claim) => submissions.completeJev({ ...claim, result }),
    fail: (claim, now) =>
      submissions.failJev({ ...claim, error: "429 high demand", now }),
    state: () => {
      const jev = submissions.listSubmissions().data[0]!.jev!;
      return {
        status: jev.status,
        attempts: jev.attempts,
        nextAttemptAt: jev.nextAttemptAt,
        error: jev.error,
      };
    },
    counts: submissions.jevQueueCounts,
    unknownClaim: () => ({ id: "does-not-exist", claimToken: "x" }),
  };
}

describe("Jev queue: submissions", () => {
  const makeHarness = submissionsHarness;

  function queued() {
    const queue = makeHarness();
    queue.enqueue();
    return queue;
  }

  test("a failure counts one attempt, schedules the backoff and keeps the error", () => {
    const queue = queued();
    queue.fail(queue.claimNext(T0)!, T0);

    expect(queue.state()).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAt: at(MINUTE).toISOString(),
      error: "429 high demand",
    });
  });

  test("walks the full schedule and ends failed after JEV_MAX_ATTEMPTS", () => {
    const queue = queued();
    let clock = T0;

    for (let attempt = 1; attempt < JEV_MAX_ATTEMPTS; attempt++) {
      queue.fail(queue.claimNext(clock)!, clock);
      const { status, attempts, nextAttemptAt } = queue.state();
      expect([status, attempts]).toEqual(["pending", attempt]);
      clock = new Date(nextAttemptAt!);
    }

    queue.fail(queue.claimNext(clock)!, clock);

    expect(queue.state()).toEqual({
      status: "failed",
      attempts: JEV_MAX_ATTEMPTS,
      nextAttemptAt: null,
      error: "429 high demand",
    });
    expect(queue.counts()).toEqual({ pending: 0, failed: 1 });
    expect(queue.claimNext(at(1000 * HOUR))).toBeNull();
  });

  test("a row is claimed exactly at its retry time, not a millisecond before", () => {
    const queue = queued();
    queue.fail(queue.claimNext(T0)!, T0);
    const due = at(MINUTE);

    expect(queue.claimNext(new Date(due.getTime() - 1))).toBeNull();
    expect(queue.claimNext(due)).not.toBeNull();
  });

  test("a fresh claim is not reclaimed, a stale one is", () => {
    const queue = queued();
    expect(queue.claimNext(T0)).not.toBeNull();

    expect(queue.claimNext(at(JEV_STALE_CLAIM_MS - MINUTE))).toBeNull();
    expect(queue.claimNext(at(JEV_STALE_CLAIM_MS + MINUTE))).not.toBeNull();
  });

  test("after a stale takeover the old claim's late writes are no-ops and attempts are not double-counted", () => {
    const queue = queued();
    const oldClaim = queue.claimNext(T0)!;
    const newClaim = queue.claimNext(at(JEV_STALE_CLAIM_MS + MINUTE))!;

    expect(queue.fail(oldClaim, at(JEV_STALE_CLAIM_MS + 2 * MINUTE))).toBe(
      false,
    );
    expect(queue.complete(oldClaim)).toBe(false);
    expect(queue.state()).toMatchObject({ status: "pending", attempts: 0 });

    expect(queue.complete(newClaim)).toBe(true);
    // The old owner finishing late cannot undo or redo the result.
    expect(queue.fail(oldClaim)).toBe(false);
    expect(queue.state()).toMatchObject({
      status: "done",
      attempts: 1,
      error: null,
    });
  });

  test("failing or completing an unknown id is a no-op", () => {
    const queue = queued();

    expect(queue.fail(queue.unknownClaim())).toBe(false);
    expect(queue.complete(queue.unknownClaim())).toBe(false);
    expect(queue.state()).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("a claim can only be used once", () => {
    const queue = queued();
    const claim = queue.claimNext(T0)!;

    expect(queue.complete(claim)).toBe(true);
    expect(queue.complete(claim)).toBe(false);
    expect(queue.fail(claim)).toBe(false);
    expect(queue.state().attempts).toBe(1);
  });
});
