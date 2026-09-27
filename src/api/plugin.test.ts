import { describe, expect, test } from "bun:test";
import { createApiRoutes } from "./plugin";
import { openDatabase } from "../db/client";
import { createEmailsRepo } from "../db/emails";
import { createImapStateRepo } from "../db/imap-state";
import { createSubmissionsRepo } from "../db/submissions";
import { JEV_MAX_ATTEMPTS } from "../db/jev-queue";

const API_KEY = "local-api-key-1234567";

// A default parameter would also fire for an *explicit* `undefined`, which
// is exactly the case the "key unset" test needs to express — so this takes
// a plain positional argument instead of a defaulted options object.
function testApp(apiKey: string | undefined) {
  const db = openDatabase(":memory:");
  const emails = createEmailsRepo(db);
  const submissions = createSubmissionsRepo(db);

  const app = createApiRoutes({
    apiKey,
    emails,
    submissions,
    imapState: createImapStateRepo(db),
    runSync: async () => ({
      outbound: { new: 0, updated: 0 },
      inbound: { new: 0 },
      errors: [],
    }),
  });

  return { app, emails, submissions };
}

function testAppWithDb(apiKey: string | undefined) {
  const db = openDatabase(":memory:");
  const app = createApiRoutes({
    apiKey,
    emails: createEmailsRepo(db),
    submissions: createSubmissionsRepo(db),
    imapState: createImapStateRepo(db),
    runSync: async () => ({
      outbound: { new: 0, updated: 0 },
      inbound: { new: 0 },
      errors: [],
    }),
  });
  return { app, db };
}

function authHeaders(key = API_KEY) {
  return { authorization: `Bearer ${key}` };
}

describe("API auth", () => {
  test("API_KEY unset -> every /api route 404s", async () => {
    const { app } = testApp(undefined);

    const response = await app.handle(
      new Request("http://localhost/api/stats"),
    );

    expect(response.status).toBe(404);
  });

  test("wrong key -> 401", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/stats", {
        headers: authHeaders("wrong-key-0123456789"),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("missing bearer -> 401", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/stats"),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/emails", () => {
  test("filters return the expected ids", async () => {
    const { app, emails } = testApp(API_KEY);
    emails.upsertEmail({
      id: "in_1",
      direction: "inbound",
      fromAddress: "guest@example.com",
      toAddresses: ["charter@example.com"],
      subject: "Charter request",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    emails.upsertEmail({
      id: "out_1",
      direction: "outbound",
      fromAddress: "no-reply@example.com",
      toAddresses: ["guest@example.com"],
      subject: "Confirmation",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const response = await app.handle(
      new Request("http://localhost/api/emails?direction=inbound", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((e) => e.id)).toEqual(["in_1"]);
  });

  test("provider and mailbox filters narrow the list and are returned", async () => {
    const { app, emails } = testApp(API_KEY);
    const base = {
      direction: "inbound" as const,
      fromAddress: "guest@example.com",
      toAddresses: ["hello@example.com"],
      subject: "Hi",
    };
    emails.upsertEmail({
      ...base,
      id: "resend_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    emails.upsertEmail({
      ...base,
      id: "imap_inbox",
      provider: "imap",
      mailbox: "INBOX",
      messageId: "<a@x>",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    emails.upsertEmail({
      ...base,
      id: "imap_spam",
      provider: "imap",
      mailbox: "Spam",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const get = async (query: string) => {
      const response = await app.handle(
        new Request(`http://localhost/api/emails?${query}`, {
          headers: authHeaders(),
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        data: { id: string; provider: string; mailbox: string | null }[];
      };
    };

    expect((await get("provider=resend")).data.map((e) => e.id)).toEqual([
      "resend_1",
    ]);
    const imap = await get("provider=imap");
    expect(imap.data.map((e) => e.id)).toEqual(["imap_spam", "imap_inbox"]);
    expect(imap.data[1]).toMatchObject({ provider: "imap", mailbox: "INBOX" });
    expect(
      (await get("provider=imap&mailbox=Spam")).data.map((e) => e.id),
    ).toEqual(["imap_spam"]);

    const invalid = await app.handle(
      new Request("http://localhost/api/emails?provider=smtp", {
        headers: authHeaders(),
      }),
    );
    expect(invalid.status).toBe(422);
  });

  test("no filters returns every direction and enrichment status", async () => {
    const { app, emails } = testApp(API_KEY);
    emails.upsertEmail({
      id: "in_1",
      direction: "inbound",
      fromAddress: "guest@example.com",
      toAddresses: ["charter@example.com"],
      subject: "Charter request",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    emails.upsertEmail({
      id: "out_1",
      direction: "outbound",
      fromAddress: "no-reply@example.com",
      toAddresses: ["guest@example.com"],
      subject: "Confirmation",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    emails.saveEnrichment("out_1", {
      category: "notification",
      priority: "low",
      actionRequired: false,
      summary: "Confirmation.",
      suggestedAction: null,
      language: "en",
      facts: [],
      model: "test",
    });

    const response = await app.handle(
      new Request("http://localhost/api/emails", { headers: authHeaders() }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((e) => e.id)).toEqual(["out_1", "in_1"]);
  });

  test("category accepts a comma-separated list", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/emails?category=spam,inquiry", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe("GET /api/emails/:id", () => {
  test("404 for an unknown id", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/emails/missing", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("excludes html by default and includes it with ?include=html", async () => {
    const { app, emails } = testApp(API_KEY);
    emails.upsertEmail({
      id: "email_1",
      direction: "outbound",
      fromAddress: "no-reply@example.com",
      toAddresses: ["guest@example.com"],
      subject: "Confirmation",
      createdAt: "2026-01-01T00:00:00.000Z",
      html: "<p>hi</p>",
      text: "hi",
    });

    const withoutHtml = await app.handle(
      new Request("http://localhost/api/emails/email_1", {
        headers: authHeaders(),
      }),
    );
    const withoutHtmlBody = (await withoutHtml.json()) as Record<
      string,
      unknown
    >;
    expect(withoutHtmlBody.html).toBeUndefined();
    expect(withoutHtmlBody.text).toBe("hi");

    const withHtml = await app.handle(
      new Request("http://localhost/api/emails/email_1?include=html", {
        headers: authHeaders(),
      }),
    );
    const withHtmlBody = (await withHtml.json()) as Record<string, unknown>;
    expect(withHtmlBody.html).toBe("<p>hi</p>");
  });
});

describe("POST /api/emails/:id/enrich", () => {
  test("409 when another worker holds the claim", async () => {
    const { app, emails } = testApp(API_KEY);
    emails.upsertEmail({
      id: "email_1",
      direction: "outbound",
      fromAddress: "no-reply@example.com",
      toAddresses: ["guest@example.com"],
      subject: "Confirmation",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(emails.claimEnrichment("email_1")).toBe(true);

    const response = await app.handle(
      new Request("http://localhost/api/emails/email_1/enrich", {
        method: "POST",
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "enrichment_in_progress",
    });
  });
});

describe("Jev shadow fields", () => {
  const jev = {
    verdict: "marketing" as const,
    confidence: 0.9,
    probabilities: { legit: 0.05, spam: 0.05, marketing: 0.9 },
    latencyMs: 800,
    model: "jev-test",
  };
  const get = async (app: ReturnType<typeof testApp>["app"], path: string) =>
    (
      await app.handle(
        new Request(`http://localhost${path}`, { headers: authHeaders() }),
      )
    ).json();

  test("GET /api/submissions and /api/stats expose Jev verdicts, queue state, agreement and latencies", async () => {
    const { app, submissions } = testApp(API_KEY);
    const base = {
      source: "fpp" as const,
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: true,
      submission: {},
      jevPending: true,
    };
    const completeNext = () =>
      submissions.completeJev({
        ...submissions.claimNextJev()!,
        result: jev,
      });
    submissions.recordSubmission({
      ...base,
      verdict: "marketing",
      llmLatencyMs: 2000,
    });
    completeNext();
    submissions.recordSubmission({
      ...base,
      verdict: "legit",
      llmLatencyMs: 4000,
    });
    completeNext();
    // Fails on every attempt until it gives up.
    submissions.recordSubmission({ ...base, verdict: "legit" });
    let clock = Date.now();
    for (let attempt = 0; attempt < JEV_MAX_ATTEMPTS; attempt++) {
      const now = new Date(clock);
      submissions.failJev({
        ...submissions.claimNextJev({ now })!,
        error: "429 high demand",
        now,
      });
      clock += 2 * 24 * 60 * 60_000;
    }
    submissions.recordSubmission({ ...base, verdict: "legit" });
    submissions.recordSubmission({
      ...base,
      verdict: "legit",
      jevPending: false,
    });

    const list = (await get(app, "/api/submissions")) as {
      data: {
        jev: {
          status: string;
          attempts: number;
          nextAttemptAt: string | null;
          verdict: string | null;
          latencyMs: number | null;
          error: string | null;
        } | null;
        llmLatencyMs: number | null;
      }[];
    };
    const byStatus = (status: string | null) =>
      list.data.filter((row) => (row.jev?.status ?? null) === status);
    expect(byStatus("done")).toHaveLength(2);
    expect(byStatus("done")[0]!.jev).toMatchObject({
      verdict: "marketing",
      latencyMs: 800,
      attempts: 1,
    });
    expect(byStatus("done")[0]!.llmLatencyMs).not.toBeNull();
    expect(byStatus("pending")[0]!.jev).toMatchObject({
      attempts: 0,
      nextAttemptAt: null,
      verdict: null,
      latencyMs: null,
    });
    expect(byStatus("failed")[0]!.jev).toMatchObject({
      attempts: JEV_MAX_ATTEMPTS,
      nextAttemptAt: null,
      error: "429 high demand",
    });
    expect(byStatus(null)).toHaveLength(1);

    const stats = (await get(app, "/api/stats")) as {
      jevComparison: unknown;
      jevQueue: unknown;
    };
    expect(stats.jevComparison).toEqual({
      compared: 2,
      agreed: 1,
      agreementRate: 0.5,
      llmMedianLatencyMs: 3000,
      jevMedianLatencyMs: 800,
    });
    expect(stats.jevQueue).toEqual({ pending: 1, failed: 1 });
  });

  test("GET /api/emails/:id exposes Jev's queue state, then its decision", async () => {
    const { app, emails } = testApp(API_KEY);
    emails.upsertEmail({
      id: "in_1",
      direction: "inbound",
      fromAddress: "x@example.com",
      toAddresses: ["me@example.com"],
      subject: "Hi",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    emails.upsertEmail({
      id: "out_1",
      direction: "outbound",
      fromAddress: "me@example.com",
      toAddresses: ["x@example.com"],
      subject: "Re: Hi",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const jevOf = async (id: string) =>
      (
        (await get(app, `/api/emails/${id}`)) as {
          enrichment: { jev: unknown };
        }
      ).enrichment.jev;

    expect(await jevOf("in_1")).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      spamProbability: null,
    });
    expect(await jevOf("out_1")).toBeNull();

    emails.completeJev({
      ...emails.claimNextJev()!,
      result: {
        spamProbability: 0.96,
        category: "marketing",
        categoryConfidence: 0.9,
        latencyMs: 700,
        model: "jev-test",
      },
    });

    expect(await jevOf("in_1")).toEqual({
      status: "done",
      attempts: 1,
      nextAttemptAt: null,
      spamProbability: 0.96,
      category: "marketing",
      categoryConfidence: 0.9,
      latencyMs: 700,
      model: "jev-test",
      error: null,
    });
  });
});
