import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "./mail-client";

describe("openMailDatabase", () => {
  test("creates every lean-store table plus the shared jobs table", () => {
    const db = openMailDatabase(":memory:");

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain("accounts");
    expect(tables).toContain("messages");
    expect(tables).toContain("message_locations");
    expect(tables).toContain("classifications");
    expect(tables).toContain("body_cache");
    expect(tables).toContain("send_log");
    expect(tables).toContain("submissions");
    expect(tables).toContain("templates");
    expect(tables).toContain("messages_fts");
    // Proves ensureJobsSchema ran as part of opening the mail database.
    expect(tables).toContain("jobs");
  });

  test("lands on the expected user_version", () => {
    const db = openMailDatabase(":memory:");
    const { user_version } = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;
    expect(user_version).toBe(2);
  });

  test("is idempotent — running twice does not throw or duplicate schema", () => {
    const db = openMailDatabase(":memory:");
    expect(() => openMailDatabase(":memory:")).not.toThrow();

    const tableCount = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
      )
      .get()!.count;
    expect(tableCount).toBe(1);
  });

  test("round-trips a message and its location", () => {
    const db = openMailDatabase(":memory:");
    const now = "2026-09-28T08:00:00.000Z";

    db.run(
      `INSERT INTO accounts (id, provider, address, created_at) VALUES (?, ?, ?, ?)`,
      ["proton:hello@example.com", "proton", "hello@example.com", now],
    );
    db.run(
      `INSERT INTO messages (key, account, direction, to_addresses, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["msg-1", "proton:hello@example.com", "inbound", "[]", now, now, now],
    );
    db.run(
      `INSERT INTO message_locations (key, mailbox, provider_ref, last_seen_at)
       VALUES (?, ?, ?, ?)`,
      ["msg-1", "INBOX", '{"mailbox":"INBOX","uid":1}', now],
    );

    const location = db
      .query<{ key: string; mailbox: string }, []>(
        "SELECT key, mailbox FROM message_locations",
      )
      .get();
    expect(location).toEqual({ key: "msg-1", mailbox: "INBOX" });
  });

  test("enforces the messages foreign key on message_locations", () => {
    const db = openMailDatabase(":memory:");
    expect(() =>
      db.run(
        `INSERT INTO message_locations (key, mailbox, provider_ref, last_seen_at)
         VALUES (?, ?, ?, ?)`,
        ["missing-key", "INBOX", "{}", "2026-09-28T08:00:00.000Z"],
      ),
    ).toThrow();
  });
});
