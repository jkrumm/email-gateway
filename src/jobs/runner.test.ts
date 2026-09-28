import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/client";
import {
  createJobQueue,
  defaultClaimedBy,
  ensureJobsSchema,
  JOB_STALE_CLAIM_MS,
} from "../db/jobs";
import { createJobRunner } from "./runner";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const T0 = new Date("2026-06-01T12:00:00.000Z");
const CLAIMED_BY = defaultClaimedBy("host-a", 111);

function setup() {
  const db = openDatabase(":memory:");
  ensureJobsSchema(db);
  const queue = createJobQueue({ db, claimedBy: CLAIMED_BY });
  const runner = createJobRunner({ db, claimedBy: CLAIMED_BY, queue });
  return { db, queue, runner };
}

describe("createJobRunner", () => {
  test("runOnce does nothing when no kind is registered", async () => {
    const { runner } = setup();
    expect(await runner.runOnce(T0)).toBe(false);
  });

  test("runOnce dispatches a claimed job to its registered handler", async () => {
    const { queue, runner } = setup();
    queue.enqueue({ kind: "classify", payload: { id: "e1" }, now: T0 });

    const seen: unknown[] = [];
    runner.register("classify", async (payload) => {
      seen.push(payload);
    });

    expect(await runner.runOnce(T0)).toBe(true);
    expect(seen).toEqual([{ id: "e1" }]);
    expect(await runner.runOnce(T0)).toBe(false);
  });

  test("a throwing handler fails the job instead of crashing the runner", async () => {
    const { db, queue, runner } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });

    runner.register("classify", async () => {
      throw new Error("boom");
    });

    expect(await runner.runOnce(T0)).toBe(true);
    const row = db
      .query<{ status: string; last_error: string | null }, [string]>(
        `SELECT status, last_error FROM jobs WHERE id = ?`,
      )
      .get(id)!;
    expect(row).toEqual({ status: "pending", last_error: "boom" });
  });

  test("only claims kinds that have a registered handler", async () => {
    const { queue, runner } = setup();
    queue.enqueue({ kind: "send", payload: {}, now: T0 });

    runner.register("classify", async () => {});

    expect(await runner.runOnce(T0)).toBe(false);
  });

  test("drain runs every due job of registered kinds and stops", async () => {
    const { queue, runner } = setup();
    queue.enqueue({ kind: "classify", payload: { n: 1 }, now: T0 });
    queue.enqueue({ kind: "classify", payload: { n: 2 }, now: T0 });

    const seen: unknown[] = [];
    runner.register("classify", async (payload) => {
      seen.push(payload);
    });

    expect(await runner.drain(T0)).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await runner.drain(T0)).toBe(0);
  });

  test("reapOwnStaleClaims releases this host's claims before the runner starts", async () => {
    const { queue, runner } = setup();
    queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    queue.claimNext({ now: T0 }); // simulates a claim left by a previous pid

    runner.register("classify", async () => {});

    expect(await runner.runOnce(T0)).toBe(false);
    runner.reapOwnStaleClaims();
    expect(await runner.runOnce(T0)).toBe(true);
  });

  test("registering a second handler for the same kind throws instead of silently replacing it", () => {
    const { runner } = setup();
    runner.register("classify", async () => {});

    expect(() => runner.register("classify", async () => {})).toThrow();
  });

  test("a successful handler whose completion write throws is not retried as failed", async () => {
    const { db, queue } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    const claim = queue.claimNext({ kinds: ["classify"], now: T0 })!;
    // Put the claimed job back so the runner under test can claim it fresh.
    db.run(
      `UPDATE jobs SET claimed_at = NULL, claimed_by = NULL WHERE id = ?`,
      [id],
    );

    let failCalled = false;
    const stubQueue = {
      ...queue,
      claimNext: () => claim,
      complete: () => {
        throw new Error("db busy");
      },
      fail: (input: Parameters<typeof queue.fail>[0]) => {
        failCalled = true;
        return queue.fail(input);
      },
    };
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue: stubQueue,
    });
    runner.register("classify", async () => {});

    expect(await runner.runOnce(T0)).toBe(true);
    expect(failCalled).toBe(false);
  });

  test("rejects a renewIntervalMs at or above JOB_STALE_CLAIM_MS", () => {
    const db = openDatabase(":memory:");
    ensureJobsSchema(db);

    expect(() =>
      createJobRunner({
        db,
        claimedBy: CLAIMED_BY,
        renewIntervalMs: JOB_STALE_CLAIM_MS,
      }),
    ).toThrow();
  });

  test("a handler outliving the renewal interval actually gets its claim renewed", async () => {
    const { db, queue } = setup();
    queue.enqueue({ kind: "classify", payload: {}, now: T0 });

    let renewCalls = 0;
    const stubQueue = {
      ...queue,
      renewClaim: (input: Parameters<typeof queue.renewClaim>[0]) => {
        renewCalls++;
        return queue.renewClaim(input);
      },
    };
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue: stubQueue,
      renewIntervalMs: 5,
    });
    runner.register("classify", async () => {
      await sleep(30);
    });

    expect(await runner.runOnce()).toBe(true);
    expect(renewCalls).toBeGreaterThan(0);
  });

  test("the renewal interval stops calling renewClaim once the claim is already lost", async () => {
    const { db, queue } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    const claim = queue.claimNext({ kinds: ["classify"], now: T0 })!;
    db.run(
      `UPDATE jobs SET claimed_at = NULL, claimed_by = NULL WHERE id = ?`,
      [id],
    );

    let renewCalls = 0;
    const stubQueue = {
      ...queue,
      claimNext: () => claim,
      // Every renewal reports the claim as already lost.
      renewClaim: () => {
        renewCalls++;
        return null;
      },
    };
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue: stubQueue,
      renewIntervalMs: 5,
    });
    runner.register("classify", async () => {
      await sleep(30);
    });

    await runner.runOnce();
    const callsDuringRun = renewCalls;
    await sleep(20);
    // The interval clears itself on the first null — no further calls after
    // the handler (and thus runOnce) has already returned.
    expect(renewCalls).toBe(callsDuringRun);
  });

  test("a rate-limit error parks the job without spending an attempt", async () => {
    const { db, queue, runner } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });

    runner.register("classify", async () => {
      throw new Error("rate_limit_exceeded");
    });

    expect(await runner.runOnce(T0)).toBe(true);
    const row = db
      .query<{ status: string; attempts: number }, [string]>(
        `SELECT status, attempts FROM jobs WHERE id = ?`,
      )
      .get(id)!;
    expect(row).toEqual({ status: "pending", attempts: 0 });
  });

  test("a rate-limited failure logs exactly one line naming the retry delay and rate_limits, never the raw error object", async () => {
    const { db, queue } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    const logs: { message: string; meta?: unknown }[] = [];
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue,
      log: (message, meta) => logs.push({ message, meta }),
    });
    runner.register("classify", async () => {
      throw new Error("rate_limit_exceeded");
    });

    expect(await runner.runOnce(T0)).toBe(true);

    expect(logs).toHaveLength(1);
    // recordFailOutcome logs against the real jittered delay (queue.fail
    // isn't given a fixed `random` here) — 60-72s covers the 1st rung's
    // base plus up to the configured 20% jitter.
    expect(logs[0]!.message).toMatch(
      new RegExp(
        `^\\[jobs\\] classify ${id} rate-limited, retry in (6[0-9]|7[0-2])s \\(rate_limits=1\\)$`,
      ),
    );
    expect(logs[0]!.meta).toBeUndefined();
  });

  test("a non-rate-limit failure still logs the full error object", async () => {
    const { db, queue } = setup();
    const id = queue.enqueue({ kind: "classify", payload: {}, now: T0 });
    const logs: { message: string; meta?: unknown }[] = [];
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue,
      log: (message, meta) => logs.push({ message, meta }),
    });
    const error = new Error("boom");
    runner.register("classify", async () => {
      throw error;
    });

    expect(await runner.runOnce(T0)).toBe(true);

    expect(logs).toEqual([
      { message: `[jobs] classify job ${id} failed`, meta: { error } },
    ]);
  });

  test("a throwing claimNext does not crash runOnce — it just reports no job ran", async () => {
    const { db, queue } = setup();
    const stubQueue = {
      ...queue,
      claimNext: () => {
        throw new Error("SQLITE_BUSY");
      },
    };
    const runner = createJobRunner({
      db,
      claimedBy: CLAIMED_BY,
      queue: stubQueue,
    });
    runner.register("classify", async () => {});

    await expect(runner.runOnce()).resolves.toBe(false);
  });
});
