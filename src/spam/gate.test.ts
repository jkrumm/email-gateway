import { describe, expect, test } from "bun:test";
import { gateSubmission } from "./gate";
import type { ClassificationResult } from "./classify";
import { openMailDatabase } from "../db/mail-client";
import { createMailSubmissionsRepo } from "../db/mail-submissions";

function classifyResult(
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    verdict: "legit",
    confidence: 0,
    reason: "test reason",
    model: "test-model",
    ...overrides,
  };
}

function instantClassify(result: ClassificationResult) {
  return async () => result;
}

function delayedClassify(result: ClassificationResult, delayMs: number) {
  return () =>
    new Promise<ClassificationResult>((resolve) => {
      setTimeout(() => resolve(result), delayMs);
    });
}

function deliverSpy(impl?: () => Promise<void>) {
  const calls: { subjectPrefix: string }[] = [];
  const deliver = async (opts: { subjectPrefix: string }) => {
    calls.push(opts);
    if (impl) await impl();
  };
  return { deliver, calls };
}

function testSubmissionsRepo() {
  return createMailSubmissionsRepo(openMailDatabase(":memory:"));
}

describe("gateSubmission", () => {
  test("suppresses a high-confidence spam verdict without delivering", async () => {
    const { deliver, calls } = deliverSpy();
    const classify = instantClassify(
      classifyResult({
        verdict: "spam",
        confidence: 0.9,
        reason: "looks spammy",
      }),
    );
    const submissions = testSubmissionsRepo();

    const result = await gateSubmission({
      source: "fpp",
      submission: { email: "a@b.com" },
      deliver,
      classify,
      record: submissions.insertSubmission,
    });

    expect(result).toEqual({ delivered: false });
    expect(calls).toHaveLength(0);
    const [record] = submissions.listSubmissions().data;
    expect(record?.delivered).toBe(false);
    expect(record?.verdict).toBe("spam");
  });

  test("delivers a low-confidence marketing verdict with the possible-spam prefix", async () => {
    const { deliver, calls } = deliverSpy();
    const classify = instantClassify(
      classifyResult({
        verdict: "marketing",
        confidence: 0.5,
        reason: "maybe marketing",
      }),
    );
    const submissions = testSubmissionsRepo();

    const result = await gateSubmission({
      source: "fpp",
      submission: { email: "a@b.com" },
      deliver,
      classify,
      record: submissions.insertSubmission,
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toEqual([{ subjectPrefix: "[Possible spam] " }]);
  });

  test("delivers a legit verdict with no prefix", async () => {
    const { deliver, calls } = deliverSpy();
    const classify = instantClassify(
      classifyResult({ verdict: "legit", confidence: 0.95, reason: "genuine" }),
    );
    const submissions = testSubmissionsRepo();

    const result = await gateSubmission({
      source: "fpp",
      submission: { email: "a@b.com" },
      deliver,
      classify,
      record: submissions.insertSubmission,
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toEqual([{ subjectPrefix: "" }]);
  });

  test("fails open on a slow classifier and records the late verdict after the deadline", async () => {
    const { deliver, calls } = deliverSpy();
    const classify = delayedClassify(
      classifyResult({ verdict: "spam", confidence: 0.9, reason: "late spam" }),
      50,
    );
    const submissions = testSubmissionsRepo();

    const result = await gateSubmission({
      source: "fpp",
      submission: { email: "a@b.com" },
      deliver,
      classify,
      record: submissions.insertSubmission,
      deadlineMs: 10,
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toEqual([{ subjectPrefix: "" }]);
    expect(submissions.listSubmissions().data).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const [record] = submissions.listSubmissions().data;
    expect(record?.delivered).toBe(true);
    expect(record?.reason).toBe("Decided after deadline: late spam");
  });

  test("a throwing record() is logged and swallowed — delivery still succeeds", async () => {
    const { deliver, calls } = deliverSpy();
    const classify = instantClassify(
      classifyResult({ verdict: "legit", confidence: 0.95, reason: "genuine" }),
    );
    const record: ReturnType<
      typeof createMailSubmissionsRepo
    >["insertSubmission"] = () => {
      throw new Error("unable to open database file");
    };

    const result = await gateSubmission({
      source: "fpp",
      submission: { email: "a@b.com" },
      deliver,
      classify,
      record,
    });

    expect(result).toEqual({ delivered: true });
    expect(calls).toEqual([{ subjectPrefix: "" }]);
  });

  test("rethrows and records delivered:false when delivery fails", async () => {
    const classify = instantClassify(
      classifyResult({ verdict: "legit", confidence: 0.9, reason: "genuine" }),
    );
    const { deliver } = deliverSpy(async () => {
      throw new Error("resend down");
    });
    const submissions = testSubmissionsRepo();

    await expect(
      gateSubmission({
        source: "fpp",
        submission: { email: "a@b.com" },
        deliver,
        classify,
        record: submissions.insertSubmission,
      }),
    ).rejects.toThrow("resend down");

    const [record] = submissions.listSubmissions().data;
    expect(record?.delivered).toBe(false);
    expect(record?.reason).toBe("genuine · delivery failed");
  });

  describe("Jev enqueue", () => {
    const gate = (
      submissions: ReturnType<typeof testSubmissionsRepo>,
      overrides: Partial<Parameters<typeof gateSubmission>[0]> = {},
    ) =>
      gateSubmission({
        source: "fpp",
        submission: { email: "a@b.com" },
        deliver: async () => {},
        classify: instantClassify(
          classifyResult({ verdict: "legit", confidence: 0.95 }),
        ),
        record: submissions.insertSubmission,
        ...overrides,
      });

    test("enqueues a jev_submission job for the recorded row, without affecting delivery", async () => {
      const { deliver, calls } = deliverSpy();
      const submissions = testSubmissionsRepo();
      const enqueued: string[] = [];

      const result = await gate(submissions, {
        deliver,
        jevEnabled: () => true,
        enqueueJevSubmission: (id) => enqueued.push(id),
      });

      expect(result).toEqual({ delivered: true });
      expect(calls).toEqual([{ subjectPrefix: "" }]);
      const [record] = submissions.listSubmissions().data;
      expect(record?.jev).toBeNull();
      expect(enqueued).toEqual([record!.id]);
    });

    test("enqueues suppressed submissions too", async () => {
      const submissions = testSubmissionsRepo();
      const enqueued: string[] = [];

      const result = await gate(submissions, {
        classify: instantClassify(
          classifyResult({ verdict: "spam", confidence: 0.99 }),
        ),
        jevEnabled: () => true,
        enqueueJevSubmission: (id) => enqueued.push(id),
      });

      expect(result).toEqual({ delivered: false });
      const [record] = submissions.listSubmissions().data;
      expect(enqueued).toEqual([record!.id]);
    });

    test("a verdict that lands after the deadline is enqueued once it is recorded", async () => {
      const submissions = testSubmissionsRepo();
      const enqueued: string[] = [];

      await gate(submissions, {
        classify: delayedClassify(
          classifyResult({ verdict: "legit", confidence: 0.95 }),
          50,
        ),
        deadlineMs: 5,
        jevEnabled: () => true,
        enqueueJevSubmission: (id) => enqueued.push(id),
      });
      expect(submissions.listSubmissions().data).toHaveLength(0);
      expect(enqueued).toEqual([]);

      await Bun.sleep(80);

      const [record] = submissions.listSubmissions().data;
      expect(enqueued).toEqual([record!.id]);
    });

    test("never enqueues when Jev is disabled", async () => {
      const submissions = testSubmissionsRepo();
      const enqueued: string[] = [];

      await gate(submissions, {
        jevEnabled: () => false,
        enqueueJevSubmission: (id) => enqueued.push(id),
      });

      expect(submissions.listSubmissions().data).toHaveLength(1);
      expect(enqueued).toEqual([]);
    });

    test("a throwing enqueue never breaks the gate, and the submission still commits", async () => {
      const submissions = testSubmissionsRepo();

      const result = await gate(submissions, {
        jevEnabled: () => true,
        enqueueJevSubmission: () => {
          throw new Error("boom");
        },
      });

      expect(result).toEqual({ delivered: true });
      // The enqueue is deliberately NOT transactional with the insert: the
      // authoritative, already-delivered submission record must survive a
      // failure in the non-authoritative, shadow-only Jev enqueue — only the
      // Jev job is lost, invisibly and harmlessly (see the comment in
      // gate.ts's `persist`).
      expect(submissions.listSubmissions().data).toHaveLength(1);
    });
  });
});
