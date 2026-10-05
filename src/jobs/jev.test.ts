import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo, type MessageEnvelope } from "../db/messages";
import { createMailSubmissionsRepo } from "../db/mail-submissions";
import type { MailProvider, Message, MessageRef } from "../providers/port";
import { createJevMessageHandler, createJevSubmissionHandler } from "./jev";

const JEV_CONFIG = { apiKey: "k", model: "cloudflare/clef" };
const ACCOUNT_ID = "proton:hello@example.com";

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

describe("createJevSubmissionHandler", () => {
  function setup() {
    return createMailSubmissionsRepo(openMailDatabase(":memory:"));
  }

  test("a missing submission is a no-op", async () => {
    const submissions = setup();
    const handler = createJevSubmissionHandler({
      submissions,
      config: () => JEV_CONFIG,
    });

    await expect(handler({ id: "missing" })).resolves.toBeUndefined();
  });

  test("skips without a config", async () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "ok",
      model: "m",
      delivered: true,
      submission: {},
    });
    const handler = createJevSubmissionHandler({
      submissions,
      config: () => null,
    });

    await handler({ id: record.id });
    expect(submissions.getSubmission(record.id)?.jev).toBeNull();
  });

  test("saves a successful verdict", async () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "ok",
      model: "m",
      delivered: true,
      submission: { message: "hi" },
    });

    const handler = createJevSubmissionHandler({
      submissions,
      config: () => JEV_CONFIG,
      judgeSubmission: async () =>
        ({
          verdict: "spam",
          confidence: 0.8,
          probabilities: { legit: 0.2, spam: 0.8, marketing: 0 },
          latencyMs: 12,
          model: "cloudflare/clef",
        }) as never,
    });

    await handler({ id: record.id });

    expect(submissions.getSubmission(record.id)?.jev).toMatchObject({
      verdict: "spam",
      confidence: 0.8,
    });
  });

  test("a rejecting judge throws so the runner retries and never writes an error result", async () => {
    const submissions = setup();
    const record = submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.9,
      reason: "ok",
      model: "m",
      delivered: true,
      submission: {},
    });

    const handler = createJevSubmissionHandler({
      submissions,
      config: () => JEV_CONFIG,
      judgeSubmission: () => Promise.reject(new Error("429")) as never,
    });

    await expect(handler({ id: record.id })).rejects.toThrow("429");
    expect(submissions.getSubmission(record.id)?.jev).toBeNull();
  });
});

describe("createJevMessageHandler", () => {
  function setup() {
    const db = openMailDatabase(":memory:");
    const accounts = createAccountsRepo(db);
    const messages = createMessagesRepo(db);
    accounts.upsertAccount({
      id: ACCOUNT_ID,
      provider: "proton",
      address: "hello@example.com",
    });
    return { messages };
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

  test("a missing message is a no-op", async () => {
    const { messages } = setup();
    const handler = createJevMessageHandler({
      messages,
      config: () => JEV_CONFIG,
    });

    await expect(handler({ key: "missing" })).resolves.toBeUndefined();
  });

  test("uses the cached body without calling the provider", async () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());
    messages.saveBody("key-1", { html: "<p>hi</p>", text: "hi" });
    let readCalled = false;

    const handler = createJevMessageHandler({
      messages,
      config: () => JEV_CONFIG,
      providerFor: () =>
        fakeProvider(async () => {
          readCalled = true;
          throw new Error("should not be called");
        }),
      judgeEmail: async () =>
        ({
          spamProbability: 0.1,
          category: "customer",
          categoryConfidence: 0.9,
          latencyMs: 5,
          model: "cloudflare/clef",
        }) as never,
    });

    await handler({ key: "key-1" });
    expect(readCalled).toBe(false);
    expect(messages.getClassification("key-1")).toMatchObject({
      jevSpamProbability: 0.1,
      jevCategory: "customer",
    });
  });

  test("fetches live when no body is cached, and merges jev fields onto an existing classification", async () => {
    const { messages } = setup();
    messages.upsertMessage(envelope());
    messages.upsertLocation("key-1", {
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
    messages.saveEnrichment("key-1", {
      category: "customer",
      priority: "normal",
      actionRequired: false,
      summary: "existing summary",
      suggestedAction: null,
      language: "en",
      facts: null,
      model: "llm-model",
      error: null,
    });

    const handler = createJevMessageHandler({
      messages,
      config: () => JEV_CONFIG,
      providerFor: () =>
        fakeProvider(async (ref) => ({
          ref,
          from: "sender@example.com",
          to: ["hello@example.com"],
          subject: "Subject",
          date: "2026-01-01T00:00:00.000Z",
          size: 100,
          hasAttachments: false,
          flags: [],
          html: null,
          text: "live body",
          attachments: [],
        })),
      judgeEmail: async () =>
        ({
          spamProbability: 0.05,
          category: "customer",
          categoryConfidence: 0.95,
          latencyMs: 7,
          model: "cloudflare/clef",
        }) as never,
    });

    await handler({ key: "key-1" });

    expect(messages.getClassification("key-1")).toMatchObject({
      category: "customer",
      summary: "existing summary",
      jevSpamProbability: 0.05,
      jevCategoryConfidence: 0.95,
    });
  });
});
