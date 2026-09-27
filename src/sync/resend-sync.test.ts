import { describe, expect, test } from "bun:test";
import type { ResendClient } from "../providers/resend/client";
import { openDatabase } from "../db/client";
import { createEmailsRepo } from "../db/emails";
import { syncEmails } from "./resend-sync";

interface OutboundFixture {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  last_event:
    | "bounced"
    | "canceled"
    | "clicked"
    | "complained"
    | "delivered"
    | "delivery_delayed"
    | "failed"
    | "opened"
    | "queued"
    | "scheduled"
    | "sent"
    | "suppressed";
  html: string | null;
  text: string | null;
  bcc: string[] | null;
  cc: string[] | null;
  reply_to: string[] | null;
  message_id: string;
  scheduled_at: string | null;
}

function emptyReceivingFake() {
  return {
    list: async () => ({
      data: { object: "list" as const, has_more: false, data: [] },
      error: null,
    }),
    get: async () => ({
      data: null,
      error: {
        message: "not found",
        statusCode: 404,
        name: "not_found" as const,
      },
      headers: null,
    }),
  };
}

// Ignores `limit`, always returns a single item per call so a handful of
// fixtures is enough to exercise multi-page pagination.
function makeOutboundFake(
  fixtures: OutboundFixture[],
  options: {
    error?: {
      message: string;
      statusCode: number;
      name: "rate_limit_exceeded";
    };
  } = {},
): ResendClient {
  return {
    emails: {
      list: async ({ after }: { limit?: number; after?: string }) => {
        if (options.error) {
          return { data: null, error: options.error, headers: null };
        }
        // Resend pages newest-first; sort here so `after` cursor semantics
        // match production regardless of fixture insertion order.
        const sorted = [...fixtures].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        );
        const startIndex = after
          ? sorted.findIndex((item) => item.id === after) + 1
          : 0;
        const page = sorted.slice(startIndex, startIndex + 1);
        return {
          data: {
            object: "list" as const,
            has_more: startIndex + page.length < sorted.length,
            data: page.map(({ html: _html, text: _text, ...rest }) => rest),
          },
          error: null,
          headers: null,
        };
      },
      get: async (id: string) => {
        const full = fixtures.find((item) => item.id === id);
        if (!full) {
          return {
            data: null,
            error: {
              message: "not found",
              statusCode: 404,
              name: "not_found" as const,
            },
            headers: null,
          };
        }
        return {
          data: { ...full, object: "email" as const },
          error: null,
          headers: null,
        };
      },
      receiving: emptyReceivingFake(),
    },
  };
}

function fixture(overrides: Partial<OutboundFixture> = {}): OutboundFixture {
  return {
    id: "email_1",
    from: "no-reply@example.com",
    to: ["guest@example.com"],
    subject: "Hello",
    created_at: "2026-01-01T00:00:00.000Z",
    last_event: "delivered",
    html: "<p>hi</p>",
    text: "hi",
    bcc: null,
    cc: null,
    reply_to: null,
    message_id: "msg_1",
    scheduled_at: null,
    ...overrides,
  };
}

describe("syncEmails", () => {
  test("backfills every page of an empty db", async () => {
    const db = openDatabase(":memory:");
    const emails = createEmailsRepo(db);
    const resend = makeOutboundFake([
      fixture({ id: "email_1" }),
      fixture({ id: "email_2", created_at: "2026-01-02T00:00:00.000Z" }),
    ]);

    const summary = await syncEmails({ db, resend });

    expect(summary.outbound.new).toBe(2);
    expect(summary.errors).toEqual([]);
    expect(emails.getEmail("email_1")?.html).toBe("<p>hi</p>");
    expect(emails.getEmail("email_2")?.html).toBe("<p>hi</p>");
  });

  test("a second run only fetches the one new email", async () => {
    const db = openDatabase(":memory:");
    const emails = createEmailsRepo(db);
    const fixtures = [
      fixture({ id: "email_1" }),
      fixture({ id: "email_2", created_at: "2026-01-02T00:00:00.000Z" }),
    ];

    await syncEmails({ db, resend: makeOutboundFake(fixtures) });

    fixtures.push(
      fixture({ id: "email_3", created_at: "2026-01-03T00:00:00.000Z" }),
    );
    const secondSummary = await syncEmails({
      db,
      resend: makeOutboundFake(fixtures),
    });

    expect(secondSummary.outbound.new).toBe(1);
    expect(emails.getEmail("email_3")).not.toBeNull();
  });

  test("fills html/text for a known outbound row whose html is null", async () => {
    const db = openDatabase(":memory:");
    const emails = createEmailsRepo(db);

    // Simulates sendMail()'s minimal insert: known id, no html yet.
    emails.upsertEmail({
      id: "email_1",
      direction: "outbound",
      fromAddress: "no-reply@example.com",
      toAddresses: ["guest@example.com"],
      subject: "Hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(emails.getEmail("email_1")?.html).toBeNull();

    const resend = makeOutboundFake([fixture({ id: "email_1" })]);
    const summary = await syncEmails({ db, resend });

    expect(summary.outbound.updated).toBe(1);
    expect(emails.getEmail("email_1")?.html).toBe("<p>hi</p>");
  });

  test("a run that fails on page 2 doesn't lose older emails — the next run pages past the known first page", async () => {
    const db = openDatabase(":memory:");
    const emails = createEmailsRepo(db);

    const fixtures = [
      fixture({ id: "email_old", created_at: "2026-01-01T00:00:00.000Z" }),
      fixture({ id: "email_mid", created_at: "2026-01-02T00:00:00.000Z" }),
      fixture({ id: "email_new", created_at: "2026-01-03T00:00:00.000Z" }),
    ];

    let listCalls = 0;
    const failingOnPage2: ResendClient = {
      emails: {
        list: async ({ after }: { limit?: number; after?: string }) => {
          listCalls++;
          if (listCalls === 2) {
            return {
              data: null,
              error: {
                message: "boom",
                statusCode: 500,
                name: "internal_server_error" as const,
              },
              headers: null,
            };
          }
          const sorted = [...fixtures].sort((a, b) =>
            b.created_at.localeCompare(a.created_at),
          );
          const startIndex = after
            ? sorted.findIndex((item) => item.id === after) + 1
            : 0;
          const page = sorted.slice(startIndex, startIndex + 1);
          return {
            data: {
              object: "list" as const,
              has_more: startIndex + page.length < sorted.length,
              data: page.map(({ html: _html, text: _text, ...rest }) => rest),
            },
            error: null,
            headers: null,
          };
        },
        get: async (id: string) => {
          const full = fixtures.find((item) => item.id === id);
          if (!full) {
            return {
              data: null,
              error: {
                message: "not found",
                statusCode: 404,
                name: "not_found" as const,
              },
              headers: null,
            };
          }
          return {
            data: { ...full, object: "email" as const },
            error: null,
            headers: null,
          };
        },
        receiving: emptyReceivingFake(),
      },
    };

    const run1 = await syncEmails({ db, resend: failingOnPage2 });
    expect(run1.errors.length).toBeGreaterThan(0);
    expect(emails.getEmail("email_new")).not.toBeNull();
    expect(emails.getEmail("email_mid")).toBeNull();
    expect(emails.getEmail("email_old")).toBeNull();

    const run2 = await syncEmails({ db, resend: makeOutboundFake(fixtures) });

    expect(run2.errors).toEqual([]);
    expect(emails.getEmail("email_mid")).not.toBeNull();
    expect(emails.getEmail("email_old")).not.toBeNull();
  });

  test("reports a Resend {error} page instead of throwing", async () => {
    const db = openDatabase(":memory:");
    const resend = makeOutboundFake([], {
      error: {
        message: "Rate limit exceeded",
        statusCode: 429,
        name: "rate_limit_exceeded",
      },
    });

    const result = await syncEmails({ db, resend });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Rate limit exceeded");
  }, 10_000);
});
