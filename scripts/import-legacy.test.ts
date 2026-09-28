import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/client";
import { createSubmissionsRepo } from "../src/db/submissions";
import { openMailDatabase } from "../src/db/mail-index";
import { createMailSubmissionsRepo } from "../src/db/mail-submissions";
import { createJobQueue } from "../src/db/jobs";
import { importLegacySubmissions } from "./import-legacy";

function seedOldDb() {
  const oldDb = openDatabase(":memory:");
  const oldSubmissions = createSubmissionsRepo(oldDb);

  const judged = oldSubmissions.recordSubmission({
    source: "fpp",
    verdict: "spam",
    confidence: 0.9,
    reason: "looks like spam",
    model: "test-model",
    delivered: false,
    submission: { message: "buy now" },
    jevPending: true,
  });
  oldSubmissions.completeJev({
    ...oldSubmissions.claimNextJev()!,
    result: {
      verdict: "spam",
      confidence: 0.88,
      probabilities: { legit: 0.05, spam: 0.88, marketing: 0.07 },
      latencyMs: 42,
      model: "typesafe-ai/jev",
    },
  });

  const unjudged = oldSubmissions.recordSubmission({
    source: "sy-serendipity",
    verdict: "legit",
    confidence: 0.95,
    reason: "genuine charter inquiry",
    model: "test-model",
    delivered: true,
    submission: { destination: "Ibiza" },
  });

  return {
    oldDb,
    judgedId: judged.id,
    judgedReceivedAt: judged.receivedAt,
    unjudgedId: unjudged.id,
  };
}

describe("importLegacySubmissions", () => {
  test("preserves the original id, receivedAt, verdict and Jev fields", () => {
    const { oldDb, judgedId, judgedReceivedAt, unjudgedId } = seedOldDb();
    const newDb = openMailDatabase(":memory:");

    const result = importLegacySubmissions({ oldDb, newDb });
    expect(result).toEqual({ imported: 2, alreadyPresent: 0, rejected: 0 });

    const newSubmissions = createMailSubmissionsRepo(newDb);
    const judged = newSubmissions.getSubmission(judgedId)!;
    expect(judged.id).toBe(judgedId);
    // receivedAt is preserved exactly — never re-minted by the import.
    expect(judged.receivedAt).toBe(judgedReceivedAt);
    expect(judged.source).toBe("fpp");
    expect(judged.verdict).toBe("spam");
    expect(judged.delivered).toBe(false);
    expect(judged.submission).toEqual({ message: "buy now" });
    expect(judged.jev).toEqual({
      verdict: "spam",
      confidence: 0.88,
      probabilities: { legit: 0.05, spam: 0.88, marketing: 0.07 },
      latencyMs: 42,
      model: "typesafe-ai/jev",
      error: null,
    });

    const unjudged = newSubmissions.getSubmission(unjudgedId)!;
    expect(unjudged.id).toBe(unjudgedId);
    expect(unjudged.jev).toBeNull();
  });

  test("running twice does not duplicate or error", () => {
    const { oldDb } = seedOldDb();
    const newDb = openMailDatabase(":memory:");

    const first = importLegacySubmissions({ oldDb, newDb });
    expect(first).toEqual({ imported: 2, alreadyPresent: 0, rejected: 0 });

    const second = importLegacySubmissions({ oldDb, newDb });
    expect(second).toEqual({ imported: 0, alreadyPresent: 2, rejected: 0 });

    const { data } = createMailSubmissionsRepo(newDb).listSubmissions({
      limit: 100,
    });
    expect(data).toHaveLength(2);
  });

  test("a row still awaiting Jev at cutover gets a jev_submission job; a decided or Jev-less row does not", () => {
    const oldDb = openDatabase(":memory:");
    const oldSubmissions = createSubmissionsRepo(oldDb);

    // Recorded (and completed) before the still-pending row below, so
    // claimNextJev — FIFO, oldest pending first — claims this one and
    // leaves the later row genuinely pending.
    oldSubmissions.recordSubmission({
      source: "fpp",
      verdict: "spam",
      confidence: 0.9,
      reason: "looks like spam",
      model: "test-model",
      delivered: false,
      submission: { message: "buy now" },
      jevPending: true,
    });
    oldSubmissions.completeJev({
      ...oldSubmissions.claimNextJev()!,
      result: {
        verdict: "spam",
        confidence: 0.88,
        probabilities: { legit: 0.05, spam: 0.88, marketing: 0.07 },
        latencyMs: 42,
        model: "typesafe-ai/jev",
      },
    });

    const pending = oldSubmissions.recordSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.6,
      reason: "borderline",
      model: "test-model",
      delivered: true,
      submission: { message: "still waiting on Jev" },
      jevPending: true,
    });

    oldSubmissions.recordSubmission({
      source: "sy-serendipity",
      verdict: "legit",
      confidence: 0.95,
      reason: "genuine charter inquiry",
      model: "test-model",
      delivered: true,
      submission: { destination: "Ibiza" },
    });

    const newDb = openMailDatabase(":memory:");
    const jobs = createJobQueue({ db: newDb, claimedBy: "test:1" });

    const result = importLegacySubmissions({ oldDb, newDb, jobs });
    expect(result).toEqual({ imported: 3, alreadyPresent: 0, rejected: 0 });

    expect(jobs.counts()).toEqual({ pending: 1, failed: 0 });
    const claim = jobs.claimNext({ kinds: ["jev_submission"] });
    expect(claim?.payload).toEqual({ id: pending.id });

    // Re-running the import while the row is still unjudged in the new store
    // enqueues again — the enqueue decision is derived from durable state
    // (still unjudged), not "was this row freshly imported this run", which
    // is exactly what lets a genuinely crashed-mid-import re-run retry a
    // stranded enqueue (see the dedicated regression test below). A second
    // job for an already-pending row is an accepted minor inefficiency here.
    const second = importLegacySubmissions({ oldDb, newDb, jobs });
    expect(second).toEqual({ imported: 0, alreadyPresent: 3, rejected: 0 });
    expect(jobs.counts()).toEqual({ pending: 2, failed: 0 });
  });

  test("a pending row with a recorded jev_error (a failed attempt still awaiting retry, e.g. the 2026-09-28 429 burst) still gets re-enqueued", () => {
    const oldDb = openDatabase(":memory:");
    const oldSubmissions = createSubmissionsRepo(oldDb);

    const pending = oldSubmissions.recordSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.6,
      reason: "borderline",
      model: "test-model",
      delivered: true,
      submission: { message: "hit a 429 on the first attempt" },
      jevPending: true,
    });
    // Fails the claim once — the queue stays "pending" (with backoff) rather
    // than moving to "failed", and now also carries a non-null jev_error.
    oldSubmissions.failJev({
      ...oldSubmissions.claimNextJev()!,
      error: "429 Too Many Requests",
      now: new Date("2026-09-28T00:00:00.000Z"),
    });

    const before = oldSubmissions
      .listSubmissions({ limit: 100 })
      .data.find((row) => row.id === pending.id);
    expect(before?.jev).toMatchObject({
      status: "pending",
      error: "429 Too Many Requests",
    });

    const newDb = openMailDatabase(":memory:");
    const jobs = createJobQueue({ db: newDb, claimedBy: "test:1" });

    const result = importLegacySubmissions({ oldDb, newDb, jobs });
    expect(result).toEqual({ imported: 1, alreadyPresent: 0, rejected: 0 });

    // The imported row's jev carries the error but no verdict — the old
    // `newJev === null` check would see this non-null object and wrongly
    // skip the re-enqueue.
    const imported = createMailSubmissionsRepo(newDb).getSubmission(pending.id);
    expect(imported?.jev).toMatchObject({
      verdict: null,
      error: "429 Too Many Requests",
    });

    expect(jobs.counts()).toEqual({ pending: 1, failed: 0 });
    const claim = jobs.claimNext({ kinds: ["jev_submission"] });
    expect(claim?.payload).toEqual({ id: pending.id });
  });

  test("a crash between a submission's insert and its enqueue is recovered on the next run", () => {
    const oldDb = openDatabase(":memory:");
    const oldSubmissions = createSubmissionsRepo(oldDb);

    const pending = oldSubmissions.recordSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.6,
      reason: "borderline",
      model: "test-model",
      delivered: true,
      submission: { message: "still waiting on Jev" },
      jevPending: true,
    });

    const newDb = openMailDatabase(":memory:");
    // Simulates the process dying right after the submission row's INSERT
    // committed but before the enqueue call landed: the row is imported,
    // but jobs.enqueue throws instead of ever writing a job row.
    const crashingJobs = {
      enqueue: () => {
        throw new Error("simulated crash before enqueue commits");
      },
    } as unknown as Parameters<typeof importLegacySubmissions>[0]["jobs"];

    expect(() =>
      importLegacySubmissions({ oldDb, newDb, jobs: crashingJobs }),
    ).toThrow("simulated crash before enqueue commits");

    // The submission row itself made it in before the simulated crash.
    expect(
      createMailSubmissionsRepo(newDb).getSubmission(pending.id),
    ).not.toBeNull();

    const realJobs = createJobQueue({ db: newDb, claimedBy: "test:1" });
    const second = importLegacySubmissions({ oldDb, newDb, jobs: realJobs });

    // The row is already present, not freshly imported — the old
    // freshly-imported-only check would have skipped the enqueue here
    // forever. The durable-state check instead sees it's still unjudged and
    // retries.
    expect(second).toEqual({ imported: 0, alreadyPresent: 1, rejected: 0 });
    expect(realJobs.counts()).toEqual({ pending: 1, failed: 0 });
    const claim = realJobs.claimNext({ kinds: ["jev_submission"] });
    expect(claim?.payload).toEqual({ id: pending.id });
  });

  test("a row that violates a constraint the old table never enforced is rejected, not counted as imported or already present", () => {
    const oldDb = openDatabase(":memory:");
    oldDb.run(
      `INSERT INTO submissions (
         id, received_at, source, verdict, confidence, reason, model,
         delivered, submission
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "bad-row",
        "2026-01-01T00:00:00.000Z",
        "not-a-real-source",
        "not-a-real-verdict",
        0.5,
        "malformed legacy row",
        null,
        1,
        "{}",
      ],
    );

    const newDb = openMailDatabase(":memory:");
    const result = importLegacySubmissions({ oldDb, newDb });

    expect(result).toEqual({ imported: 0, alreadyPresent: 0, rejected: 1 });
    expect(
      createMailSubmissionsRepo(newDb).listSubmissions({ limit: 100 }).data,
    ).toHaveLength(0);
  });
});
