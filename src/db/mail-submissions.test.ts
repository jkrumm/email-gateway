import { describe, expect, test } from "bun:test";
import { createMailSubmissionsRepo } from "./mail-submissions";
import { openMailDatabase } from "./mail-client";

function setup() {
  return createMailSubmissionsRepo(openMailDatabase(":memory:"));
}

describe("mail submissions repo", () => {
  test("insertSubmission records a row with no jev result yet", () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.95,
      reason: "looks fine",
      model: "test-model",
      delivered: true,
      submission: { name: "Jane", message: "hi" },
      llmLatencyMs: 250,
    });

    expect(record.jev).toBeNull();
    expect(submissions.getSubmission(record.id)).toMatchObject({
      source: "fpp",
      verdict: "legit",
      delivered: true,
      submission: { name: "Jane", message: "hi" },
      jev: null,
    });
  });

  test("getSubmission returns null for an unknown id", () => {
    const submissions = setup();
    expect(submissions.getSubmission("missing")).toBeNull();
  });

  test("saveJevResult stores a successful verdict", () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "sy-serendipity",
      verdict: "spam",
      confidence: 0.8,
      reason: "spammy",
      model: "test-model",
      delivered: false,
      submission: { name: "Bot" },
    });

    submissions.saveJevResult(record.id, {
      verdict: "spam",
      confidence: 0.99,
      probabilities: { spam: 0.99, legit: 0.01 },
      latencyMs: 340,
      model: "jev-model",
    });

    expect(submissions.getSubmission(record.id)?.jev).toEqual({
      verdict: "spam",
      confidence: 0.99,
      probabilities: { spam: 0.99, legit: 0.01 },
      latencyMs: 340,
      model: "jev-model",
      error: null,
    });
  });

  test("saveJevResult stores a terminal failure and clears any previous verdict fields", () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.7,
      reason: "ok",
      model: "test-model",
      delivered: true,
      submission: {},
    });

    submissions.saveJevResult(record.id, {
      verdict: "legit",
      confidence: 0.6,
      probabilities: null,
      latencyMs: 100,
      model: "jev-model",
    });
    submissions.saveJevResult(record.id, {
      error: "rate_limit_exceeded",
      model: "jev-model",
    });

    expect(submissions.getSubmission(record.id)?.jev).toEqual({
      verdict: null,
      confidence: null,
      probabilities: null,
      latencyMs: null,
      model: "jev-model",
      error: "rate_limit_exceeded",
    });
  });

  test("listSubmissions filters by verdict/source/delivered and paginates newest-first", () => {
    const submissions = setup();
    for (let i = 0; i < 3; i++) {
      submissions.insertSubmission({
        source: i === 0 ? "sy-serendipity" : "fpp",
        verdict: i === 1 ? "spam" : "legit",
        confidence: 0.5,
        reason: "r",
        model: null,
        delivered: i !== 2,
        submission: { i },
      });
    }

    expect(
      submissions.listSubmissions({ source: "sy-serendipity" }).data,
    ).toHaveLength(1);
    expect(submissions.listSubmissions({ verdict: "spam" }).data).toHaveLength(
      1,
    );
    expect(submissions.listSubmissions({ delivered: false }).data).toHaveLength(
      1,
    );

    const page1 = submissions.listSubmissions({ limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = submissions.listSubmissions({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.data, ...page2.data].map((r) => r.id);
    expect(new Set(allIds).size).toBe(3);
  });

  test("getJevComparison computes agreement rate and median latencies", () => {
    const submissions = setup();
    const since = "2026-01-01T00:00:00.000Z";

    const agree = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: true,
      submission: {},
      llmLatencyMs: 100,
    });
    submissions.saveJevResult(agree.id, {
      verdict: "legit",
      confidence: 0.9,
      probabilities: null,
      latencyMs: 200,
      model: "jev",
    });

    const disagree = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: true,
      submission: {},
      llmLatencyMs: 300,
    });
    submissions.saveJevResult(disagree.id, {
      verdict: "spam",
      confidence: 0.9,
      probabilities: null,
      latencyMs: 400,
      model: "jev",
    });

    // Not yet judged by Jev — excluded from the comparison.
    submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: true,
      submission: {},
    });

    const comparison = submissions.getJevComparison({ since });
    expect(comparison.compared).toBe(2);
    expect(comparison.agreed).toBe(1);
    expect(comparison.agreementRate).toBe(0.5);
    expect(comparison.llmMedianLatencyMs).toBe(200);
    expect(comparison.jevMedianLatencyMs).toBe(300);
  });
});
