import { describe, expect, test } from "bun:test";
import { createAgentApi } from "./agent-api";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import {
  createMessagesRepo,
  type MessageEnvelope,
  type MessagesRepo,
} from "../db/messages";
import { createSendLogRepo } from "../db/send-log";
import { createThreadSummariesRepo } from "../db/thread-summaries";
import { createJobQueue } from "../db/jobs";
import { TEMPLATE_IDS } from "../emails/registry";
import type { MailProvider, Message, MessageRef } from "../providers/port";
import type {
  summarizeThread,
  ThreadMessageForSummary,
} from "../llm/thread-summary";
import type { draftReply } from "../llm/draft-reply";

type SummarizeThreadFn = typeof summarizeThread;
type DraftReplyFn = typeof draftReply;

const ACCOUNT_ID = "proton:hello@example.com";
const REF: MessageRef = {
  provider: "proton",
  account: "hello@example.com",
  mailbox: "INBOX",
  uidValidity: "1",
  uid: 1,
};

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    key: "msg-1",
    account: ACCOUNT_ID,
    direction: "inbound",
    fromAddress: "sender@example.com",
    toAddresses: ["hello@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Hello there",
    date: "2026-01-01T00:00:00.000Z",
    size: 1024,
    hasAttachments: false,
    threadKey: null,
    flags: [],
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    id: "proton",
    account: "hello@example.com",
    capabilities: async () => ({
      list: true,
      read: true,
      search: false,
      flag: true,
      move: true,
      send: false,
      idle: false,
    }),
    listMailboxes: async () => [],
    list: async () => ({ items: [], cursor: undefined }),
    read: async (ref: MessageRef): Promise<Message> => ({
      ref,
      from: "sender@example.com",
      to: ["hello@example.com"],
      subject: "Hello there",
      date: "2026-01-01T00:00:00.000Z",
      size: 1024,
      hasAttachments: false,
      flags: [],
      html: null,
      text: "live body",
      attachments: [],
    }),
    search: async () => [],
    setFlags: async () => {},
    move: async (ref) => ref,
    send: async () => {
      throw new Error("not implemented in fake");
    },
    ...overrides,
  };
}

function setup({
  summarizeThread,
  draftReply,
  providerFor,
  isLlmConfigured = () => true,
}: {
  summarizeThread?: SummarizeThreadFn;
  draftReply?: DraftReplyFn;
  providerFor?: (accountId: string) => MailProvider | null;
  isLlmConfigured?: () => boolean;
} = {}) {
  const db = openMailDatabase(":memory:");
  const messages = createMessagesRepo(db);
  const accounts = createAccountsRepo(db);
  const sendLog = createSendLogRepo(db);
  const threadSummaries = createThreadSummariesRepo(db);
  const jobs = createJobQueue({ db, claimedBy: "test:1" });
  accounts.upsertAccount({
    id: ACCOUNT_ID,
    provider: "proton",
    address: "hello@example.com",
  });

  const api = createAgentApi({
    db,
    messages,
    jobs,
    sendLog,
    threadSummaries,
    providerFor: providerFor ?? (() => null),
    summarizeThread: (summarizeThread ?? defaultSummarize) as SummarizeThreadFn,
    draftReply: (draftReply ?? defaultDraft) as DraftReplyFn,
    isLlmConfigured,
  });

  return { api, messages, sendLog, threadSummaries, jobs };
}

function defaultSummarize() {
  return Promise.resolve({
    ok: true as const,
    summary: "default summary",
    model: "default-model",
  });
}

function defaultDraft() {
  return Promise.resolve({
    ok: true as const,
    draft: "default draft",
    model: "default-model",
  });
}

function classificationField(actionRequired: boolean) {
  return {
    category: "cat",
    priority: "normal",
    actionRequired,
    summary: null,
    suggestedAction: null,
    language: null,
    facts: null,
    model: "m",
    error: null,
  };
}

describe("searchMail", () => {
  test("expands matched keys into full message summaries", () => {
    const { api, messages } = setup();
    messages.upsertMessage(
      envelope({ key: "msg-1", subject: "Quarterly invoice attached" }),
    );

    const result = api.searchMail({ q: "invoice" });

    expect(result.via).toBe("fts");
    expect(result.keys.map((row) => row.key)).toEqual(["msg-1"]);
  });
});

describe("readMessage", () => {
  test("returns not_found for an unknown key", () => {
    const { api } = setup();
    expect(api.readMessage({ key: "missing" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  test("merges the classification and includes body only when asked", () => {
    const { api, messages } = setup();
    messages.upsertMessage(envelope());
    messages.saveBody("msg-1", { html: "<p>hi</p>", text: "hi" });

    const withoutBody = api.readMessage({ key: "msg-1" });
    expect(withoutBody.ok).toBe(true);
    if (withoutBody.ok) expect("body" in withoutBody.message).toBe(false);

    const withBody = api.readMessage({ key: "msg-1", includeBody: true });
    expect(withBody.ok).toBe(true);
    if (withBody.ok) {
      expect(withBody.message.body).toMatchObject({
        html: "<p>hi</p>",
        text: "hi",
      });
    }
  });
});

describe("getThread", () => {
  test("groups every message sharing the same threadKey", () => {
    const { api, messages } = setup();
    messages.upsertMessage(
      envelope({
        key: "msg-a",
        threadKey: "thread-1",
        date: "2026-01-01T00:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        threadKey: "thread-1",
        date: "2026-01-02T00:00:00.000Z",
      }),
    );

    const outcome = api.getThread({ key: "msg-a" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.thread.rows.map((row) => row.key)).toEqual([
        "msg-b",
        "msg-a",
      ]);
    }
  });

  test("a message with no threadKey returns just itself", () => {
    const { api, messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-1", threadKey: null }));

    const outcome = api.getThread({ key: "msg-1" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.thread.rows.map((row) => row.key)).toEqual(["msg-1"]);
    }
  });
});

describe("getThreadSummary", () => {
  test("returns not_found for an unknown key", async () => {
    const { api } = setup();
    expect(await api.getThreadSummary({ key: "missing" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  test("returns llm_not_configured when the LLM is off", async () => {
    const { api, messages } = setup({ isLlmConfigured: () => false });
    messages.upsertMessage(envelope());

    expect(await api.getThreadSummary({ key: "msg-1" })).toEqual({
      ok: false,
      error: "llm_not_configured",
    });
  });

  test("summarizes oldest-first from classification summaries and caches the result", async () => {
    const calls: ThreadMessageForSummary[][] = [];
    const { api, messages, threadSummaries } = setup({
      summarizeThread: (input) => {
        calls.push(input.messages);
        return Promise.resolve({
          ok: true as const,
          summary: "A and B agreed.",
          model: "test-model",
        });
      },
    });
    messages.upsertMessage(
      envelope({
        key: "msg-a",
        threadKey: "thread-1",
        date: "2026-01-02T00:00:00.000Z",
      }),
    );
    messages.upsertMessage(
      envelope({
        key: "msg-b",
        threadKey: "thread-1",
        date: "2026-01-01T00:00:00.000Z",
        fromAddress: null,
        subject: null,
      }),
    );
    messages.saveEnrichment("msg-a", {
      ...classificationField(false),
      summary: "Message A summary",
    });

    const outcome = await api.getThreadSummary({ key: "msg-b" });

    expect(outcome).toEqual({
      ok: true,
      summary: "A and B agreed.",
      model: "test-model",
      messageCount: 2,
      cached: false,
    });
    // Oldest (msg-b) first, even though listMessages returns newest-first.
    expect(calls[0]!.map((row) => row.date)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(calls[0]![1]!.summary).toBe("Message A summary");
    expect(calls[0]![0]!.summary).toBeNull();
    expect(threadSummaries.getSummary("thread-1")?.messageCount).toBe(2);
  });

  test("a cache hit does not call the LLM again", async () => {
    let calls = 0;
    const { api, messages, threadSummaries } = setup({
      summarizeThread: () => {
        calls += 1;
        return Promise.resolve({
          ok: true as const,
          summary: "cached text",
          model: "test-model",
        });
      },
    });
    messages.upsertMessage(envelope({ key: "msg-1", threadKey: "thread-1" }));
    threadSummaries.saveSummary("thread-1", {
      summary: "cached text",
      model: "test-model",
      messageCount: 1,
      latestKey: "msg-1",
    });

    const outcome = await api.getThreadSummary({ key: "msg-1" });

    expect(calls).toBe(0);
    expect(outcome).toEqual({
      ok: true,
      summary: "cached text",
      model: "test-model",
      messageCount: 1,
      cached: true,
    });
  });

  test("re-summarizes once the thread's newest message changes", async () => {
    let calls = 0;
    const { api, messages, threadSummaries } = setup({
      summarizeThread: () => {
        calls += 1;
        return Promise.resolve({
          ok: true as const,
          summary: "fresh text",
          model: "test-model",
        });
      },
    });
    messages.upsertMessage(envelope({ key: "msg-1", threadKey: "thread-1" }));
    // Cached against a different newest key than the thread now reports.
    threadSummaries.saveSummary("thread-1", {
      summary: "stale text",
      model: "test-model",
      messageCount: 1,
      latestKey: "older-key",
    });

    const outcome = await api.getThreadSummary({ key: "msg-1" });

    expect(calls).toBe(1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.cached).toBe(false);
  });

  test("detects a new message in a thread longer than one page", async () => {
    let calls = 0;
    const page = Array.from({ length: 100 }, (_, index) =>
      envelope({
        key: `msg-${index}`,
        threadKey: "thread-1",
        date: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    // A stub messages repo whose 100-row page can never show the 101st
    // message, but whose one-row lookup does — the exact shape that made the
    // old messageCount comparison go permanently stale.
    const messages = {
      getMessage: (key: string) => ({
        ...envelope({ key, threadKey: "thread-1" }),
        locations: [],
      }),
      listMessages: ({ limit }: { limit?: number }) =>
        limit === 1
          ? {
              rows: [
                {
                  ...envelope({
                    key: "msg-100",
                    threadKey: "thread-1",
                    date: "2026-04-01T00:00:00.000Z",
                  }),
                  classification: null,
                },
              ],
              nextCursor: null,
            }
          : {
              rows: page.map((row) => ({ ...row, classification: null })),
              nextCursor: null,
            },
      getClassification: () => null,
    } as unknown as MessagesRepo;
    const db = openMailDatabase(":memory:");
    const threadSummaries = createThreadSummariesRepo(db);
    threadSummaries.saveSummary("thread-1", {
      summary: "stale text",
      model: "test-model",
      messageCount: 100,
      latestKey: "msg-99",
    });
    const api = createAgentApi({
      messages,
      threadSummaries,
      providerFor: () => null,
      summarizeThread: () => {
        calls += 1;
        return Promise.resolve({
          ok: true as const,
          summary: "fresh text",
          model: "test-model",
        });
      },
      isLlmConfigured: () => true,
    });

    const outcome = await api.getThreadSummary({ key: "msg-0" });

    expect(calls).toBe(1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.cached).toBe(false);
    expect(threadSummaries.getSummary("thread-1")?.latestKey).toBe("msg-100");
  });

  test("caches on the message's own key when it has no threadKey", async () => {
    const { api, messages, threadSummaries } = setup();
    messages.upsertMessage(envelope({ key: "solo", threadKey: null }));

    const outcome = await api.getThreadSummary({ key: "solo" });

    expect(outcome.ok).toBe(true);
    expect(threadSummaries.getSummary("solo")?.messageCount).toBe(1);
  });
});

describe("listNeedsAction", () => {
  test("returns only action-required messages", () => {
    const { api, messages } = setup();
    messages.upsertMessage(envelope({ key: "msg-a" }));
    messages.upsertMessage(envelope({ key: "msg-b" }));
    messages.saveEnrichment("msg-a", classificationField(true));
    messages.saveEnrichment("msg-b", classificationField(false));

    expect(api.listNeedsAction({}).rows.map((row) => row.key)).toEqual([
      "msg-a",
    ]);
  });
});

describe("draftReply", () => {
  test("returns not_found for an unknown key", async () => {
    const { api } = setup();
    expect(await api.draftReply({ key: "missing" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  test("returns llm_not_configured when the LLM is off", async () => {
    const { api, messages } = setup({ isLlmConfigured: () => false });
    messages.upsertMessage(envelope());

    expect(await api.draftReply({ key: "msg-1" })).toEqual({
      ok: false,
      error: "llm_not_configured",
    });
  });

  test("uses the cached body without a provider read", async () => {
    let readCalls = 0;
    const { api, messages } = setup({
      providerFor: () =>
        fakeProvider({
          read: async (ref) => {
            readCalls += 1;
            return fakeProvider().read(ref);
          },
        }),
      draftReply: (input) => {
        expect(input.message.text).toBe("cached body");
        return Promise.resolve({
          ok: true as const,
          draft: "sure",
          model: "test-model",
        });
      },
    });
    messages.upsertMessage(envelope());
    messages.saveBody("msg-1", { html: null, text: "cached body" });

    const outcome = await api.draftReply({
      key: "msg-1",
      instructions: "be brief",
    });

    expect(outcome).toEqual({
      ok: true,
      draft: "sure",
      model: "test-model",
    });
    expect(readCalls).toBe(0);
  });

  test("does one live provider read when the body is not cached, and caches it", async () => {
    let readCalls = 0;
    const { api, messages } = setup({
      providerFor: () =>
        fakeProvider({
          read: async (ref) => {
            readCalls += 1;
            return fakeProvider().read(ref);
          },
        }),
    });
    messages.upsertMessage(envelope());
    messages.upsertLocation("msg-1", {
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      providerRef: REF,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    const outcome = await api.draftReply({ key: "msg-1" });

    expect(outcome.ok).toBe(true);
    expect(readCalls).toBe(1);
    expect(messages.getBody("msg-1")?.text).toBe("live body");
  });
});

describe("sendTemplate", () => {
  test("returns not_found for an unknown template id", () => {
    const { api, sendLog } = setup();
    expect(
      api.sendTemplate({
        templateId: "missing",
        to: "jane@example.com",
        templateProps: {},
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(sendLog.listSendLog().data).toHaveLength(0);
  });

  test("inserts an agent send_log row and enqueues a send job", () => {
    const { api, sendLog, jobs } = setup();

    const outcome = api.sendTemplate({
      templateId: TEMPLATE_IDS.fppSender,
      to: "jane@example.com",
      templateProps: { name: "Jane" },
      subject: "Hi Jane",
      replyTo: "owner@example.com",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(sendLog.getSendLog(outcome.sendLogId)).toMatchObject({
      templateId: TEMPLATE_IDS.fppSender,
      recipients: ["jane@example.com"],
      provider: "resend",
      requestedBy: "agent",
    });
    expect(jobs.getJob(outcome.jobId)).toMatchObject({
      kind: "send",
      status: "pending",
    });
  });
});

describe("getJobStatus", () => {
  test("returns not_found for an unknown id and the job otherwise", () => {
    const { api, jobs } = setup();

    expect(api.getJobStatus({ jobId: "missing" })).toEqual({
      ok: false,
      error: "not_found",
    });

    const id = jobs.enqueue({ kind: "classify", payload: { key: "msg-1" } });
    const outcome = api.getJobStatus({ jobId: id });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.job.kind).toBe("classify");
  });
});
