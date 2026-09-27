import { describe, expect, test } from "bun:test";
import type { Email } from "postal-mime";
import { openDatabase } from "../db/client";
import { createEmailsRepo } from "../db/emails";
import { createImapStateRepo } from "../db/imap-state";
import type {
  ImapMailbox,
  ImapMessageInfo,
  ImapPort,
  ImapSession,
} from "../providers/imap/adapter";
import {
  BATCH_BYTES,
  BATCH_MESSAGES,
  MAX_CONSECUTIVE_HOLDS,
  MAX_MESSAGE_BYTES,
  planBatches,
  syncImap,
} from "./imap-sync";

interface FakeMessage {
  uid: number;
  raw: string;
  // Overrides the reported size (to simulate a huge message cheaply).
  size?: number | null;
  internalDate?: Date;
  // Listed, but expunged before it can be fetched.
  gone?: boolean;
  // Still on the server, but a (partial) FETCH does not return it.
  omitted?: boolean;
}

interface FakeMailbox {
  uidValidity: string;
  messages: FakeMessage[];
}

function rfc822({
  messageId,
  subject = "Hello",
  body = "Body text",
}: {
  messageId?: string;
  subject?: string;
  body?: string;
}): string {
  return [
    "From: Ada Lovelace <ada@example.com>",
    "To: hello@example.com",
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "Date: Tue, 15 Sep 2026 07:15:57 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}

// In-memory IMAP server. It only implements the read-only port, and records
// every request so tests can assert what was (not) asked for.
function createFakeImap(mailboxes: Record<string, FakeMailbox>) {
  const calls = {
    closes: 0,
    releases: 0,
    sourceFetches: [] as number[][],
    headerFetches: [] as number[],
  };
  const failures = { fetchSourcesForUid: null as number | null };
  const encoder = new TextEncoder();

  const port: ImapPort = {
    async connect() {
      const session: ImapSession = {
        async openMailbox(path) {
          const mailbox = mailboxes[path];
          if (!mailbox) throw new Error(`no such mailbox: ${path}`);

          const find = (uid: number) =>
            mailbox.messages.find((message) => message.uid === uid);

          const handle: ImapMailbox = {
            uidValidity: mailbox.uidValidity,
            async listAfter(afterUid, limit) {
              const after = mailbox.messages
                .filter((message) => message.uid > afterUid)
                .sort((a, b) => a.uid - b.uid);
              return {
                messages: after
                  .slice(0, limit)
                  .map((message): ImapMessageInfo => ({
                    uid: message.uid,
                    size:
                      message.size === undefined
                        ? encoder.encode(message.raw).length
                        : message.size,
                    internalDate: message.internalDate ?? null,
                  })),
                truncated: after.length > limit,
              };
            },
            async fetchSources(uids) {
              calls.sourceFetches.push(uids);
              if (
                failures.fetchSourcesForUid !== null &&
                uids.includes(failures.fetchSourcesForUid)
              ) {
                throw new Error("connection reset");
              }
              const sources = new Map<number, Uint8Array>();
              for (const uid of uids) {
                const message = find(uid);
                if (message && !message.gone && !message.omitted) {
                  sources.set(uid, encoder.encode(message.raw));
                }
              }
              return sources;
            },
            async fetchHeaders(uid) {
              calls.headerFetches.push(uid);
              const message = find(uid);
              if (!message || message.gone || message.omitted) return null;
              return encoder.encode(message.raw.split("\r\n\r\n")[0]!);
            },
            async existingUids(uids) {
              return new Set(
                uids.filter((uid) => {
                  const message = find(uid);
                  return message && !message.gone;
                }),
              );
            },
            release: () => {
              calls.releases++;
            },
          };
          return handle;
        },
        async close() {
          calls.closes++;
        },
      };
      return session;
    },
  };

  return { port, calls, failures, mailboxes };
}

function setup(mailboxes: Record<string, FakeMailbox>) {
  const db = openDatabase(":memory:");
  const fake = createFakeImap(mailboxes);
  const emails = createEmailsRepo(db);
  const state = createImapStateRepo(db);
  const run = (
    options: {
      paths?: string[];
      parse?: (raw: Uint8Array) => Promise<Email>;
    } = {},
  ) =>
    syncImap({
      db,
      port: fake.port,
      mailboxes: options.paths ?? Object.keys(mailboxes),
      parse: options.parse,
    });
  return { db, fake, emails, state, run };
}

function info(uid: number, size: number | null): ImapMessageInfo {
  return { uid, size, internalDate: null };
}

describe("planBatches", () => {
  test("splits at the message-count boundary", () => {
    const exact = Array.from({ length: BATCH_MESSAGES }, (_, i) => info(i, 10));
    expect(planBatches(exact).map((b) => b.length)).toEqual([BATCH_MESSAGES]);

    const over = [...exact, info(999, 10)];
    expect(planBatches(over).map((b) => b.length)).toEqual([BATCH_MESSAGES, 1]);
  });

  test("splits at the byte boundary", () => {
    const half = BATCH_BYTES / 2;
    // MAX_MESSAGE_BYTES < half, so all of these are regular messages.
    expect(half).toBeGreaterThan(MAX_MESSAGE_BYTES - 1);
    const fits = [info(1, half), info(2, half)];
    expect(planBatches(fits).map((b) => b.length)).toEqual([2]);

    const overflows = [info(1, half), info(2, half), info(3, 1)];
    expect(planBatches(overflows).map((b) => b.length)).toEqual([2, 1]);
  });

  test("an oversized or size-less message is always its own batch", () => {
    const batches = planBatches([
      info(1, 10),
      info(2, MAX_MESSAGE_BYTES + 1),
      info(3, 10),
      info(4, null),
      info(5, 10),
    ]);
    expect(batches.map((b) => b.map((m) => m.uid))).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
    ]);
  });

  test("a message of exactly the limit is not oversized", () => {
    expect(planBatches([info(1, MAX_MESSAGE_BYTES)])).toHaveLength(1);
  });
});

describe("syncImap", () => {
  test("stores messages as inbound imap rows and advances the cursor", async () => {
    const { emails, state, run } = setup({
      INBOX: {
        uidValidity: "7",
        messages: [
          {
            uid: 3,
            raw: rfc822({ messageId: "<a@x>", subject: "First" }),
            internalDate: new Date("2026-09-15T07:16:00.000Z"),
          },
          { uid: 9, raw: rfc822({ messageId: "<b@x>", subject: "Second" }) },
        ],
      },
    });

    const { summary, errors } = await run();

    expect(errors).toEqual([]);
    expect(summary).toEqual({ new: 2 });
    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "7", lastUid: 9 });

    const { data } = emails.listEmails({ provider: "imap" });
    expect(data).toHaveLength(2);
    const first = data.find((email) => email.subject === "First")!;
    expect(first).toMatchObject({
      direction: "inbound",
      provider: "imap",
      mailbox: "INBOX",
      messageId: "<a@x>",
      fromAddress: "Ada Lovelace <ada@example.com>",
      toAddresses: ["hello@example.com"],
      createdAt: "2026-09-15T07:16:00.000Z",
    });
    expect(first.enrichment.status).toBe("pending");
    expect(emails.listEmails({ q: "Second" }).data).toHaveLength(1);
  });

  test("is incremental: a second run only fetches new uids", async () => {
    const { fake, run } = setup({
      INBOX: {
        uidValidity: "7",
        messages: [{ uid: 1, raw: rfc822({ messageId: "<a@x>" }) }],
      },
    });
    await run();
    fake.mailboxes.INBOX!.messages.push({
      uid: 2,
      raw: rfc822({ messageId: "<b@x>" }),
    });

    const { summary } = await run();

    expect(summary).toEqual({ new: 1 });
    expect(fake.calls.sourceFetches).toEqual([[1], [2]]);
  });

  test("a failed batch leaves the cursor at the last clean batch and retries", async () => {
    const messages: FakeMessage[] = [];
    // 60 small messages -> two batches (50 + 10).
    for (let uid = 1; uid <= 60; uid++) {
      messages.push({ uid, raw: rfc822({ messageId: `<m${uid}@x>` }) });
    }
    const { fake, emails, state, run } = setup({
      INBOX: { uidValidity: "7", messages },
    });
    fake.failures.fetchSourcesForUid = 55;

    const first = await run();

    expect(first.errors).toEqual(["imap INBOX: connection reset"]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(50);
    expect(emails.listEmails({ limit: 100 }).data).toHaveLength(50);

    fake.failures.fetchSourcesForUid = null;
    const second = await run();

    expect(second.errors).toEqual([]);
    expect(second.summary).toEqual({ new: 10 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(60);
  });

  test("processes at most the per-run cap and continues on the next runs", async () => {
    const messages: FakeMessage[] = [];
    for (let uid = 1; uid <= 1200; uid++) {
      messages.push({ uid, raw: rfc822({ messageId: `<m${uid}@x>` }) });
    }
    const { emails, state, run } = setup({
      INBOX: { uidValidity: "1", messages },
    });

    expect((await run()).summary).toEqual({ new: 500 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(500);
    expect((await run()).summary).toEqual({ new: 500 });
    expect((await run()).summary).toEqual({ new: 200 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(1200);
    expect((await run()).summary).toEqual({ new: 0 });
    expect(
      emails.listEmails({ provider: "imap", limit: 100 }).data,
    ).toHaveLength(100);
  });

  test("UIDVALIDITY change rescans without duplicating rows, with or without Message-ID", async () => {
    const stamp = new Date("2026-09-15T07:00:00.000Z");
    const noId = rfc822({ subject: "No id", body: "unique body" });
    const { fake, emails, state, run } = setup({
      INBOX: {
        uidValidity: "7",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<a@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<b@x>" }) },
          { uid: 3, raw: noId, internalDate: stamp },
        ],
      },
    });
    await run();

    // Server renumbered everything and added one message.
    fake.mailboxes.INBOX = {
      uidValidity: "8",
      messages: [
        { uid: 11, raw: noId, internalDate: stamp },
        { uid: 12, raw: rfc822({ messageId: "<b@x>" }) },
        { uid: 13, raw: rfc822({ messageId: "<a@x>" }) },
        { uid: 14, raw: rfc822({ messageId: "<c@x>" }) },
      ],
    };
    const { summary } = await run();

    expect(summary).toEqual({ new: 1 });
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(4);
    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "8", lastUid: 14 });
  });

  test("the same Message-ID in two mailboxes is two rows", async () => {
    const raw = rfc822({ messageId: "<dup@x>" });
    const { emails, run } = setup({
      INBOX: { uidValidity: "1", messages: [{ uid: 1, raw }] },
      Spam: { uidValidity: "1", messages: [{ uid: 1, raw }] },
    });

    await run();

    const rows = emails.listEmails({ provider: "imap" }).data;
    expect(rows.map((row) => row.mailbox).sort()).toEqual(["INBOX", "Spam"]);
    expect(emails.listEmails({ mailbox: "spam" }).data).toHaveLength(1);
  });

  test("a colliding Message-ID can never overwrite a stored row", async () => {
    const { fake, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          {
            uid: 1,
            raw: rfc822({
              messageId: "<same@x>",
              subject: "Genuine",
              body: "real",
            }),
          },
        ],
      },
    });
    await run();
    fake.mailboxes.INBOX!.messages.push({
      uid: 2,
      raw: rfc822({ messageId: "<same@x>", subject: "Forged", body: "evil" }),
    });

    const { summary } = await run();

    expect(summary).toEqual({ new: 0 });
    const rows = emails.listEmails({ provider: "imap" }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "Genuine", snippet: "real" });
  });

  test("oversized messages are stored headers-only and never fully fetched", async () => {
    const { fake, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          {
            uid: 1,
            raw: rfc822({ messageId: "<big@x>", subject: "Huge" }),
            size: MAX_MESSAGE_BYTES + 1,
          },
          { uid: 2, raw: rfc822({ messageId: "<small@x>" }) },
        ],
      },
    });

    await run();

    expect(fake.calls.headerFetches).toEqual([1]);
    expect(fake.calls.sourceFetches).toEqual([[2]]);
    const [big] = emails.listEmails({ q: "Huge" }).data;
    expect(big?.snippet).toContain("Body not stored");
    expect(big?.attachments).toEqual([]);
  });

  test("a message without a reported size is treated as oversized", async () => {
    const { fake, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [{ uid: 1, raw: rfc822({ messageId: "<n@x>" }), size: null }],
      },
    });

    await run();

    expect(fake.calls.sourceFetches).toEqual([]);
    expect(fake.calls.headerFetches).toEqual([1]);
  });

  test("oversized with unavailable headers: metadata-only row if present, skipped if gone", async () => {
    const { emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          {
            uid: 1,
            raw: rfc822({ subject: "still here" }),
            size: MAX_MESSAGE_BYTES + 1,
            omitted: true,
            internalDate: new Date("2026-09-15T07:00:00.000Z"),
          },
          {
            uid: 2,
            raw: rfc822({ subject: "vanished" }),
            size: MAX_MESSAGE_BYTES + 1,
            gone: true,
          },
        ],
      },
    });

    const { errors } = await run();

    expect(errors).toEqual([
      "imap INBOX: uid 1 headers unavailable, stored metadata only",
      "imap INBOX: uid 2 expunged before fetch, skipped",
    ]);
    const rows = emails.listEmails({ provider: "imap" }).data;
    expect(rows.map((row) => row.subject)).toEqual(["(headers unavailable)"]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
  });

  test("a uid the server omits but still has holds the cursor and is retried", async () => {
    const { fake, emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<1@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<2@x>" }), omitted: true },
          { uid: 3, raw: rfc822({ messageId: "<3@x>" }) },
        ],
      },
    });

    const first = await run();

    expect(first.errors).toEqual([
      "imap INBOX: uid 2 exists but returned no source; cursor held at 1, retrying next run",
    ]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(1);
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(1);

    fake.mailboxes.INBOX!.messages[1]!.omitted = false;
    const second = await run();

    expect(second.errors).toEqual([]);
    expect(second.summary).toEqual({ new: 2 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(3);
  });

  test("a uid confirmed gone is skipped, logged, and the cursor moves on", async () => {
    const { state, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<1@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<2@x>" }), gone: true },
          { uid: 3, raw: rfc822({ messageId: "<3@x>" }) },
        ],
      },
    });

    const { errors, summary } = await run();

    expect(errors).toEqual([
      "imap INBOX: uid 2 expunged before fetch, skipped",
    ]);
    expect(summary).toEqual({ new: 2 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(3);
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(2);
  });

  test("attachments are stored as metadata only", async () => {
    const raw = [
      "From: a@example.com",
      "To: hello@example.com",
      "Subject: With file",
      "Message-ID: <att@x>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached",
      "--b",
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "SGVsbG8=",
      "--b--",
      "",
    ].join("\r\n");
    const { emails, run } = setup({
      INBOX: { uidValidity: "1", messages: [{ uid: 1, raw }] },
    });

    await run();

    const [email] = emails.listEmails({ provider: "imap" }).data;
    expect(email?.attachments).toEqual([
      { filename: "doc.pdf", contentType: "application/pdf", size: 5 },
    ]);
  });

  test("a missing mailbox is reported and the others still sync", async () => {
    const { fake, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [{ uid: 1, raw: rfc822({ messageId: "<a@x>" }) }],
      },
    });

    const { summary, errors } = await run({ paths: ["Spam", "INBOX"] });

    expect(errors).toEqual(["imap Spam: no such mailbox: Spam"]);
    expect(summary).toEqual({ new: 1 });
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(1);
    expect(fake.calls.releases).toBe(1);
    expect(fake.calls.closes).toBe(1);
  });

  test("a connection failure is returned, not thrown, and recorded per mailbox", async () => {
    const db = openDatabase(":memory:");
    const port: ImapPort = {
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    };

    const { summary, errors } = await syncImap({
      db,
      port,
      mailboxes: ["INBOX", "Spam"],
    });

    expect(summary).toEqual({ new: 0 });
    expect(errors).toEqual(["imap connect: ECONNREFUSED"]);
    expect(
      createImapStateRepo(db)
        .listHealth()
        .map((h) => [h.mailbox, h.lastError, h.lastSuccessAt]),
    ).toEqual([
      ["INBOX", "connect: ECONNREFUSED", null],
      ["Spam", "connect: ECONNREFUSED", null],
    ]);
  });

  test("health records success and clears the error on recovery", async () => {
    const { fake, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [{ uid: 1, raw: rfc822({ messageId: "<a@x>" }) }],
      },
    });
    fake.failures.fetchSourcesForUid = 1;

    await run();
    const [failed] = state.listHealth();
    expect(failed).toMatchObject({
      mailbox: "INBOX",
      lastError: "connection reset",
      lastSuccessAt: null,
    });
    expect(failed?.lastErrorAt).not.toBeNull();

    fake.failures.fetchSourcesForUid = null;
    await run();
    const [healed] = state.listHealth();
    expect(healed).toMatchObject({
      lastError: null,
      lastErrorAt: null,
      lastUid: 1,
    });
    expect(healed?.lastSuccessAt).not.toBeNull();
  });

  test("a parse failure stores a metadata-only row and never wedges the cursor", async () => {
    const { state, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ subject: "poison" }) },
          { uid: 2, raw: rfc822({ messageId: "<ok@x>", subject: "fine" }) },
        ],
      },
    });
    let calls = 0;
    const parse = async (): Promise<Email> => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return {
        subject: "fine",
        messageId: "<ok@x>",
        attachments: [],
      } as unknown as Email;
    };

    const { errors } = await run({ parse });

    expect(errors).toEqual([
      "imap INBOX: uid 1 unparseable (boom), stored metadata only",
    ]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
    expect(
      emails
        .listEmails({ provider: "imap" })
        .data.map((row) => row.subject)
        .sort(),
    ).toEqual(["(unparseable message)", "fine"]);
  });

  test("a unparseable-message row id ignores the uid", async () => {
    const stamp = new Date("2026-09-15T07:00:00.000Z");
    const raw = rfc822({ subject: "poison" });
    const failing = async (): Promise<Email> => {
      throw new Error("boom");
    };
    const { fake, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [{ uid: 1, raw, internalDate: stamp }],
      },
    });
    await run({ parse: failing });

    fake.mailboxes.INBOX = {
      uidValidity: "2",
      messages: [{ uid: 40, raw, internalDate: stamp }],
    };
    await run({ parse: failing });

    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(1);
  });

  test("a store failure falls back to a metadata-only row and keeps the batch", async () => {
    const { state, emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ subject: "bad" }) },
          { uid: 2, raw: rfc822({ messageId: "<ok@x>", subject: "good" }) },
        ],
      },
    });
    let calls = 0;
    const parse = async (): Promise<Email> => {
      calls++;
      // An object html value can't be bound by SQLite, so the upsert throws.
      return {
        subject: calls === 1 ? "bad" : "good",
        messageId: `<m${calls}@x>`,
        html: calls === 1 ? {} : "<p>ok</p>",
        attachments: [],
      } as unknown as Email;
    };

    const { errors } = await run({ parse });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("uid store failed");
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
    expect(
      emails
        .listEmails({ provider: "imap" })
        .data.map((row) => row.subject)
        .sort(),
    ).toEqual(["(unparseable message)", "good"]);
  });

  test("an invalid internalDate never breaks the row", async () => {
    const { emails, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          {
            uid: 1,
            raw: rfc822({ messageId: "<d@x>" }),
            internalDate: new Date("not a date"),
          },
        ],
      },
    });

    const { errors } = await run();

    expect(errors).toEqual([]);
    const [row] = emails.listEmails({ provider: "imap" }).data;
    expect(Number.isNaN(new Date(row!.createdAt).getTime())).toBe(false);
  });

  test("records UIDVALIDITY for an empty mailbox", async () => {
    const { state, run } = setup({ INBOX: { uidValidity: "5", messages: [] } });

    await run();

    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "5", lastUid: 0 });
  });
});

describe("syncImap identity, holds and health", () => {
  test("messages with neither Message-ID nor a content hash never share a row", async () => {
    // Identical size/date, headers unavailable: only the uid tells them apart.
    const twin = (uid: number): FakeMessage => ({
      uid,
      raw: rfc822({}),
      size: MAX_MESSAGE_BYTES + 1,
      omitted: true,
      internalDate: new Date("2026-09-15T07:00:00.000Z"),
    });
    const { emails, run } = setup({
      INBOX: { uidValidity: "1", messages: [twin(1), twin(2)] },
    });

    await run();

    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(2);
  });

  test("a stand-in for a message with a known Message-ID uses the normal id", async () => {
    const message = { uid: 1, raw: rfc822({ messageId: "<same@x>" }) };
    const parseOk = async () =>
      ({
        messageId: "<same@x>",
        subject: "s",
        attachments: [],
      }) as unknown as Email;
    const parseBadHtml = async () =>
      ({
        messageId: "<same@x>",
        subject: "s",
        html: {},
        attachments: [],
      }) as unknown as Email;

    const normal = setup({ INBOX: { uidValidity: "1", messages: [message] } });
    await normal.run({ parse: parseOk });
    const degraded = setup({
      INBOX: { uidValidity: "1", messages: [message] },
    });
    const { summary } = await degraded.run({ parse: parseBadHtml });

    const [normalRow] = normal.emails.listEmails({ provider: "imap" }).data;
    const [standIn] = degraded.emails.listEmails({ provider: "imap" }).data;
    expect(standIn?.id).toBe(normalRow?.id);
    expect(standIn?.messageId).toBe("<same@x>");
    expect(standIn?.subject).toBe("(unparseable message)");
    // Input and stand-in share an id: one new row, not two.
    expect(summary).toEqual({ new: 1 });
  });

  test("a uid held for 12 consecutive runs is replaced by a stand-in and the mailbox moves on", async () => {
    const { fake, emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<1@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<2@x>" }), omitted: true },
          { uid: 3, raw: rfc822({ messageId: "<3@x>" }) },
        ],
      },
    });

    for (let attempt = 1; attempt < MAX_CONSECUTIVE_HOLDS; attempt++) {
      const { errors } = await run();
      expect(errors).toHaveLength(1);
      expect(state.getCursor("INBOX")?.lastUid).toBe(1);
    }

    const twelfth = await run();

    expect(twelfth.errors).toEqual([
      `imap INBOX: uid 2 returned no source in ${MAX_CONSECUTIVE_HOLDS} consecutive runs, stored a metadata-only stand-in and moved on`,
    ]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
    const [health] = state.listHealth();
    expect(health?.lastError).toBeNull();
    expect(health?.lastWarning).toContain("consecutive runs");
    expect(
      emails.listEmails({ provider: "imap" }).data.map((row) => row.subject),
    ).toContain("(message unavailable)");

    // The next run continues past it; a clean run clears the warning.
    const next = await run();
    expect(next.summary).toEqual({ new: 1 });
    expect(state.getCursor("INBOX")?.lastUid).toBe(3);
    expect(state.listHealth()[0]?.lastWarning).toBeNull();
    expect(fake.mailboxes.INBOX?.messages).toHaveLength(3);
  });

  test("the hold counter restarts when the held uid changes or resolves", async () => {
    const { fake, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<1@x>" }), omitted: true },
          { uid: 2, raw: rfc822({ messageId: "<2@x>" }) },
        ],
      },
    });
    for (let i = 0; i < 5; i++) await run();
    const messages = fake.mailboxes.INBOX!.messages;

    // uid 1 recovers -> run is clean -> counter cleared.
    messages[0]!.omitted = false;
    await run();
    // A later, different uid held: counts from 1, so it is still held.
    messages.push({
      uid: 3,
      raw: rfc822({ messageId: "<3@x>" }),
      omitted: true,
    });
    for (let i = 0; i < MAX_CONSECUTIVE_HOLDS - 1; i++) {
      const { errors } = await run();
      expect(errors[0]).toContain("exists but returned no source");
    }
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
  });

  test("a Message-ID reused with different content is logged, kept out and flagged", async () => {
    const { fake, emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<same@x>", body: "real" }) },
        ],
      },
    });
    await run();
    fake.mailboxes.INBOX?.messages.push({
      uid: 2,
      raw: rfc822({ messageId: "<same@x>", body: "forged" }),
    });

    const { errors } = await run();

    expect(errors).toEqual([
      "imap INBOX: <same@x> reused with different content, kept the stored row",
    ]);
    expect(emails.listEmails({ provider: "imap" }).data[0]?.snippet).toBe(
      "real",
    );
    expect(state.listHealth()[0]?.lastWarning).toContain("reused");
  });

  test("re-syncing identical content after a UIDVALIDITY reset raises no warning", async () => {
    const raw = rfc822({ messageId: "<a@x>" });
    const { fake, run } = setup({
      INBOX: { uidValidity: "1", messages: [{ uid: 1, raw }] },
    });
    await run();
    fake.mailboxes.INBOX = { uidValidity: "2", messages: [{ uid: 9, raw }] };

    const { errors } = await run();

    expect(errors).toEqual([]);
  });

  test("per-message degradations become a health warning that only a clean run clears", async () => {
    const { fake, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [{ uid: 1, raw: rfc822({ subject: "poison" }) }],
      },
    });
    const failing = async (): Promise<Email> => {
      throw new Error("boom");
    };

    await run({ parse: failing });
    const [warned] = state.listHealth();
    expect(warned?.lastError).toBeNull();
    expect(warned?.lastSuccessAt).not.toBeNull();
    expect(warned?.lastWarning).toContain("uid 1 unparseable");
    expect(warned?.lastWarningAt).not.toBeNull();

    fake.mailboxes.INBOX?.messages.push({
      uid: 2,
      raw: rfc822({ messageId: "<ok@x>" }),
    });
    await run();
    expect(state.listHealth()[0]?.lastWarning).toBeNull();
  });

  test("a hold right after a UIDVALIDITY change never leaves a half-saved cursor", async () => {
    const { fake, state, run } = setup({
      INBOX: {
        uidValidity: "7",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<a@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<b@x>" }) },
          { uid: 3, raw: rfc822({ messageId: "<c@x>" }) },
          { uid: 4, raw: rfc822({ messageId: "<d@x>" }) },
          { uid: 5, raw: rfc822({ messageId: "<e@x>" }) },
        ],
      },
    });
    await run();
    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "7", lastUid: 5 });

    // Renumbered; the very first uid is held: nothing may be persisted, so
    // the old (validity 7, uid 5) cursor stays intact and consistent.
    fake.mailboxes.INBOX = {
      uidValidity: "8",
      messages: [
        { uid: 1, raw: rfc822({ messageId: "<a@x>" }), omitted: true },
        { uid: 2, raw: rfc822({ messageId: "<b@x>" }) },
      ],
    };
    await run();
    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "7", lastUid: 5 });

    // Held mid-batch: uid 1 is stored and validity + uid are saved together.
    fake.mailboxes.INBOX = {
      uidValidity: "8",
      messages: [
        { uid: 1, raw: rfc822({ messageId: "<a@x>" }) },
        { uid: 2, raw: rfc822({ messageId: "<b@x>" }), omitted: true },
        { uid: 3, raw: rfc822({ messageId: "<c@x>" }) },
      ],
    };
    await run();
    expect(state.getCursor("INBOX")).toEqual({ uidValidity: "8", lastUid: 1 });
  });

  test("a batch mixing a gone uid and a held uid skips the first, holds at the second", async () => {
    const { emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<1@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<2@x>" }), gone: true },
          { uid: 3, raw: rfc822({ messageId: "<3@x>" }), omitted: true },
          { uid: 4, raw: rfc822({ messageId: "<4@x>" }) },
        ],
      },
    });

    const { errors } = await run();

    expect(errors).toEqual([
      "imap INBOX: uid 2 expunged before fetch, skipped",
      "imap INBOX: uid 3 exists but returned no source; cursor held at 2, retrying next run",
    ]);
    expect(state.getCursor("INBOX")?.lastUid).toBe(2);
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(1);
  });

  test("if even the stand-in can't be stored the whole batch rolls back and the cursor holds", async () => {
    const { db, emails, state, run } = setup({
      INBOX: {
        uidValidity: "1",
        messages: [
          { uid: 1, raw: rfc822({ messageId: "<good@x>" }) },
          { uid: 2, raw: rfc822({ messageId: "<bad@x>" }) },
        ],
      },
    });
    db.run(
      `CREATE TRIGGER refuse_standin BEFORE INSERT ON emails
       WHEN NEW.subject = '(unparseable message)'
       BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`,
    );
    const parse = async (): Promise<Email> => {
      // First call is the good message; the second breaks the upsert.
      parse.calls++;
      return {
        messageId: parse.calls === 1 ? "<good@x>" : "<bad@x>",
        subject: "s",
        html: parse.calls === 1 ? "<p>ok</p>" : ({} as unknown as string),
        attachments: [],
      } as unknown as Email;
    };
    parse.calls = 0;

    const { errors } = await run({ parse });

    expect(errors.at(-1)).toContain("disk on fire");
    expect(state.getCursor("INBOX")).toBeNull();
    expect(emails.listEmails({ provider: "imap" }).data).toHaveLength(0);
    expect(state.listHealth()[0]?.lastError).toContain("disk on fire");
  });
});
