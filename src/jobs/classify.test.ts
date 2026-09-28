import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo, type MessageEnvelope } from "../db/messages";
import type { MailProvider, Message, MessageRef } from "../providers/port";
import { createClassifyHandler } from "./classify";

const ACCOUNT_ID = "proton:hello@example.com";

function setup() {
  const db = openMailDatabase(":memory:");
  const accounts = createAccountsRepo(db);
  const messages = createMessagesRepo(db);
  accounts.upsertAccount({
    id: ACCOUNT_ID,
    provider: "proton",
    address: "hello@example.com",
  });
  return { accounts, messages };
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    key: "key-1",
    account: ACCOUNT_ID,
    direction: "inbound",
    fromAddress: "sender@example.com",
    toAddresses: ["hello@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Subject",
    date: "2026-01-01T00:00:00.000Z",
    size: 100,
    hasAttachments: false,
    threadKey: null,
    flags: [],
    ...overrides,
  };
}

function withLocation(
  messages: ReturnType<typeof createMessagesRepo>,
  overrides: Partial<MessageEnvelope> = {},
) {
  const env = envelope(overrides);
  messages.upsertMessage(env);
  messages.upsertLocation(env.key, {
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
  return env;
}

function fakeProvider(
  read: (ref: MessageRef) => Promise<Message>,
): MailProvider {
  return {
    id: "proton",
    account: "hello@example.com",
    capabilities: async () => ({
      list: true,
      read: true,
      search: false,
      flag: false,
      move: false,
      send: false,
      idle: false,
    }),
    listMailboxes: async () => [],
    list: async () => ({ items: [], cursor: undefined }),
    read,
    search: async () => [],
    setFlags: async () => {},
    move: async (ref) => ref,
    send: async () => {
      throw new Error("not implemented in fake");
    },
  };
}

describe("createClassifyHandler", () => {
  test("a missing message is a no-op", async () => {
    const { messages } = setup();
    const handler = createClassifyHandler({
      messages,
      isLlmConfigured: () => true,
    });

    await expect(handler({ key: "missing" })).resolves.toBeUndefined();
  });

  test("skips without doing anything when the LLM is not configured", async () => {
    const { messages } = setup();
    withLocation(messages);
    let readCalled = false;
    const handler = createClassifyHandler({
      messages,
      providerFor: () =>
        fakeProvider(async () => {
          readCalled = true;
          throw new Error("should not be called");
        }),
      isLlmConfigured: () => false,
    });

    await handler({ key: "key-1" });
    expect(readCalled).toBe(false);
  });

  test("fetches the body live, saves it, and stores the classification", async () => {
    const { messages } = setup();
    withLocation(messages);
    const provider = fakeProvider(async (ref) => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Subject",
      date: "2026-01-01T00:00:00.000Z",
      size: 100,
      hasAttachments: false,
      flags: [],
      html: "<p>hi</p>",
      text: "hi",
      attachments: [],
    }));

    const handler = createClassifyHandler({
      messages,
      providerFor: () => provider,
      isLlmConfigured: () => true,
      isJevConfigured: () => false,
      enrichEmail: async () => ({
        ok: true,
        result: {
          category: "customer",
          priority: "normal",
          actionRequired: false,
          summary: "hello",
          suggestedAction: null,
          language: "en",
          facts: [],
          model: "test-model",
        },
      }),
    });

    await handler({ key: "key-1" });

    expect(messages.getBody("key-1")).toMatchObject({
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(messages.getClassification("key-1")).toMatchObject({
      category: "customer",
      summary: "hello",
    });
  });

  test("enqueues jev_message for an inbound message once Jev is configured", async () => {
    const { messages } = setup();
    withLocation(messages, { direction: "inbound" });
    const provider = fakeProvider(async (ref) => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Subject",
      date: "2026-01-01T00:00:00.000Z",
      size: 100,
      hasAttachments: false,
      flags: [],
      html: null,
      text: "hi",
      attachments: [],
    }));
    const enqueued: string[] = [];

    const handler = createClassifyHandler({
      messages,
      providerFor: () => provider,
      isLlmConfigured: () => true,
      isJevConfigured: () => true,
      enqueueJevMessage: (key) => enqueued.push(key),
      enrichEmail: async () => ({
        ok: true,
        result: {
          category: "customer",
          priority: "normal",
          actionRequired: false,
          summary: "hello",
          suggestedAction: null,
          language: "en",
          facts: [],
          model: "test-model",
        },
      }),
    });

    await handler({ key: "key-1" });
    expect(enqueued).toEqual(["key-1"]);
  });

  test("does not enqueue jev_message for an outbound message", async () => {
    const { messages } = setup();
    withLocation(messages, { direction: "outbound" });
    const provider = fakeProvider(async (ref) => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Subject",
      date: "2026-01-01T00:00:00.000Z",
      size: 100,
      hasAttachments: false,
      flags: [],
      html: null,
      text: "hi",
      attachments: [],
    }));
    const enqueued: string[] = [];

    const handler = createClassifyHandler({
      messages,
      providerFor: () => provider,
      isLlmConfigured: () => true,
      isJevConfigured: () => true,
      enqueueJevMessage: (key) => enqueued.push(key),
      enrichEmail: async () => ({
        ok: true,
        result: {
          category: "customer",
          priority: "normal",
          actionRequired: false,
          summary: "hello",
          suggestedAction: null,
          language: "en",
          facts: [],
          model: "test-model",
        },
      }),
    });

    await handler({ key: "key-1" });
    expect(enqueued).toEqual([]);
  });

  test("an enrichEmail failure throws so the job runner retries", async () => {
    const { messages } = setup();
    withLocation(messages);
    const provider = fakeProvider(async (ref) => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Subject",
      date: "2026-01-01T00:00:00.000Z",
      size: 100,
      hasAttachments: false,
      flags: [],
      html: null,
      text: "hi",
      attachments: [],
    }));

    const handler = createClassifyHandler({
      messages,
      providerFor: () => provider,
      isLlmConfigured: () => true,
      enrichEmail: async () => ({ ok: false, error: "model unavailable" }),
    });

    await expect(handler({ key: "key-1" })).rejects.toThrow(
      "model unavailable",
    );
  });

  test("no location to read from throws", async () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());

    const handler = createClassifyHandler({
      messages,
      isLlmConfigured: () => true,
    });

    await expect(handler({ key: "key-1" })).rejects.toThrow(
      "no location to read from",
    );
  });
});
