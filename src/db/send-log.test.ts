import { describe, expect, test } from "bun:test";
import { createSendLogRepo } from "./send-log";
import { openMailDatabase } from "./mail-client";

function setup() {
  return createSendLogRepo(openMailDatabase(":memory:"));
}

function setupWithDb() {
  const db = openMailDatabase(":memory:");
  return { db, sendLog: createSendLogRepo(db) };
}

// Seeds one reconcilable-candidate row through the repo's public API: a
// provider message id (or none) and a status.
function seed(
  sendLog: ReturnType<typeof createSendLogRepo>,
  id: string,
  {
    provider = "resend",
    providerMessageId = `msg-${id}` as string | null,
    status = null as string | null,
  }: {
    provider?: string;
    providerMessageId?: string | null;
    status?: string | null;
  } = {},
): void {
  sendLog.insertSendLog({
    id,
    recipients: ["jane@example.com"],
    provider,
    requestedBy: "route",
  });
  if (providerMessageId !== null) {
    sendLog.recordProviderResult(id, { providerMessageId, status });
  }
}

describe("send log repo", () => {
  test("insertSendLog records a row with no provider result yet", () => {
    const sendLog = setup();
    sendLog.insertSendLog({
      id: "send-1",
      templateId: "welcome",
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "route",
    });

    const { data } = sendLog.listSendLog();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "send-1",
      templateId: "welcome",
      recipients: ["jane@example.com"],
      provider: "resend",
      providerMessageId: null,
      status: null,
      requestedBy: "route",
    });
  });

  test("insertSendLog is a safe no-op on a retried insert of the same id", () => {
    const sendLog = setup();
    const row = {
      id: "send-1",
      templateId: "welcome",
      recipients: ["jane@example.com"],
      provider: "resend" as const,
      requestedBy: "route" as const,
    };

    expect(() => sendLog.insertSendLog(row)).not.toThrow();
    expect(() => sendLog.insertSendLog(row)).not.toThrow();

    expect(sendLog.listSendLog().data).toHaveLength(1);
  });

  test("recordProviderResult patches only the given fields", () => {
    const sendLog = setup();
    sendLog.insertSendLog({
      id: "send-1",
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "route",
    });

    sendLog.recordProviderResult("send-1", {
      providerMessageId: "resend-abc",
      status: "sent",
    });
    let entry = sendLog.listSendLog().data[0];
    expect(entry).toMatchObject({
      providerMessageId: "resend-abc",
      status: "sent",
      lastEvent: null,
    });

    sendLog.recordProviderResult("send-1", { lastEvent: "delivered" });
    entry = sendLog.listSendLog().data[0];
    // Fields not passed this time stay as they were.
    expect(entry).toMatchObject({
      providerMessageId: "resend-abc",
      status: "sent",
      lastEvent: "delivered",
    });
  });

  test("listSendLog filters by templateId and paginates newest-first", () => {
    const sendLog = setup();
    for (let i = 0; i < 3; i++) {
      sendLog.insertSendLog({
        id: `send-${i}`,
        templateId: i === 0 ? "welcome" : "digest",
        recipients: ["jane@example.com"],
        provider: "resend",
        requestedBy: "route",
      });
    }

    expect(sendLog.listSendLog({ templateId: "welcome" }).data).toHaveLength(1);

    const page1 = sendLog.listSendLog({ limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = sendLog.listSendLog({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.data, ...page2.data].map((r) => r.id);
    expect(new Set(allIds).size).toBe(3);
  });

  test("getSendLog reads a single row back by id, or null when unknown", () => {
    const sendLog = setup();
    expect(sendLog.getSendLog("missing")).toBeNull();

    sendLog.insertSendLog({
      id: "send-1",
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "route",
    });
    sendLog.recordProviderResult("send-1", {
      providerMessageId: "resend-abc",
      status: "sent",
    });

    expect(sendLog.getSendLog("send-1")).toMatchObject({
      id: "send-1",
      status: "sent",
      providerMessageId: "resend-abc",
    });
  });
});

describe("send log listReconcilable", () => {
  test("returns only rows for the provider with an id and a non-terminal status", () => {
    const sendLog = setup();
    const keep = ["null", "sent", "queued", "scheduled", "delivery_delayed"];
    for (const status of keep) {
      seed(sendLog, `keep-${status}`, {
        status: status === "null" ? null : status,
      });
    }
    for (const status of [
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
      "failed",
      "canceled",
      "suppressed",
    ]) {
      seed(sendLog, `drop-${status}`, { status });
    }
    // No provider message id yet, and a different provider's rows: both are
    // out of scope for a Resend reconciliation pass.
    seed(sendLog, "drop-no-id", { providerMessageId: null });
    seed(sendLog, "drop-other-provider", {
      provider: "postmark",
      status: "sent",
    });

    const ids = sendLog
      .listReconcilable({ provider: "resend", limit: 100 })
      .map((row) => row.id)
      .sort();

    expect(ids).toEqual(keep.map((status) => `keep-${status}`).sort());
  });

  test("orders by updated_at ascending and caps at limit", () => {
    const { db, sendLog } = setupWithDb();
    seed(sendLog, "second");
    seed(sendLog, "first");
    seed(sendLog, "third");
    db.run(
      "UPDATE send_log SET updated_at = '2026-09-28T09:00:00.000Z' WHERE id = 'first'",
    );
    db.run(
      "UPDATE send_log SET updated_at = '2026-09-28T10:00:00.000Z' WHERE id = 'second'",
    );
    db.run(
      "UPDATE send_log SET updated_at = '2026-09-28T11:00:00.000Z' WHERE id = 'third'",
    );

    expect(
      sendLog
        .listReconcilable({ provider: "resend", limit: 100 })
        .map((r) => r.id),
    ).toEqual(["first", "second", "third"]);

    expect(
      sendLog
        .listReconcilable({ provider: "resend", limit: 2 })
        .map((r) => r.id),
    ).toEqual(["first", "second"]);
  });
});
