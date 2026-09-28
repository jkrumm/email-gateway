import { describe, expect, test } from "bun:test";
import { createSendHandler } from "./send";

function fakeResendClient({
  id = "email_1",
  error = null as { name: string; message: string } | null,
} = {}) {
  const calls: { payload: unknown; options?: { idempotencyKey?: string } }[] =
    [];
  // Real Resend dedupes on the Idempotency-Key header server-side: a repeat
  // call with the same key returns the original result without sending a
  // second email. Modelling that here is what lets a test prove the
  // idempotency key actually closes the duplicate-send gap, not just that
  // it's present in the call args.
  const sentKeys = new Set<string>();
  return {
    calls,
    client: {
      emails: {
        send: async (
          payload: unknown,
          options?: { idempotencyKey?: string },
        ) => {
          const key = options?.idempotencyKey;
          if (key && sentKeys.has(key)) {
            return error
              ? { data: null, error }
              : { data: { id }, error: null };
          }
          calls.push({ payload, options });
          if (key) sentKeys.add(key);
          return error ? { data: null, error } : { data: { id }, error: null };
        },
      },
    },
  };
}

describe("createSendHandler", () => {
  test("throws for an unknown template", async () => {
    const { client } = fakeResendClient();
    const handler = createSendHandler({ resendClient: client as never });

    await expect(
      handler({
        id: "send-1",
        from: "no-reply@example.com",
        to: "guest@example.com",
        subject: "Hi",
        templateName: "does-not-exist",
        templateProps: {},
      }),
    ).rejects.toThrow('unknown template "does-not-exist"');
  });

  test("renders the registered template, sends it, and records the provider result", async () => {
    const { client, calls } = fakeResendClient({ id: "email_99" });
    const results: unknown[] = [];
    const handler = createSendHandler({
      resendClient: client as never,
      sendLog: {
        getSendLog: () => null,
        recordProviderResult: (id, patch) => {
          results.push({ id, patch });
        },
      },
    });

    await handler({
      id: "send-1",
      from: "no-reply@free-planning-poker.com",
      to: "guest@example.com",
      subject: "Hi",
      templateName: "fpp-sender",
      templateProps: {
        name: "Jane",
      },
    });

    expect(calls).toHaveLength(1);
    expect(results).toEqual([
      {
        id: "send-1",
        patch: { providerMessageId: "email_99", status: "sent" },
      },
    ]);
  });

  test("a Resend error throws and records nothing", async () => {
    const { client } = fakeResendClient({
      error: { name: "rate_limit", message: "too fast" },
    });
    const results: unknown[] = [];
    const handler = createSendHandler({
      resendClient: client as never,
      sendLog: {
        getSendLog: () => null,
        recordProviderResult: (id, patch) => {
          results.push({ id, patch });
        },
      },
    });

    await expect(
      handler({
        id: "send-1",
        from: "no-reply@free-planning-poker.com",
        to: "guest@example.com",
        subject: "Hi",
        templateName: "fpp-sender",
        templateProps: {},
      }),
    ).rejects.toThrow("rate_limit");
    expect(results).toEqual([]);
  });

  test("a post-send recordProviderResult failure is swallowed, not retried — Resend's idempotency key closes the remaining gap", async () => {
    const { client, calls } = fakeResendClient({ id: "email_1" });
    const payload = {
      id: "send-1",
      from: "no-reply@free-planning-poker.com",
      to: "guest@example.com",
      subject: "Hi",
      templateName: "fpp-sender",
      templateProps: { name: "Jane" },
    };

    const handler = createSendHandler({
      resendClient: client as never,
      sendLog: {
        // The write never lands — a real DB, on this exact failure, would
        // never have recorded "sent" either, so a retry's read genuinely
        // has no way to see this send as already done.
        getSendLog: () => null,
        recordProviderResult: () => {
          throw new Error("SQLITE_BUSY");
        },
      } as never,
    });

    // The handler must not throw: a thrown error here is what the job
    // runner treats as "retry me", and retrying a send that already
    // succeeded is exactly the duplicate this guard exists to prevent.
    await handler(payload);
    expect(calls).toHaveLength(1);

    // A second attempt at the same logical send (the runner retrying for
    // an unrelated reason, or a genuine process crash mid-handler) still
    // falls through the DB-level guard, since getSendLog has nothing to
    // report — but it does not reach Resend as a second real send, because
    // the idempotency key below makes it a no-op duplicate instead.
    await handler(payload);
    expect(calls).toHaveLength(1);
  });

  test("passes the send_log row id as Resend's idempotency key", async () => {
    const { client, calls } = fakeResendClient({ id: "email_1" });
    const handler = createSendHandler({
      resendClient: client as never,
      sendLog: {
        getSendLog: () => null,
        recordProviderResult: () => {},
      } as never,
    });

    await handler({
      id: "send-42",
      from: "no-reply@free-planning-poker.com",
      to: "guest@example.com",
      subject: "Hi",
      templateName: "fpp-sender",
      templateProps: { name: "Jane" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.idempotencyKey).toBe("send-42");
  });
});
