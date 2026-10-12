import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createSendLogRepo } from "../db/send-log";
import { createFakeSendProvider } from "../test/fake-send-provider";
import { createSendHandler, type SendJobPayload } from "./send";

function setup({ provider = "fake" }: { provider?: string } = {}) {
  const sendLog = createSendLogRepo(openMailDatabase(":memory:"));
  sendLog.insertSendLog({
    id: "send-1",
    templateId: "fpp-sender",
    recipients: ["guest@example.com"],
    provider,
    requestedBy: "api",
  });
  return sendLog;
}

const payload: SendJobPayload = {
  id: "send-1",
  from: "no-reply@free-planning-poker.com",
  to: "guest@example.com",
  subject: "Hi",
  templateName: "fpp-sender",
  templateProps: { name: "Jane" },
};

describe("createSendHandler", () => {
  test("throws for an unknown template", async () => {
    const fake = createFakeSendProvider();
    const handler = createSendHandler({
      providerByName: () => fake,
      sendLog: setup(),
    });

    await expect(
      handler({ ...payload, templateName: "does-not-exist" }),
    ).rejects.toThrow('unknown template "does-not-exist"');
    expect(fake.sent).toHaveLength(0);
  });

  test("throws when the send_log row names a provider this build does not have", async () => {
    const handler = createSendHandler({
      providerByName: () => null,
      sendLog: setup({ provider: "ses" }),
    });

    await expect(handler(payload)).rejects.toThrow('unknown provider "ses"');
  });

  test("throws when the send_log row is missing", async () => {
    const handler = createSendHandler({
      providerByName: () => createFakeSendProvider(),
      sendLog: createSendLogRepo(openMailDatabase(":memory:")),
    });

    await expect(handler(payload)).rejects.toThrow("no send_log row");
  });

  test("sends through the provider the row names, rendered, and records the result", async () => {
    const fake = createFakeSendProvider({
      id: "fake",
      providerMessageId: "msg_99",
    });
    const other = createFakeSendProvider({ id: "other" });
    const requested: string[] = [];
    const sendLog = setup({ provider: "fake" });
    const handler = createSendHandler({
      providerByName: (name) => {
        requested.push(name);
        return name === "fake" ? fake : other;
      },
      sendLog,
    });

    await handler({ ...payload, replyTo: "reply@example.com" });

    expect(requested).toEqual(["fake"]);
    expect(other.sent).toHaveLength(0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      from: "no-reply@free-planning-poker.com",
      to: "guest@example.com",
      replyTo: "reply@example.com",
      subject: "Hi",
    });
    expect(fake.sent[0]?.html).toContain("<");
    expect(fake.sent[0]?.text.length).toBeGreaterThan(0);
    expect(sendLog.getSendLog("send-1")).toMatchObject({
      providerMessageId: "msg_99",
      status: "sent",
    });
  });

  test("a provider error throws and records nothing", async () => {
    const sendLog = setup();
    const handler = createSendHandler({
      providerByName: () => createFakeSendProvider({ sendError: "rate_limit" }),
      sendLog,
    });

    await expect(handler(payload)).rejects.toThrow("rate_limit");
    expect(sendLog.getSendLog("send-1")).toMatchObject({
      providerMessageId: null,
      status: null,
    });
  });

  test("a row already recorded as sent is skipped without calling the provider", async () => {
    const sendLog = setup();
    sendLog.recordProviderResult("send-1", {
      providerMessageId: "msg_1",
      status: "sent",
    });
    const fake = createFakeSendProvider();
    const handler = createSendHandler({
      providerByName: () => fake,
      sendLog,
    });

    await handler(payload);

    expect(fake.sent).toHaveLength(0);
  });

  test("a row reconciled to delivered is still skipped — any recorded provider message id counts", async () => {
    const sendLog = setup();
    sendLog.recordProviderResult("send-1", {
      providerMessageId: "msg_1",
      status: "delivered",
      lastEvent: "delivered",
    });
    const fake = createFakeSendProvider();
    const handler = createSendHandler({
      providerByName: () => fake,
      sendLog,
    });

    await handler(payload);

    expect(fake.sent).toHaveLength(0);
  });

  test("a post-send recordProviderResult failure is swallowed, not retried — the idempotency key closes the remaining gap", async () => {
    const fake = createFakeSendProvider({ providerMessageId: "msg_1" });
    const handler = createSendHandler({
      providerByName: () => fake,
      sendLog: {
        // The write never lands — a real DB, on this exact failure, would
        // never have recorded "sent" either, so a retry's read genuinely
        // has no way to see this send as already done.
        getSendLog: setup().getSendLog,
        recordProviderResult: () => {
          throw new Error("SQLITE_BUSY");
        },
      },
    });

    // The handler must not throw: a thrown error here is what the job
    // runner treats as "retry me", and retrying a send that already
    // succeeded is exactly the duplicate this guard exists to prevent.
    await handler(payload);
    expect(fake.sent).toHaveLength(1);

    // A second attempt at the same logical send still falls through the
    // DB-level guard, but does not reach the provider as a second real send,
    // because the idempotency key makes it a no-op duplicate instead.
    await handler(payload);
    expect(fake.sent).toHaveLength(1);
  });

  test("passes the send_log row id as the provider's idempotency key", async () => {
    const fake = createFakeSendProvider();
    const handler = createSendHandler({
      providerByName: () => fake,
      sendLog: setup(),
    });

    await handler({ ...payload, id: "send-1" });

    expect(fake.sent[0]?.idempotencyKey).toBe("send-1");
  });
});
