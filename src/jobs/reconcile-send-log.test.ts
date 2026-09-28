import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createSendLogRepo } from "../db/send-log";
import { createReconcileSendLogHandler } from "./reconcile-send-log";

// Fake of the Resend read client: `get` returns a `last_event`, or throws for
// the ids a test marks as failing — the shape src/providers/resend/client.ts
// abstracts (only `emails.get` is used here).
function fakeResendClient({ fail = new Set<string>() } = {}) {
  const calls: string[] = [];
  const client = {
    emails: {
      get: async (id: string) => {
        calls.push(id);
        if (fail.has(id)) throw new Error(`resend error for ${id}`);
        return { data: { last_event: "delivered" }, error: null };
      },
    },
  };
  return { calls, client };
}

function setup(statuses: string[]) {
  const sendLog = createSendLogRepo(openMailDatabase(":memory:"));
  for (const id of statuses) {
    sendLog.insertSendLog({
      id,
      recipients: ["jane@example.com"],
      provider: "resend",
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
  test("refreshes each reconcilable row from the provider's last_event", async () => {
    const sendLog = setup(["send-1", "send-2"]);
    const { calls, client } = fakeResendClient();
    const handler = createReconcileSendLogHandler({
      resendClient: client as never,
      sendLog,
    });

    await handler(undefined);

    expect(calls.sort()).toEqual(["msg-send-1", "msg-send-2"]);
    for (const id of ["send-1", "send-2"]) {
      expect(sendLog.getSendLog(id)).toMatchObject({
        status: "delivered",
        lastEvent: "delivered",
      });
    }
  });

  test("one failing id does not abort the batch or throw", async () => {
    const sendLog = setup(["send-ok", "send-bad", "send-ok-2"]);
    const { calls, client } = fakeResendClient({
      fail: new Set(["msg-send-bad"]),
    });
    const handler = createReconcileSendLogHandler({
      resendClient: client as never,
      sendLog,
    });

    await handler(undefined);

    // Every row was attempted, including the ones after the failure.
    expect(calls.sort()).toEqual([
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
    const fakeSendLog = {
      listReconcilable: () => [
        {
          id: "send-stuck",
          templateId: null,
          recipients: [],
          provider: "resend",
          providerMessageId: "msg-send-stuck",
          status: "sent",
          lastEvent: null,
          requestedBy: "route",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      recordProviderResult: (id: string, patch: unknown) => {
        calls.push({ id, patch });
      },
    };
    const { client } = fakeResendClient({ fail: new Set(["msg-send-stuck"]) });
    const handler = createReconcileSendLogHandler({
      resendClient: client as never,
      sendLog: fakeSendLog,
    });

    await handler(undefined);

    expect(calls).toEqual([{ id: "send-stuck", patch: {} }]);
  });

  test("a hung provider call times out instead of blocking the batch forever", async () => {
    const sendLog = setup(["send-hangs"]);
    const client = {
      emails: { get: async () => new Promise<never>(() => {}) },
    };
    const handler = createReconcileSendLogHandler({
      resendClient: client as never,
      sendLog,
      timeoutMs: 10,
    });

    await handler(undefined);

    // Timed out and rotated, same as any other per-row failure.
    expect(sendLog.getSendLog("send-hangs")).toMatchObject({ status: "sent" });
  });
});
