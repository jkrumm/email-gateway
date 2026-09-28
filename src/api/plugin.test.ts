import { describe, expect, test } from "bun:test";
import { createApiRoutes } from "./plugin";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo, type MessageEnvelope } from "../db/messages";
import { createMailSubmissionsRepo } from "../db/mail-submissions";
import { createSendLogRepo } from "../db/send-log";
import { createTemplatesRepo } from "../db/templates";
import { createJobQueue } from "../db/jobs";
import { TEMPLATE_IDS } from "../emails/registry";
import type { MailProvider, Message, MessageRef } from "../providers/port";

const API_KEY = "local-api-key-1234567";
const ACCOUNT_ID = "proton:hello@example.com";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    key: "msg-1",
    account: ACCOUNT_ID,
    direction: "inbound",
    fromAddress: "sender@example.com",
    toAddresses: ["hello@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Hello there",
    date: "2026-01-01T00:00:00.000Z",
    size: 1024,
    hasAttachments: false,
    threadKey: null,
    flags: [],
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    id: "proton",
    account: "hello@example.com",
    capabilities: async () => ({
      list: true,
      read: true,
      search: false,
      flag: true,
      move: true,
      send: false,
      idle: false,
    }),
    listMailboxes: async () => [],
    list: async () => ({ items: [], cursor: undefined }),
    read: async (ref: MessageRef): Promise<Message> => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Hello there",
      date: "2026-01-01T00:00:00.000Z",
      size: 1024,
      hasAttachments: false,
      flags: [],
      html: null,
      text: null,
      attachments: [],
    }),
    search: async () => [],
    setFlags: async () => {},
    move: async (ref) => ref,
    send: async () => {
      throw new Error("not implemented in fake");
    },
    ...overrides,
  };
}

// A default parameter would also fire for an *explicit* `undefined`, which
// is exactly the case the "key unset" test needs to express — so this takes
// a plain positional argument instead of a defaulted options object.
function testApp(
  apiKey: string | undefined,
  {
    providerFor,
    configuredProviders,
  }: {
    providerFor?: (accountId: string) => MailProvider | null;
    configuredProviders?: () => MailProvider[];
  } = {},
) {
  const db = openMailDatabase(":memory:");
  const accounts = createAccountsRepo(db);
  const messages = createMessagesRepo(db);
  const mailSubmissions = createMailSubmissionsRepo(db);
  const templates = createTemplatesRepo(db);
  const sendLog = createSendLogRepo(db);
  const jobs = createJobQueue({ db, claimedBy: "test:1" });
  accounts.upsertAccount({
    id: ACCOUNT_ID,
    provider: "proton",
    address: "hello@example.com",
  });

  const app = createApiRoutes({
    apiKey,
    messages,
    mailSubmissions,
    accounts,
    templates,
    sendLog,
    jobs,
    providerFor: providerFor ?? (() => null),
    configuredProviders: configuredProviders ?? (() => []),
  });

  return { app, messages, mailSubmissions, accounts, jobs, templates, sendLog };
}

function authHeaders(key = API_KEY) {
  return { authorization: `Bearer ${key}` };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
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
    expect(await json(response)).toEqual({ error: "unauthorized" });
  });

  test("missing bearer -> 401", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/stats"),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/accounts", () => {
  test("lists every configured account, not just ones that have synced", async () => {
    const { app } = testApp(API_KEY, {
      configuredProviders: () => [
        fakeProvider({ id: "resend", account: "app" }),
        fakeProvider({ id: "proton", account: "hello@example.com" }),
        fakeProvider({ id: "gmail", account: "me@gmail.com" }),
      ],
    });

    const response = await app.handle(
      new Request("http://localhost/api/accounts", { headers: authHeaders() }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: "resend:app", provider: "resend", address: "app" },
      {
        id: "proton:hello@example.com",
        provider: "proton",
        address: "hello@example.com",
      },
      { id: "gmail:me@gmail.com", provider: "gmail", address: "me@gmail.com" },
    ]);
  });

  test("requires a bearer token like every other /api route", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/accounts"),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/messages", () => {
  test("needs_me=1 is sugar for actionRequired: true", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope({ key: "msg-a" }));
    messages.upsertMessage(envelope({ key: "msg-b" }));
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "m",
      error: null,
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages?needs_me=1", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as { rows: { key: string }[] };
    expect(body.rows.map((r) => r.key)).toEqual(["msg-a"]);
  });

  test("an unrecognized needs_me value applies no filter instead of silently filtering false", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope({ key: "msg-a" }));
    messages.upsertMessage(envelope({ key: "msg-b" }));
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "m",
      error: null,
    });

    for (const value of ["tru", ""]) {
      const response = await app.handle(
        new Request(`http://localhost/api/messages?needs_me=${value}`, {
          headers: authHeaders(),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { rows: { key: string }[] };
      expect(body.rows.map((r) => r.key).sort()).toEqual(["msg-a", "msg-b"]);
    }
  });

  test("needs_me=true is sugar for actionRequired: true", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope({ key: "msg-a" }));
    messages.upsertMessage(envelope({ key: "msg-b" }));
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "m",
      error: null,
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages?needs_me=true", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as { rows: { key: string }[] };
    expect(body.rows.map((r) => r.key)).toEqual(["msg-a"]);
  });

  test("needs_me=0 and needs_me=false filter for actionRequired: false", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope({ key: "msg-a" }));
    messages.upsertMessage(envelope({ key: "msg-b" }));
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "m",
      error: null,
    });
    messages.saveEnrichment("msg-b", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "m",
      error: null,
    });

    for (const value of ["0", "false"]) {
      const response = await app.handle(
        new Request(`http://localhost/api/messages?needs_me=${value}`, {
          headers: authHeaders(),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { rows: { key: string }[] };
      expect(body.rows.map((r) => r.key)).toEqual(["msg-b"]);
    }
  });

  test("a garbage cursor is a clean 400, not a 500", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/messages?cursor=not-a-real-cursor", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_cursor" });
  });
});

describe("GET /api/messages/:key", () => {
  test("404 for an unknown key", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/messages/missing", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("merges the classification and omits body unless include=body", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope());
    messages.saveBody("msg-1", { html: "<p>hi</p>", text: "hi" });

    const withoutBody = await json(
      await app.handle(
        new Request("http://localhost/api/messages/msg-1", {
          headers: authHeaders(),
        }),
      ),
    );
    expect(withoutBody.body).toBeUndefined();
    expect(withoutBody.classification).toBeNull();

    const withBody = await json(
      await app.handle(
        new Request("http://localhost/api/messages/msg-1?include=body", {
          headers: authHeaders(),
        }),
      ),
    );
    expect(withBody.body).toMatchObject({ html: "<p>hi</p>", text: "hi" });
  });
});

describe("GET /api/threads/:key", () => {
  test("404 for an unknown key", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/threads/missing", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("no threadKey returns just the one message", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope({ key: "msg-1", threadKey: null }));

    const response = await app.handle(
      new Request("http://localhost/api/threads/msg-1", {
        headers: authHeaders(),
      }),
    );
    const body = (await json(response)) as { rows: { key: string }[] };
    expect(body.rows.map((r) => r.key)).toEqual(["msg-1"]);
  });

  test("groups every message sharing the same threadKey", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(
      envelope({
        key: "msg-a",
        threadKey: "thread-1",
        date: "2026-01-01T00:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        threadKey: "thread-1",
        date: "2026-01-02T00:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-c",
        threadKey: "thread-2",
        date: "2026-01-03T00:00:00.000Z",
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/api/threads/msg-a", {
        headers: authHeaders(),
      }),
    );
    const body = (await json(response)) as { rows: { key: string }[] };
    expect(body.rows.map((r) => r.key)).toEqual(["msg-b", "msg-a"]);
  });
});

describe("GET /api/search", () => {
  test("expands matched keys into full message summaries", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(
      envelope({ key: "msg-1", subject: "Quarterly invoice attached" }),
    );

    const response = await app.handle(
      new Request("http://localhost/api/search?q=invoice", {
        headers: authHeaders(),
      }),
    );
    const body = (await json(response)) as {
      via: string;
      keys: { key: string }[];
    };
    expect(body.via).toBe("fts");
    expect(body.keys.map((r) => r.key)).toEqual(["msg-1"]);
  });
});

describe("POST /api/messages/:key/flags", () => {
  test("404 for an unknown message", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/messages/missing/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("404 when the message has no location in that mailbox", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope());

    const response = await app.handle(
      new Request("http://localhost/api/messages/msg-1/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "location_not_found" });
  });

  test("501 when the provider does not support flags", async () => {
    const { app, messages } = testApp(API_KEY, {
      providerFor: () =>
        fakeProvider({
          capabilities: async () => ({
            list: true,
            read: true,
            search: false,
            flag: false,
            move: false,
            send: false,
            idle: false,
          }),
        }),
    });
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 1,
      },
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages/msg-1/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );

    expect(response.status).toBe(501);
  });

  test("calls the provider's setFlags with the stored ref", async () => {
    let calledWith: unknown;
    const { app, messages } = testApp(API_KEY, {
      providerFor: () =>
        fakeProvider({
          setFlags: async (ref, flags) => {
            calledWith = { ref, flags };
          },
        }),
    });
    messages.upsertMessage(envelope());
    const ref = {
      provider: "proton" as const,
      account: "hello@example.com",
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
    };
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: ref,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages/msg-1/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calledWith).toEqual({
      ref,
      flags: { add: ["\\Seen"], remove: undefined, set: undefined },
    });
  });
});

describe("POST /api/messages/:key/move", () => {
  test("moves and records the new location", async () => {
    const { app, messages } = testApp(API_KEY, {
      providerFor: () =>
        fakeProvider({
          move: async (ref, toMailbox) =>
            ({ ...ref, mailbox: toMailbox, uid: 99 }) as MessageRef,
        }),
    });
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 1,
      },
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages/msg-1/move", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", toMailbox: "Archive" }),
      }),
    );

    expect(response.status).toBe(200);
    const locations = messages.getMessage("msg-1")?.locations ?? [];
    expect(locations.find((l) => l.mailbox === "Archive")).toMatchObject({
      uid: 99,
    });
    expect(locations.find((l) => l.mailbox === "INBOX")).toBeUndefined();
  });

  test("removes the old mailbox's location so a later call against it 404s instead of resolving a stale ref", async () => {
    const { app, messages } = testApp(API_KEY, {
      providerFor: () =>
        fakeProvider({
          move: async (ref, toMailbox) =>
            ({ ...ref, mailbox: toMailbox, uid: 99 }) as MessageRef,
        }),
    });
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 1,
      },
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    await app.handle(
      new Request("http://localhost/api/messages/msg-1/move", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", toMailbox: "Archive" }),
      }),
    );

    const staleFlagsResponse = await app.handle(
      new Request("http://localhost/api/messages/msg-1/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );

    expect(staleFlagsResponse.status).toBe(404);
    expect(await json(staleFlagsResponse)).toEqual({
      error: "location_not_found",
    });
  });

  test("a same-mailbox move (toMailbox === mailbox) leaves the location intact", async () => {
    const { app, messages } = testApp(API_KEY, {
      providerFor: () =>
        fakeProvider({
          move: async (ref, toMailbox) =>
            ({ ...ref, mailbox: toMailbox, uid: 99 }) as MessageRef,
        }),
    });
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 1,
      },
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.handle(
      new Request("http://localhost/api/messages/msg-1/move", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", toMailbox: "INBOX" }),
      }),
    );

    expect(response.status).toBe(200);
    const locations = messages.getMessage("msg-1")?.locations ?? [];
    expect(locations.find((l) => l.mailbox === "INBOX")).toMatchObject({
      uid: 99,
    });

    const flagsResponse = await app.handle(
      new Request("http://localhost/api/messages/msg-1/flags", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mailbox: "INBOX", add: ["\\Seen"] }),
      }),
    );
    expect(flagsResponse.status).toBe(200);
  });
});

describe("GET /api/submissions", () => {
  test("filters by verdict", async () => {
    const { app, mailSubmissions } = testApp(API_KEY);
    mailSubmissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: true,
      submission: {},
    });
    mailSubmissions.insertSubmission({
      source: "fpp",
      verdict: "spam",
      confidence: 0.9,
      reason: "r",
      model: "m",
      delivered: false,
      submission: {},
    });

    const response = await app.handle(
      new Request("http://localhost/api/submissions?verdict=spam", {
        headers: authHeaders(),
      }),
    );
    const body = (await json(response)) as { data: { verdict: string }[] };
    expect(body.data.map((r) => r.verdict)).toEqual(["spam"]);
  });

  test("a garbage cursor is a clean 400, not a 500", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/submissions?cursor=not-a-real-cursor", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_cursor" });
  });
});

describe("GET /api/stats", () => {
  test("returns messages, jevComparison, jobs and accounts", async () => {
    const { app, messages } = testApp(API_KEY);
    // Within the endpoint's default 30-day `since` window — getStats() now
    // honours it (previously ignored), so a fixed old fixture date would
    // fall outside the window and undercount.
    messages.upsertMessage(envelope({ date: new Date().toISOString() }));

    const response = await app.handle(
      new Request("http://localhost/api/stats", { headers: authHeaders() }),
    );
    const body = (await json(response)) as {
      messages: { total: number };
      jevComparison: unknown;
      jobs: { pending: number; failed: number };
      accounts: { id: string }[];
    };

    expect(body.messages.total).toBe(1);
    expect(body.jobs).toEqual({ pending: 0, failed: 0 });
    expect(body.accounts.map((a) => a.id)).toEqual([ACCOUNT_ID]);
  });
});

describe("POST /api/sync", () => {
  test("enqueues a sync_tick job and returns immediately", async () => {
    const { app, jobs } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/sync", {
        method: "POST",
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ enqueued: true });
    expect(jobs.counts()).toEqual({ pending: 1, failed: 0 });
  });
});

describe("GET /api/jobs/:id", () => {
  test("404 for an unknown id, 200 with the job's state otherwise", async () => {
    const { app, jobs } = testApp(API_KEY);

    const missing = await app.handle(
      new Request("http://localhost/api/jobs/missing", {
        headers: authHeaders(),
      }),
    );
    expect(missing.status).toBe(404);

    const id = jobs.enqueue({ kind: "classify", payload: { key: "msg-1" } });
    const response = await app.handle(
      new Request(`http://localhost/api/jobs/${id}`, {
        headers: authHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      id,
      kind: "classify",
      status: "pending",
    });
  });
});

describe("GET /api/emails (legacy alias)", () => {
  test("reshapes new-schema rows into the old field names", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(
      envelope({
        key: "in_1",
        direction: "inbound",
        date: "2026-01-01T00:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "out_1",
        direction: "outbound",
        date: "2026-01-02T00:00:00.000Z",
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/api/emails?direction=inbound", {
        headers: authHeaders(),
      }),
    );
    const body = (await json(response)) as { data: Record<string, unknown>[] };
    expect(body.data).toEqual([
      {
        id: "in_1",
        direction: "inbound",
        fromAddress: "sender@example.com",
        toAddresses: ["hello@example.com"],
        subject: "Hello there",
        createdAt: "2026-01-01T00:00:00.000Z",
        enrichment: null,
      },
    ]);
  });

  test("a status query param is accepted but has no effect", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope());

    const response = await app.handle(
      new Request("http://localhost/api/emails?status=pending", {
        headers: authHeaders(),
      }),
    );
    expect(response.status).toBe(200);
  });

  test("a garbage cursor is a clean 400, not a 500", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/emails?cursor=not-a-real-cursor", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_cursor" });
  });
});

describe("GET /api/emails/:id (legacy alias)", () => {
  test("404 for an unknown id", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/emails/missing", {
        headers: authHeaders(),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("excludes body by default and includes it with ?include=html", async () => {
    const { app, messages } = testApp(API_KEY);
    messages.upsertMessage(envelope());
    messages.saveBody("msg-1", { html: "<p>hi</p>", text: "hi" });

    const withoutHtml = await json(
      await app.handle(
        new Request("http://localhost/api/emails/msg-1", {
          headers: authHeaders(),
        }),
      ),
    );
    expect(withoutHtml.html).toBeUndefined();

    const withHtml = await json(
      await app.handle(
        new Request("http://localhost/api/emails/msg-1?include=html", {
          headers: authHeaders(),
        }),
      ),
    );
    expect(withHtml.html).toBe("<p>hi</p>");
    expect(withHtml.text).toBe("hi");
  });
});

describe("POST /api/emails/:id/enrich (legacy alias)", () => {
  test("404 for an unknown id", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/emails/missing/enrich", {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("enqueues a classify job and returns immediately", async () => {
    const { app, messages, jobs } = testApp(API_KEY);
    messages.upsertMessage(envelope());

    const response = await app.handle(
      new Request("http://localhost/api/emails/msg-1/enrich", {
        method: "POST",
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ enqueued: true });
    expect(jobs.counts()).toEqual({ pending: 1, failed: 0 });
  });
});

describe("GET /api/templates", () => {
  test("lists every template row", async () => {
    const { app, templates } = testApp(API_KEY);
    templates.upsertTemplate({ id: "welcome", name: "Welcome" });
    templates.upsertTemplate({ id: "digest", name: "Digest" });

    const response = await app.handle(
      new Request("http://localhost/api/templates", { headers: authHeaders() }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string }[];
    expect(body.map((t) => t.id).sort()).toEqual(["digest", "welcome"]);
  });
});

describe("GET /api/templates/:id/preview", () => {
  test("404 for an unknown template id", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/templates/missing/preview", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "not_found" });
  });

  test("renders the registry template as html", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request(
        `http://localhost/api/templates/${TEMPLATE_IDS.fppSender}/preview?width=375`,
        { headers: authHeaders() },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect((await response.text()).length).toBeGreaterThan(0);
  });
});

describe("POST /api/templates/:id/test-send", () => {
  test("404 for an unknown template id", async () => {
    const { app, sendLog } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/templates/missing/test-send", {
        method: "POST",
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(404);
    expect(sendLog.listSendLog().data).toHaveLength(0);
  });

  test("inserts a send_log row, enqueues a send job and records the test send", async () => {
    const { app, sendLog, templates, jobs } = testApp(API_KEY);
    templates.upsertTemplate({
      id: TEMPLATE_IDS.fppSender,
      name: "FPP – contact confirmation",
    });

    const response = await app.handle(
      new Request(
        `http://localhost/api/templates/${TEMPLATE_IDS.fppSender}/test-send`,
        { method: "POST", headers: authHeaders() },
      ),
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.enqueued).toBe(true);
    expect(typeof body.sendLogId).toBe("string");
    expect(typeof body.jobId).toBe("string");

    expect(sendLog.getSendLog(body.sendLogId as string)).toMatchObject({
      templateId: TEMPLATE_IDS.fppSender,
      recipients: ["receiver@example.com"],
      provider: "resend",
      requestedBy: "test-send",
      status: null,
    });
    expect(jobs.getJob(body.jobId as string)).toMatchObject({
      kind: "send",
      status: "pending",
    });
    expect(
      templates.getTemplate(TEMPLATE_IDS.fppSender)?.lastTestSendAt,
    ).not.toBeNull();
  });
});

describe("GET /api/send-log", () => {
  test("filters by templateId and paginates newest-first", async () => {
    const { app, sendLog } = testApp(API_KEY);
    sendLog.insertSendLog({
      id: "log-welcome",
      templateId: "welcome",
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "route",
    });
    sendLog.insertSendLog({
      id: "log-digest",
      templateId: "digest",
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "route",
    });

    const response = await app.handle(
      new Request("http://localhost/api/send-log?templateId=welcome", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as { data: { id: string }[] };
    expect(body.data.map((row) => row.id)).toEqual(["log-welcome"]);
  });

  test("a garbage cursor is a clean 400, not a 500", async () => {
    const { app } = testApp(API_KEY);

    const response = await app.handle(
      new Request("http://localhost/api/send-log?cursor=not-a-real-cursor", {
        headers: authHeaders(),
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "invalid_cursor" });
  });
});
