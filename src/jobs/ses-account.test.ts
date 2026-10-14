import { describe, expect, test } from "bun:test";
import { createJobQueue } from "../db/jobs";
import { openMailDatabase } from "../db/mail-client";
import { createSesAccountRepo } from "../db/ses-account";
import { createSesAccountHandler, enqueueSesAccount } from "./ses-account";
import { isRateLimitError } from "./rate-limit";

const now = () => new Date("2026-10-14T10:00:00.000Z");

function clientReturning(response: object) {
  return { send: async () => response } as never;
}

function clientThrowing(error: Error) {
  return {
    send: async () => {
      throw error;
    },
  } as never;
}

describe("createSesAccountHandler", () => {
  test("stores the snapshot, overwriting the previous one", async () => {
    const repo = createSesAccountRepo(openMailDatabase(":memory:"));

    await createSesAccountHandler({
      client: clientReturning({
        SendingEnabled: true,
        EnforcementStatus: "HEALTHY",
      }),
      repo,
      now,
    })({});
    expect(repo.get()).toMatchObject({
      sendingEnabled: true,
      enforcementStatus: "HEALTHY",
      fetchedAt: "2026-10-14T10:00:00.000Z",
    });

    await createSesAccountHandler({
      client: clientReturning({
        SendingEnabled: false,
        EnforcementStatus: "PROBATION",
      }),
      repo,
      now,
    })({});
    expect(repo.get()).toMatchObject({
      sendingEnabled: false,
      enforcementStatus: "PROBATION",
    });
  });

  test("fails quietly on an ordinary error: one log line, nothing stored", async () => {
    const repo = createSesAccountRepo(openMailDatabase(":memory:"));
    const lines: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args);
    try {
      await expect(
        createSesAccountHandler({
          client: clientThrowing(new Error("AccessDenied")),
          repo,
        })({}),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = original;
    }

    expect(lines).toHaveLength(1);
    expect(repo.get()).toBeNull();
  });

  test("rethrows a throttle so the runner parks it on the rate-limit ladder", async () => {
    const throttle = Object.assign(new Error("slow down"), {
      name: "TooManyRequestsException",
    });

    const run = createSesAccountHandler({
      client: clientThrowing(throttle),
      repo: createSesAccountRepo(openMailDatabase(":memory:")),
    })({});

    await expect(run).rejects.toBe(throttle);
    expect(isRateLimitError(throttle)).toBe(true);
  });
});

describe("ses account repo", () => {
  test("get() is null before the first snapshot", () => {
    expect(createSesAccountRepo(openMailDatabase(":memory:")).get()).toBeNull();
  });
});

describe("enqueueSesAccount", () => {
  test("enqueues a ses_account job", () => {
    const db = openMailDatabase(":memory:");

    enqueueSesAccount(createJobQueue({ db, claimedBy: "test:1" }));

    expect(db.query("SELECT kind, subject_key FROM jobs").all()).toEqual([
      { kind: "ses_account", subject_key: "account" },
    ]);
  });
});
