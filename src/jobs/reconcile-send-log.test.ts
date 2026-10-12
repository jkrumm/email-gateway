import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createSendLogRepo } from "../db/send-log";
import { createFakeSendProvider } from "../test/fake-send-provider";
import { createReconcileSendLogHandler } from "./reconcile-send-log";

function setup(ids: string[], provider = "fake") {
  const sendLog = createSendLogRepo(openMailDatabase(":memory:"));
  for (const id of ids) {
    sendLog.insertSendLog({
      id,
      recipients: ["jane@example.com"],
      provider,
      requestedBy: "route",
    });
    sendLog.recordProviderResult(id, {
      providerMessageId: `msg-${id}`,
      status: "sent",
    });
  }
  return sendLog;
}

describe("createReconcileSendLogHandler", () => {
  test("refreshes each reconcilable row from the provider's status", async () => {
    const sendLog = setup(["send-1", "send-2"]);
    const fake = createFakeSendProvider();
    const handler = createReconcileSendLogHandler({
      providers: { fake },
      sendLog,
    });

    await handler(undefined);

    expect(fake.statusCalls.sort()).toEqual(["msg-send-1", "msg-send-2"]);
    for (const id of ["send-1", "send-2"]) {
      expect(sendLog.getSendLog(id)).toMatchObject({
        status: "delivered",
        lastEvent: "delivered",
      });
    }
  });

  test("refreshes a route-send row written with its provider message id by sendMail", async () => {
    const sendLog = createSendLogRepo(openMailDatabase(":memory:"));
    sendLog.insertSendLog({
      id: "msg_route",
      templateId: "fpp-receiver",
      recipients: ["me@example.com"],
      provider: "fake",
      providerMessageId: "msg_route",
      status: "sent",
      requestedBy: "route",
    });
    const fake = createFakeSendProvider({ statuses: { msg_route: "bounced" } });
    const handler = createReconcileSendLogHandler({
      providers: { fake },
      sendLog,
    });

    await handler(undefined);

    expect(sendLog.getSendLog("msg_route")).toMatchObject({
      status: "bounced",
      lastEvent: "bounced",
    });
  });

  test("dispatches each row to the provider named by send_log.provider", async () => {
    const sendLog = setup(["a-1"], "alpha");
    sendLog.insertSendLog({
      id: "b-1",
      recipients: ["jane@example.com"],
      provider: "beta",
      providerMessageId: "msg-b-1",
      status: "sent",
      requestedBy: "route",
    });
    const alpha = createFakeSendProvider({
      id: "alpha",
      statuses: { "msg-a-1": "delivered" },
    });
    const beta = createFakeSendProvider({
      id: "beta",
      statuses: { "msg-b-1": "complained" },
    });
    const handler = createReconcileSendLogHandler({
      providers: { alpha, beta },
      sendLog,
    });

    await handler(undefined);

    expect(alpha.statusCalls).toEqual(["msg-a-1"]);
    expect(beta.statusCalls).toEqual(["msg-b-1"]);
    expect(sendLog.getSendLog("a-1")?.status).toBe("delivered");
    expect(sendLog.getSendLog("b-1")?.status).toBe("complained");
  });

  test("skips a provider that cannot read status back", async () => {
    const sendLog = setup(["send-1"], "mute");
    const handler = createReconcileSendLogHandler({
      providers: {
        mute: createFakeSendProvider({ id: "mute", withoutStatus: true }),
      },
      sendLog,
    });

    await handler(undefined);

    expect(sendLog.getSendLog("send-1")).toMatchObject({ status: "sent" });
  });

  test("one failing id does not abort the batch or throw", async () => {
    const sendLog = setup(["send-ok", "send-bad", "send-ok-2"]);
    const fake = createFakeSendProvider({
      failStatusFor: new Set(["msg-send-bad"]),
    });
    const handler = createReconcileSendLogHandler({
      providers: { fake },
      sendLog,
    });

    await handler(undefined);

    // Every row was attempted, including the ones after the failure.
    expect(fake.statusCalls.sort()).toEqual([
      "msg-send-bad",
      "msg-send-ok",
      "msg-send-ok-2",
    ]);
    expect(sendLog.getSendLog("send-ok")).toMatchObject({
      status: "delivered",
      lastEvent: "delivered",
    });
    expect(sendLog.getSendLog("send-ok-2")).toMatchObject({
      status: "delivered",
      lastEvent: "delivered",
    });
    // The failure left the row's status/lastEvent exactly as it was...
    expect(sendLog.getSendLog("send-bad")).toMatchObject({
      status: "sent",
      lastEvent: null,
    });
  });

  test("a failing row still gets its updated_at touched, so it rotates out of the next batch's head", async () => {
    // A row stuck failing forever (e.g. RESEND_ADMIN_API_KEY unset, per
    // src/utils/resend.ts's fallback) must not permanently occupy the
    // oldest-updated-first batch and starve every newer row of ever being
    // reconciled. Asserted directly against the repo call, not real
    // wall-clock ordering — two updated_at writes in the same test can land
    // in the same millisecond and make an ordering-based assertion flaky.
    const calls: unknown[] = [];
    const listed: unknown[] = [];
    const fakeSendLog = {
      listReconcilable: (input: unknown) => {
        listed.push(input);
        return [
          {
            id: "send-stuck",
            templateId: null,
            recipients: [],
            provider: "fake",
            providerMessageId: "msg-send-stuck",
            status: "sent",
            lastEvent: null,
            requestedBy: "route",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ];
      },
      recordProviderResult: (id: string, patch: unknown) => {
        calls.push({ id, patch });
      },
    };
    const fake = createFakeSendProvider({
      failStatusFor: new Set(["msg-send-stuck"]),
    });
    const handler = createReconcileSendLogHandler({
      providers: { fake },
      sendLog: fakeSendLog,
    });

    await handler(undefined);

    expect(listed).toEqual([{ provider: "fake", limit: 25 }]);
    expect(calls).toEqual([{ id: "send-stuck", patch: {} }]);
  });

  test("a hung provider call times out instead of blocking the batch forever", async () => {
    const sendLog = setup(["send-hangs"]);
    const fake = createFakeSendProvider({
      hangStatusFor: new Set(["msg-send-hangs"]),
    });
    const handler = createReconcileSendLogHandler({
      providers: { fake },
      sendLog,
      timeoutMs: 10,
    });

    await handler(undefined);

    // Timed out and rotated, same as any other per-row failure.
    expect(sendLog.getSendLog("send-hangs")).toMatchObject({ status: "sent" });
  });
});
