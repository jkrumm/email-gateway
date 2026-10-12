import { describe, expect, test } from "bun:test";
import { createResendSendProvider } from "./send";

const message = {
  from: "Sender <sender@example.com>",
  to: "guest@example.com",
  replyTo: "reply@example.com",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
};

function fakeSendClient(
  result:
    | { data: { id: string }; error: null }
    | {
        data: null;
        error: { statusCode: number | null; name: string; message: string };
      },
) {
  const calls: { payload: unknown; options: unknown }[] = [];
  return {
    calls,
    client: {
      emails: {
        send: async (payload: unknown, options?: unknown) => {
          calls.push({ payload, options });
          return result;
        },
      },
    } as never,
  };
}

function fakeReadClient(
  result:
    | { data: { last_event: string }; error: null }
    | { data: null; error: { message: string } },
) {
  const ids: string[] = [];
  return {
    ids,
    client: {
      emails: {
        get: async (id: string) => {
          ids.push(id);
          return result;
        },
      },
    } as never,
  };
}

describe("createResendSendProvider", () => {
  test("is the resend provider", () => {
    const provider = createResendSendProvider({
      sendClient: fakeSendClient({ data: { id: "x" }, error: null }).client,
      readClient: fakeReadClient({ data: { last_event: "sent" }, error: null })
        .client,
    });

    expect(provider.id).toBe("resend");
  });

  test("send() passes html and text and returns the message id", async () => {
    const send = fakeSendClient({ data: { id: "email_1" }, error: null });
    const provider = createResendSendProvider({
      sendClient: send.client,
      readClient: fakeReadClient({ data: { last_event: "sent" }, error: null })
        .client,
    });

    await expect(provider.send(message)).resolves.toEqual({
      providerMessageId: "email_1",
    });
    expect(send.calls).toEqual([{ payload: message, options: undefined }]);
  });

  test("send() forwards the idempotency key as a request option, not in the payload", async () => {
    const send = fakeSendClient({ data: { id: "email_1" }, error: null });
    const provider = createResendSendProvider({
      sendClient: send.client,
      readClient: fakeReadClient({ data: { last_event: "sent" }, error: null })
        .client,
    });

    await provider.send({ ...message, idempotencyKey: "send-42" });

    expect(send.calls).toEqual([
      { payload: message, options: { idempotencyKey: "send-42" } },
    ]);
  });

  test("send() throws with the old sendMail error format", async () => {
    const provider = createResendSendProvider({
      sendClient: fakeSendClient({
        data: null,
        error: { statusCode: 429, name: "rate_limit", message: "too fast" },
      }).client,
      readClient: fakeReadClient({ data: { last_event: "sent" }, error: null })
        .client,
    });

    await expect(provider.send(message)).rejects.toThrow(
      "429 - rate_limit - too fast",
    );
  });

  test("send() leaves the status code slot empty when Resend gives none", async () => {
    const provider = createResendSendProvider({
      sendClient: fakeSendClient({
        data: null,
        error: { statusCode: null, name: "application_error", message: "boom" },
      }).client,
      readClient: fakeReadClient({ data: { last_event: "sent" }, error: null })
        .client,
    });

    await expect(provider.send(message)).rejects.toThrow(
      " - application_error - boom",
    );
  });

  test("status() reads last_event through the read client for both fields", async () => {
    const read = fakeReadClient({
      data: { last_event: "delivered" },
      error: null,
    });
    const provider = createResendSendProvider({
      sendClient: fakeSendClient({ data: { id: "x" }, error: null }).client,
      readClient: read.client,
    });

    await expect(provider.status!("email_1")).resolves.toEqual({
      status: "delivered",
      lastEvent: "delivered",
    });
    expect(read.ids).toEqual(["email_1"]);
  });

  test("status() throws Resend's error message", async () => {
    const provider = createResendSendProvider({
      sendClient: fakeSendClient({ data: { id: "x" }, error: null }).client,
      readClient: fakeReadClient({
        data: null,
        error: { message: "restricted key" },
      }).client,
    });

    await expect(provider.status!("email_1")).rejects.toThrow("restricted key");
  });
});
