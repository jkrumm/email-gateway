import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMessagesRepo, type MessageEnvelope } from "./messages";
import { openMailDatabase } from "./mail-client";

function setup() {
  const db = openMailDatabase(":memory:");
  db.run(
    `INSERT INTO accounts (id, provider, address, created_at)
     VALUES ('proton:hello@example.com', 'proton', 'hello@example.com', '2026-09-28T08:00:00.000Z')`,
  );
  return { db, messages: createMessagesRepo(db) };
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    key: "msg-1",
    account: "proton:hello@example.com",
    direction: "inbound",
    fromAddress: "sender@example.com",
    toAddresses: ["hello@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Hello there",
    date: "2026-09-28T08:00:00.000Z",
    size: 1024,
    hasAttachments: false,
    threadKey: null,
    flags: ["\\Seen"],
    ...overrides,
  };
}

describe("messages repo", () => {
  test("upsertMessage inserts, then updates the envelope on a second sight", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    const first = messages.getMessage("msg-1");
    expect(first).toMatchObject({ subject: "Hello there", flags: ["\\Seen"] });

    messages.upsertMessage(
      envelope({
        subject: "Hello there (read)",
        flags: ["\\Seen", "\\Flagged"],
      }),
    );

    const second = messages.getMessage("msg-1");
    expect(second).toMatchObject({
      subject: "Hello there (read)",
      flags: ["\\Seen", "\\Flagged"],
    });
    // created_at is preserved across the update.
    expect(second?.locations).toEqual([]);
  });

  test("upsertMessage falls back to now only on the first insert, and preserves the stored date across null re-sights", () => {
    const { messages } = setup();

    messages.upsertMessage(
      envelope({ date: null }),
      "2026-09-28T08:00:00.000Z",
    );
    expect(messages.getMessage("msg-1")).toMatchObject({
      date: "2026-09-28T08:00:00.000Z",
    });

    // A second re-sight with no provider date must NOT advance to a fresh
    // "now" — it must preserve the first call's stored date.
    messages.upsertMessage(
      envelope({ date: null }),
      "2026-09-28T09:00:00.000Z",
    );
    expect(messages.getMessage("msg-1")).toMatchObject({
      date: "2026-09-28T08:00:00.000Z",
    });

    // A third call with an actual date value DOES update it.
    messages.upsertMessage(
      envelope({ date: "2026-09-28T10:00:00.000Z" }),
      "2026-09-28T11:00:00.000Z",
    );
    expect(messages.getMessage("msg-1")).toMatchObject({
      date: "2026-09-28T10:00:00.000Z",
    });
  });

  test("getMessage returns null for an unknown key", () => {
    const { messages } = setup();
    expect(messages.getMessage("missing")).toBeNull();
  });

  test("upsertLocation inserts a new mailbox row and updates an existing one", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "7",
      uid: 1,
      providerRef: { mailbox: "INBOX", uid: 1 },
      lastSeenAt: "2026-09-28T08:00:00.000Z",
    });
    messages.upsertLocation("msg-1", {
      mailbox: "Archive",
      uidValidity: "9",
      uid: 2,
      providerRef: { mailbox: "Archive", uid: 2 },
      lastSeenAt: "2026-09-28T08:01:00.000Z",
    });
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "7",
      uid: 3,
      providerRef: { mailbox: "INBOX", uid: 3 },
      lastSeenAt: "2026-09-28T08:02:00.000Z",
    });

    const locations = messages.getMessage("msg-1")?.locations ?? [];
    expect(locations).toHaveLength(2);
    const inbox = locations.find((l) => l.mailbox === "INBOX");
    expect(inbox).toMatchObject({ uid: 3, uidValidity: "7" });
  });

  test("removeLocation deletes only the named mailbox's location row", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "7",
      uid: 1,
      providerRef: { mailbox: "INBOX", uid: 1 },
      lastSeenAt: "2026-09-28T08:00:00.000Z",
    });
    messages.upsertLocation("msg-1", {
      mailbox: "Archive",
      uidValidity: "9",
      uid: 2,
      providerRef: { mailbox: "Archive", uid: 2 },
      lastSeenAt: "2026-09-28T08:01:00.000Z",
    });

    messages.removeLocation("msg-1", "INBOX");

    const locations = messages.getMessage("msg-1")?.locations ?? [];
    expect(locations.map((l) => l.mailbox)).toEqual(["Archive"]);
  });

  test("listMessages paginates newest-date-first across multiple pages", () => {
    const { messages } = setup();
    for (let i = 0; i < 5; i++) {
      messages.upsertMessage(
        envelope({
          key: `msg-${i}`,
          date: `2026-09-2${i}T08:00:00.000Z`,
          subject: `Message ${i}`,
        }),
      );
    }

    const page1 = messages.listMessages({ limit: 2 });
    expect(page1.rows.map((r) => r.key)).toEqual(["msg-4", "msg-3"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = messages.listMessages({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.rows.map((r) => r.key)).toEqual(["msg-2", "msg-1"]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = messages.listMessages({
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.rows.map((r) => r.key)).toEqual(["msg-0"]);
    expect(page3.nextCursor).toBeNull();
  });

  test("listMessages filters by account, direction, category and actionRequired", () => {
    const { db, messages } = setup();
    db.run(
      `INSERT INTO accounts (id, provider, address, created_at)
       VALUES ('gmail:me@gmail.com', 'gmail', 'me@gmail.com', '2026-09-28T08:00:00.000Z')`,
    );

    messages.upsertMessage(
      envelope({
        key: "msg-a",
        account: "proton:hello@example.com",
        direction: "inbound",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        account: "gmail:me@gmail.com",
        direction: "outbound",
      }),
    );
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: "needs a reply",
      suggestedAction: null,
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    expect(
      messages
        .listMessages({ accountIds: ["gmail:me@gmail.com"] })
        .rows.map((r) => r.key),
    ).toEqual(["msg-b"]);
    expect(
      messages.listMessages({ direction: "inbound" }).rows.map((r) => r.key),
    ).toEqual(["msg-a"]);
    expect(
      messages.listMessages({ category: "urgent" }).rows.map((r) => r.key),
    ).toEqual(["msg-a"]);
    expect(
      messages.listMessages({ actionRequired: true }).rows.map((r) => r.key),
    ).toEqual(["msg-a"]);

    const withClassification = messages.listMessages({
      accountIds: ["proton:hello@example.com"],
    }).rows[0];
    expect(withClassification?.classification).toMatchObject({
      category: "urgent",
      actionRequired: true,
    });

    const withoutClassification = messages.listMessages({
      accountIds: ["gmail:me@gmail.com"],
    }).rows[0];
    expect(withoutClassification?.classification).toBeNull();
  });

  test("listMessages filters by threadKey", () => {
    const { messages } = setup();
    messages.upsertMessage(
      envelope({
        key: "msg-a",
        threadKey: "thread-1",
        date: "2026-09-20T08:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        threadKey: "thread-1",
        date: "2026-09-21T08:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-c",
        threadKey: "thread-2",
        date: "2026-09-22T08:00:00.000Z",
      }),
    );

    expect(
      messages.listMessages({ threadKey: "thread-1" }).rows.map((r) => r.key),
    ).toEqual(["msg-b", "msg-a"]);
    expect(
      messages.listMessages({ threadKey: "thread-2" }).rows.map((r) => r.key),
    ).toEqual(["msg-c"]);
  });

  test("getStats totals by direction and breaks classified messages down by category", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-a", direction: "inbound" }));
    messages.upsertMessage(envelope({ key: "msg-b", direction: "outbound" }));
    messages.upsertMessage(envelope({ key: "msg-c", direction: "inbound" }));
    messages.saveEnrichment("msg-a", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "test-model",
      error: null,
    });
    messages.saveEnrichment("msg-c", {
      category: "urgent",
      priority: "high",
      actionRequired: false,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "test-model",
      error: null,
    });

    expect(messages.getStats()).toEqual({
      total: 3,
      inbound: 2,
      outbound: 1,
      byCategory: { urgent: 2 },
    });
  });

  test("getStats narrows both totals and category counts by since", () => {
    const { messages } = setup();
    messages.upsertMessage(
      envelope({
        key: "msg-old",
        direction: "inbound",
        date: "2026-09-01T08:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-new",
        direction: "outbound",
        date: "2026-09-28T08:00:00.000Z",
      }),
    );
    messages.saveEnrichment("msg-old", {
      category: "urgent",
      priority: "high",
      actionRequired: true,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "test-model",
      error: null,
    });
    messages.saveEnrichment("msg-new", {
      category: "urgent",
      priority: "high",
      actionRequired: false,
      summary: null,
      suggestedAction: null,
      language: null,
      facts: null,
      model: "test-model",
      error: null,
    });

    expect(messages.getStats({ since: "2026-09-15T00:00:00.000Z" })).toEqual({
      total: 1,
      inbound: 0,
      outbound: 1,
      byCategory: { urgent: 1 },
    });
  });

  test("saveEnrichment upserts and getClassification reads it back", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    messages.saveEnrichment("msg-1", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: [{ label: "sender", value: "example.com" }],
      model: "test-model",
      error: null,
    });

    expect(messages.getClassification("msg-1")).toMatchObject({
      category: "newsletter",
      facts: [{ label: "sender", value: "example.com" }],
      jevCategory: null,
    });

    // Re-run classifies again — proves the upsert path, not a second row.
    messages.saveEnrichment("msg-1", {
      category: "spam",
      priority: "low",
      actionRequired: false,
      summary: "updated",
      suggestedAction: null,
      language: "en",
      facts: null,
      model: "test-model-2",
      error: null,
    });

    expect(messages.getClassification("msg-1")).toMatchObject({
      category: "spam",
      summary: "updated",
    });
  });

  test("saveEnrichment only touches enrichment columns, leaving an existing jev_* set untouched", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    messages.saveJevClassification("msg-1", {
      jevSpamProbability: 0.1,
      jevCategory: "newsletter",
      jevCategoryConfidence: 0.9,
      jevLatencyMs: 120,
      jevModel: "jev-model",
      jevError: null,
    });

    messages.saveEnrichment("msg-1", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    expect(messages.getClassification("msg-1")).toMatchObject({
      category: "newsletter",
      jevCategory: "newsletter",
      jevSpamProbability: 0.1,
    });
  });

  test("saveJevClassification only touches jev_* columns, leaving existing enrichment untouched", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    messages.saveEnrichment("msg-1", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    messages.saveJevClassification("msg-1", {
      jevSpamProbability: 0.1,
      jevCategory: "newsletter",
      jevCategoryConfidence: 0.9,
      jevLatencyMs: 120,
      jevModel: "jev-model",
      jevError: null,
    });

    expect(messages.getClassification("msg-1")).toMatchObject({
      category: "newsletter",
      summary: "a summary",
      jevCategory: "newsletter",
      jevSpamProbability: 0.1,
    });
  });

  test("saveEnrichment alone leaves jev_* fields null; saveJevClassification alone leaves enrichment fields null", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-enrich-only" }));
    messages.upsertMessage(envelope({ key: "msg-jev-only" }));

    messages.saveEnrichment("msg-enrich-only", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    messages.saveJevClassification("msg-jev-only", {
      jevSpamProbability: 0.2,
      jevCategory: "spam",
      jevCategoryConfidence: 0.8,
      jevLatencyMs: 90,
      jevModel: "jev-model",
      jevError: null,
    });

    expect(messages.getClassification("msg-enrich-only")).toMatchObject({
      category: "newsletter",
      jevCategory: null,
      jevSpamProbability: null,
    });
    expect(messages.getClassification("msg-jev-only")).toMatchObject({
      category: null,
      jevCategory: "spam",
      jevSpamProbability: 0.2,
    });
  });

  test("saveEnrichment and saveJevClassification racing in either order never clobber each other", () => {
    // Regression for the full-row saveClassification race: whichever writer
    // used to commit LAST used to overwrite the other's fresh columns with
    // stale/null values from its own snapshot. Targeted column writers
    // shouldn't, regardless of order.
    const orderA = setup();
    orderA.messages.upsertMessage(envelope({ key: "msg-1" }));
    orderA.messages.saveEnrichment("msg-1", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });
    orderA.messages.saveJevClassification("msg-1", {
      jevSpamProbability: 0.1,
      jevCategory: "newsletter",
      jevCategoryConfidence: 0.9,
      jevLatencyMs: 120,
      jevModel: "jev-model",
      jevError: null,
    });

    const orderB = setup();
    orderB.messages.upsertMessage(envelope({ key: "msg-1" }));
    orderB.messages.saveJevClassification("msg-1", {
      jevSpamProbability: 0.1,
      jevCategory: "newsletter",
      jevCategoryConfidence: 0.9,
      jevLatencyMs: 120,
      jevModel: "jev-model",
      jevError: null,
    });
    orderB.messages.saveEnrichment("msg-1", {
      category: "newsletter",
      priority: "low",
      actionRequired: false,
      summary: "a summary",
      suggestedAction: "archive",
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    const expected = {
      category: "newsletter",
      summary: "a summary",
      jevCategory: "newsletter",
      jevSpamProbability: 0.1,
    };
    expect(orderA.messages.getClassification("msg-1")).toMatchObject(expected);
    expect(orderB.messages.getClassification("msg-1")).toMatchObject(expected);
  });

  test("syncFtsRow's DELETE+INSERT is atomic: rapid interleaved saveEnrichment/saveJevClassification calls never leave duplicate messages_fts rows", () => {
    const { db, messages } = setup();
    messages.upsertMessage(envelope());

    // Simulates the two-container overlap this repo designs around: several
    // rapid, interleaved writers touching the same key's FTS row. Each call
    // is synchronous end-to-end (bun:sqlite has no async I/O mid-statement),
    // so this can't reproduce genuine OS-thread interleaving — the tripwire
    // is that COUNT(*) never exceeds 1 per key after any sequence of calls,
    // which is exactly what a non-atomic DELETE+INSERT pair would risk.
    for (let i = 0; i < 5; i++) {
      messages.saveEnrichment("msg-1", {
        category: `cat-${i}`,
        priority: "low",
        actionRequired: false,
        summary: `summary-${i}`,
        suggestedAction: null,
        language: "en",
        facts: null,
        model: "test-model",
        error: null,
      });
      messages.saveJevClassification("msg-1", {
        jevSpamProbability: 0.1,
        jevCategory: `jev-cat-${i}`,
        jevCategoryConfidence: 0.9,
        jevLatencyMs: 120,
        jevModel: "jev-model",
        jevError: null,
      });
    }

    const rows = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM messages_fts WHERE message_key = ?",
      )
      .get("msg-1");
    expect(rows).toEqual({ count: 1 });
  });

  test("getClassification returns null when none exists", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());
    expect(messages.getClassification("msg-1")).toBeNull();
  });

  test("saveBody upserts and getBody reads it back", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    expect(messages.getBody("msg-1")).toBeNull();

    messages.saveBody("msg-1", { html: "<p>hi</p>", text: "hi" });
    const body = messages.getBody("msg-1");
    expect(body).toMatchObject({ html: "<p>hi</p>", text: "hi" });
    expect(body?.fetchedAt).not.toBeNull();

    messages.saveBody("msg-1", { html: "<p>updated</p>", text: "updated" });
    expect(messages.getBody("msg-1")).toMatchObject({
      html: "<p>updated</p>",
      text: "updated",
    });
  });

  test("knownMessageKeys returns only the keys that exist", () => {
    const { messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-1" }));
    messages.upsertMessage(envelope({ key: "msg-2" }));

    expect(messages.knownMessageKeys(["msg-1", "msg-2", "msg-3"])).toEqual(
      new Set(["msg-1", "msg-2"]),
    );
    expect(messages.knownMessageKeys([])).toEqual(new Set());
  });

  test("upsertMessage writes subject and addresses into FTS immediately; classification re-syncs the summary", () => {
    const { messages } = setup();
    messages.upsertMessage(
      envelope({ key: "msg-1", subject: "Quarterly invoice attached" }),
    );

    expect(messages.searchMessages("invoice")).toEqual(["msg-1"]);
    expect(messages.searchMessages("sender@example.com")).toEqual(["msg-1"]);
    expect(messages.searchMessages("vendor")).toEqual([]);

    messages.saveEnrichment("msg-1", {
      category: "finance",
      priority: "medium",
      actionRequired: false,
      summary: "Vendor sent an invoice",
      suggestedAction: null,
      language: "en",
      facts: null,
      model: "test-model",
      error: null,
    });

    expect(messages.searchMessages("vendor")).toEqual(["msg-1"]);
    expect(messages.searchMessages("invoice")).toEqual(["msg-1"]);
  });

  test("searchMessages restricts by accountIds and returns [] for empty input", () => {
    const { db, messages } = setup();
    db.run(
      `INSERT INTO accounts (id, provider, address, created_at)
       VALUES ('gmail:me@gmail.com', 'gmail', 'me@gmail.com', '2026-09-28T08:00:00.000Z')`,
    );
    messages.upsertMessage(
      envelope({
        key: "msg-a",
        account: "proton:hello@example.com",
        subject: "budget plan",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        account: "gmail:me@gmail.com",
        subject: "budget review",
      }),
    );

    expect(messages.searchMessages("budget")).toContain("msg-a");
    expect(messages.searchMessages("budget")).toContain("msg-b");
    expect(
      messages.searchMessages("budget", { accountIds: ["gmail:me@gmail.com"] }),
    ).toEqual(["msg-b"]);
    expect(messages.searchMessages("   ")).toEqual([]);
  });

  test("evictStaleBodies deletes rows older than maxAgeMs, then the oldest by count", () => {
    const { db, messages } = setup();
    const keys = ["msg-1", "msg-2", "msg-3", "msg-4"];
    for (const key of keys) {
      messages.upsertMessage(
        envelope({ key, date: "2026-09-28T08:00:00.000Z" }),
      );
    }

    // Insert body_cache rows directly with distinct, controlled fetched_at
    // values (saveBody always stamps "now", which can't express this).
    const fetchedAt: Record<string, string> = {
      "msg-1": "2026-09-01T00:00:00.000Z", // oldest, also outside maxAgeMs
      "msg-2": "2026-09-20T00:00:00.000Z",
      "msg-3": "2026-09-25T00:00:00.000Z",
      "msg-4": "2026-09-28T00:00:00.000Z", // newest
    };
    for (const key of keys) {
      insertBodyCacheRow(db, key, fetchedAt[key]!);
    }

    const now = new Date("2026-09-28T08:00:00.000Z");
    // maxAgeMs excludes anything older than 2026-09-10: only msg-1 qualifies
    // by age. maxRows further trims down to the 2 newest by fetched_at.
    const deleted = messages.evictStaleBodies({
      maxRows: 2,
      maxAgeMs: now.getTime() - new Date("2026-09-10T00:00:00.000Z").getTime(),
      now,
    });

    expect(deleted).toBe(2);
    const remainingKeys = db
      .query<{ key: string }, []>(
        "SELECT key FROM body_cache ORDER BY fetched_at ASC",
      )
      .all()
      .map((r) => r.key);
    expect(remainingKeys).toEqual(["msg-3", "msg-4"]);
  });

  test("evictStaleBodies is a no-op when nothing is stale or over the row cap", () => {
    const { db, messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-1" }));
    insertBodyCacheRow(db, "msg-1", "2026-09-28T00:00:00.000Z");

    const deleted = messages.evictStaleBodies({
      maxRows: 10,
      maxAgeMs: 365 * 24 * 60 * 60_000,
      now: new Date("2026-09-28T08:00:00.000Z"),
    });

    expect(deleted).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM body_cache",
        )
        .get(),
    ).toEqual({ count: 1 });
  });
});

function insertBodyCacheRow(
  db: Database,
  key: string,
  fetchedAt: string,
): void {
  db.run(
    `INSERT INTO body_cache (key, html, text, fetched_at) VALUES (?, ?, ?, ?)`,
    [key, "<p>x</p>", "x", fetchedAt],
  );
}
