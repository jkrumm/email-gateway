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

// Seeds one row through the repo's public API: a
// provider message id (or none) and a status.
function seed(
  sendLog: ReturnType<typeof createSendLogRepo>,
  id: string,
  {
    provider = "ses",
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
      provider: "ses",
      requestedBy: "route",
    });

    const { data } = sendLog.listSendLog();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "send-1",
      templateId: "welcome",
      recipients: ["jane@example.com"],
      provider: "ses",
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
      provider: "ses" as const,
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
      provider: "ses",
      requestedBy: "route",
    });

    sendLog.recordProviderResult("send-1", {
      providerMessageId: "ses-abc",
      status: "sent",
    });
    let entry = sendLog.listSendLog().data[0];
    expect(entry).toMatchObject({
      providerMessageId: "ses-abc",
      status: "sent",
      lastEvent: null,
    });

    sendLog.recordProviderResult("send-1", { lastEvent: "delivered" });
    entry = sendLog.listSendLog().data[0];
    // Fields not passed this time stay as they were.
    expect(entry).toMatchObject({
      providerMessageId: "ses-abc",
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
        provider: "ses",
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
      provider: "ses",
      requestedBy: "route",
    });
    sendLog.recordProviderResult("send-1", {
      providerMessageId: "ses-abc",
      status: "sent",
    });

    expect(sendLog.getSendLog("send-1")).toMatchObject({
      id: "send-1",
      status: "sent",
      providerMessageId: "ses-abc",
    });
  });
});

describe("recordEventByProviderMessageId", () => {
  function setupSes(status: string | null = "sent") {
    const sendLog = setup();
    seed(sendLog, "row", { provider: "ses", providerMessageId: "m1", status });
    return sendLog;
  }

  test("updates status and last_event for the matching provider + message id", () => {
    const sendLog = setupSes();

    const changed = sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: "delivered",
      lastEvent: "delivered",
    });

    expect(changed).toBe(1);
    expect(sendLog.getSendLog("row")).toMatchObject({
      status: "delivered",
      lastEvent: "delivered",
    });
  });

  test("bumps updated_at", () => {
    const { db, sendLog } = setupWithDb();
    seed(sendLog, "row", { provider: "ses", providerMessageId: "m1" });
    db.run("UPDATE send_log SET updated_at = '2020-01-01T00:00:00.000Z'");

    sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: "delivered",
      lastEvent: "delivered",
    });

    expect(sendLog.getSendLog("row")!.updatedAt > "2020-01-01").toBe(true);
  });

  test("matches on provider as well as message id; no match changes 0 rows", () => {
    const sendLog = setupSes();
    const event = { status: "delivered", lastEvent: "delivered" };

    expect(
      sendLog.recordEventByProviderMessageId("other-provider", "m1", event),
    ).toBe(0);
    expect(sendLog.recordEventByProviderMessageId("ses", "other", event)).toBe(
      0,
    );
    expect(sendLog.getSendLog("row")!.status).toBe("sent");
  });

  test("a null status takes any event", () => {
    const sendLog = setupSes(null);

    expect(
      sendLog.recordEventByProviderMessageId("ses", "m1", {
        status: "delivery_delayed",
        lastEvent: "delivery_delayed",
      }),
    ).toBe(1);
  });

  test.each([
    ["delivery_delayed", "delivered", true],
    ["delivered", "delivery_delayed", false],
    ["delivered", "bounced", true],
    ["delivered", "complained", true],
    ["delivered", "rejected", true],
    ["delivered", "failed", true],
    ["bounced", "delivered", false],
    ["bounced", "delivery_delayed", false],
    ["complained", "delivered", false],
    ["delivered", "delivered", true],
    ["bounced", "complained", true],
    ["failed", "bounced", true],
  ])("current %s, event %s -> applied: %p", (current, incoming, applied) => {
    const sendLog = setupSes(current);

    const changed = sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: incoming,
      lastEvent: `${incoming}:detail`,
    });

    expect(changed).toBe(applied ? 1 : 0);
    expect(sendLog.getSendLog("row")).toMatchObject({
      status: applied ? incoming : current,
    });
  });

  test("an equal-rank event overwrites last_event", () => {
    const sendLog = setupSes("bounced");

    sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: "bounced",
      lastEvent: "bounced:Permanent",
    });

    expect(sendLog.getSendLog("row")!.lastEvent).toBe("bounced:Permanent");
  });
});

describe("claimSend / releaseSend", () => {
  const EPOCH = "1970-01-01T00:00:00.000Z";

  function setupClaim() {
    const { db, sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: null });
    return { db, sendLog };
  }

  test("the first claim wins and marks the row sending; a second fails", () => {
    const { sendLog } = setupClaim();

    expect(sendLog.claimSend("row", EPOCH)).toEqual(expect.any(String));
    expect(sendLog.claimSend("row", EPOCH)).toBeNull();
    expect(sendLog.getSendLog("row")!.status).toBe("sending");
  });

  test("a claim older than the cutoff is reclaimable", () => {
    const { db, sendLog } = setupClaim();
    sendLog.claimSend("row", EPOCH);
    db.run("UPDATE send_log SET updated_at = '2026-01-01T00:00:00.000Z'");

    expect(sendLog.claimSend("row", "2026-01-01T00:00:01.000Z")).toEqual(
      expect.any(String),
    );
    expect(sendLog.claimSend("row", "2026-01-01T00:00:01.000Z")).toBeNull();
  });

  test("a row with a provider message id or no row cannot be claimed", () => {
    const sendLog = setup();
    seed(sendLog, "sent-row", { providerMessageId: "m1", status: "sent" });

    expect(sendLog.claimSend("sent-row", EPOCH)).toBeNull();
    expect(sendLog.claimSend("missing", EPOCH)).toBeNull();
  });

  test("release resets a held claim so it can be claimed again", () => {
    const { sendLog } = setupClaim();
    const stamp = sendLog.claimSend("row", EPOCH)!;

    sendLog.releaseSend("row", stamp);

    expect(sendLog.getSendLog("row")!.status).toBeNull();
    expect(sendLog.claimSend("row", EPOCH)).toEqual(expect.any(String));
  });

  test("a takeover by worker B is not cleared by A's late release", () => {
    const { db, sendLog } = setupClaim();
    const stampA = sendLog.claimSend("row", EPOCH)!;
    db.run("UPDATE send_log SET updated_at = '2020-01-01T00:00:00.000Z'");
    Bun.sleepSync(2); // stamps are millisecond ISO strings
    const stampB = sendLog.claimSend("row", "2026-01-01T00:00:00.000Z")!;
    expect(stampB).not.toBe(stampA);

    sendLog.releaseSend("row", stampA);

    expect(sendLog.getSendLog("row")!.status).toBe("sending");
    expect(sendLog.claimSend("row", EPOCH)).toBeNull();
    sendLog.releaseSend("row", stampB);
    expect(sendLog.getSendLog("row")!.status).toBeNull();
  });

  test("release leaves a row that already has a provider message id alone", () => {
    const sendLog = setup();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sending" });

    sendLog.releaseSend("row", "any-stamp");

    expect(sendLog.getSendLog("row")!.status).toBe("sending");
  });

  test("a sending row ranks as sent for events", () => {
    const { sendLog } = setupClaim();
    sendLog.claimSend("row", EPOCH);

    sendLog.recordProviderResult("row", { providerMessageId: "m9" });
    expect(sendLog.getSendLog("row")!.status).toBe("sending");
    expect(
      sendLog.recordEventByProviderMessageId("ses", "m9", {
        status: "delivery_delayed",
        lastEvent: "delivery_delayed",
      }),
    ).toBe(1);
  });
});

describe("recordEventByProviderMessageId bounce detail", () => {
  test("persists the bounce fields and keeps them across a later same-rank event", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });

    sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: "bounced",
      lastEvent: "bounced:Permanent",
      bounceType: "Permanent",
      bounceSubtype: "General",
      diagnosticCode: "smtp; 550 5.1.1 user unknown",
    });
    sendLog.recordEventByProviderMessageId("ses", "m1", {
      status: "complained",
      lastEvent: "complained",
    });

    expect(sendLog.getSendLog("row")).toMatchObject({
      status: "complained",
      bounceType: "Permanent",
      bounceSubtype: "General",
      diagnosticCode: "smtp; 550 5.1.1 user unknown",
    });
  });
});

describe("recordProviderEvent and listSendEvents", () => {
  const delivered = {
    eventType: "Delivery",
    status: "delivered",
    lastEvent: "delivered",
    occurredAt: "2026-10-14T08:00:02.000Z",
  };

  test("updates the status and records the timeline row together", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });

    expect(sendLog.recordProviderEvent("ses", "m1", delivered)).toEqual({
      found: true,
      changed: 1,
      recorded: true,
    });

    expect(sendLog.getSendLog("row")?.status).toBe("delivered");
    expect(sendLog.listSendEvents("row")).toEqual([
      expect.objectContaining({
        sendId: "row",
        eventType: "Delivery",
        status: "delivered",
        occurredAt: "2026-10-14T08:00:02.000Z",
      }),
    ]);
  });

  test("a timeline-only event (status null) leaves send_log untouched", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "delivered" });
    const before = sendLog.getSendLog("row");

    const outcome = sendLog.recordProviderEvent("ses", "m1", {
      eventType: "Send",
      status: null,
      lastEvent: "send",
      occurredAt: "2026-10-14T08:00:00.000Z",
    });

    expect(outcome).toEqual({ found: true, changed: 0, recorded: true });
    expect(sendLog.getSendLog("row")).toEqual(before);
  });

  test("a stale event is still recorded in the timeline", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "delivered" });

    const outcome = sendLog.recordProviderEvent("ses", "m1", {
      eventType: "DeliveryDelay",
      status: "delivery_delayed",
      lastEvent: "delivery_delayed",
      occurredAt: "2026-10-14T07:59:00.000Z",
    });

    expect(outcome).toEqual({ found: true, changed: 0, recorded: true });
    expect(sendLog.getSendLog("row")?.status).toBe("delivered");
  });

  test("a redelivered event is idempotent", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });

    sendLog.recordProviderEvent("ses", "m1", delivered);
    const again = sendLog.recordProviderEvent("ses", "m1", delivered);

    expect(again.recorded).toBe(false);
    expect(sendLog.listSendEvents("row")).toHaveLength(1);
  });

  test("pruneEventsOlderThan deletes only events received before the cutoff", () => {
    const { db, sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });
    sendLog.recordProviderEvent("ses", "m1", {
      eventType: "Send",
      status: null,
      lastEvent: "send",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
    sendLog.recordProviderEvent("ses", "m1", delivered);
    db.run("UPDATE send_events SET received_at = ? WHERE event_type = 'Send'", [
      "2026-08-01T00:00:00.000Z",
    ]);

    expect(sendLog.pruneEventsOlderThan("2026-09-01T00:00:00.000Z")).toBe(1);

    expect(sendLog.listSendEvents("row").map((e) => e.eventType)).toEqual([
      "Delivery",
    ]);
  });

  test("an unknown provider message id is a no-op", () => {
    const { db, sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });

    expect(sendLog.recordProviderEvent("ses", "nope", delivered)).toEqual({
      found: false,
      changed: 0,
      recorded: false,
    });
    expect(sendLog.recordProviderEvent("other", "m1", delivered).found).toBe(
      false,
    );
    expect(db.query("SELECT COUNT(*) AS n FROM send_events").get()).toEqual({
      n: 0,
    });
  });

  test("lists events oldest first by occurrence", () => {
    const { sendLog } = setupWithDb();
    seed(sendLog, "row", { providerMessageId: "m1", status: "sent" });

    sendLog.recordProviderEvent("ses", "m1", delivered);
    sendLog.recordProviderEvent("ses", "m1", {
      eventType: "Send",
      status: null,
      lastEvent: "send",
      occurredAt: "2026-10-14T08:00:00.000Z",
    });

    expect(sendLog.listSendEvents("row").map((e) => e.eventType)).toEqual([
      "Send",
      "Delivery",
    ]);
    expect(sendLog.listSendEvents("missing")).toEqual([]);
  });

  test("the schema has no address column on send_events", () => {
    const { db } = setupWithDb();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(send_events)")
      .all()
      .map((column) => column.name);

    expect(columns.some((name) => /mail|address|recipient/.test(name))).toBe(
      false,
    );
  });
});

describe("getSendStats", () => {
  const NOW = new Date("2026-10-14T12:00:00.000Z");

  function seedAt(
    db: ReturnType<typeof setupWithDb>["db"],
    sendLog: ReturnType<typeof createSendLogRepo>,
    id: string,
    {
      createdAt,
      templateId,
      status,
      providerMessageId = `msg-${id}`,
    }: {
      createdAt: string;
      templateId: string | null;
      status: string | null;
      providerMessageId?: string | null;
    },
  ) {
    sendLog.insertSendLog({
      id,
      templateId,
      recipients: ["jane@example.com"],
      provider: "ses",
      providerMessageId,
      status,
      requestedBy: "route",
    });
    db.run("UPDATE send_log SET created_at = ? WHERE id = ?", [createdAt, id]);
  }

  test("buckets by UTC day, template and status inside the window", () => {
    const { db, sendLog } = setupWithDb();
    seedAt(db, sendLog, "a", {
      createdAt: "2026-10-14T01:00:00.000Z",
      templateId: "fpp-sender",
      status: "delivered",
    });
    seedAt(db, sendLog, "b", {
      createdAt: "2026-10-14T23:00:00.000Z",
      templateId: "fpp-sender",
      status: "delivered",
    });
    seedAt(db, sendLog, "c", {
      createdAt: "2026-10-13T10:00:00.000Z",
      templateId: "shutterflow-code",
      status: "bounced",
    });
    seedAt(db, sendLog, "d", {
      createdAt: "2026-10-13T11:00:00.000Z",
      templateId: null,
      status: null,
      providerMessageId: null,
    });
    seedAt(db, sendLog, "old", {
      createdAt: "2026-08-01T00:00:00.000Z",
      templateId: "fpp-sender",
      status: "delivered",
    });

    const stats = sendLog.getSendStats({ days: 30, now: NOW });

    expect(stats.days).toBe(30);
    expect(stats.since).toBe("2026-09-14T12:00:00.000Z");
    expect(stats.daily).toEqual([
      {
        date: "2026-10-13",
        templateId: "shutterflow-code",
        status: "bounced",
        count: 1,
      },
      {
        date: "2026-10-13",
        templateId: "unknown",
        status: "pending",
        count: 1,
      },
      {
        date: "2026-10-14",
        templateId: "fpp-sender",
        status: "delivered",
        count: 2,
      },
    ]);
  });

  test("computes bounce and complaint rates over 7 and 30 days", () => {
    const { db, sendLog } = setupWithDb();
    const rows: [string, string, string][] = [
      ["r1", "2026-10-13T00:00:00.000Z", "delivered"],
      ["r2", "2026-10-12T00:00:00.000Z", "delivered"],
      ["r3", "2026-10-11T00:00:00.000Z", "bounced"],
      ["r4", "2026-10-10T00:00:00.000Z", "complained"],
      ["r5", "2026-09-25T00:00:00.000Z", "bounced"],
      ["r6", "2026-09-20T00:00:00.000Z", "delivered"],
    ];
    for (const [id, createdAt, status] of rows) {
      seedAt(db, sendLog, id, { createdAt, templateId: "t", status });
    }
    // Never reached the provider: not a send.
    seedAt(db, sendLog, "queued", {
      createdAt: "2026-10-13T00:00:00.000Z",
      templateId: "t",
      status: null,
      providerMessageId: null,
    });

    const { rates } = sendLog.getSendStats({ days: 30, now: NOW });

    expect(rates.last7Days).toEqual({
      sends: 4,
      bounceRate: 0.25,
      complaintRate: 0.25,
    });
    expect(rates.last30Days).toEqual({
      sends: 6,
      bounceRate: 2 / 6,
      complaintRate: 1 / 6,
    });
  });

  test("rates are null when there were no sends", () => {
    const { sendLog } = setupWithDb();

    const stats = sendLog.getSendStats({ days: 30, now: NOW });

    expect(stats.daily).toEqual([]);
    expect(stats.rates.last7Days).toEqual({
      sends: 0,
      bounceRate: null,
      complaintRate: null,
    });
    expect(stats.rates.last30Days.bounceRate).toBeNull();
  });
});
