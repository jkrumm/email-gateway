import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo } from "../db/messages";
import { createFakeMailProvider } from "../test/fake-provider";
import type { ImapConfig } from "../providers/imap/adapter";
import type { Envelope, MailProvider } from "../providers/port";
import { defaultMailboxesFor, runSyncTick } from "./composition";

function repos() {
  const db = openMailDatabase(":memory:");
  return { accounts: createAccountsRepo(db), messages: createMessagesRepo(db) };
}

function envelope(
  overrides: Partial<Envelope> & { ref: Envelope["ref"] },
): Envelope {
  return {
    from: "sender@example.com",
    to: ["hello@example.com"],
    subject: "Subject",
    date: "2026-01-01T00:00:00.000Z",
    size: 100,
    hasAttachments: false,
    flags: [],
    ...overrides,
  };
}

function stubProvider(
  id: MailProvider["id"],
  account: string,
  listByMailbox: Record<
    string,
    () => Promise<{ items: Envelope[]; cursor: string | undefined }>
  >,
): MailProvider {
  return {
    id,
    account,
    capabilities: async () => ({
      list: true,
      read: true,
      search: false,
      flag: false,
      move: false,
      idle: false,
    }),
    listMailboxes: async () => [],
    list: async (mailbox) => {
      const fn = listByMailbox[mailbox];
      if (!fn) return { items: [], cursor: undefined };
      return fn();
    },
    read: async () => {
      throw new Error("not implemented in fake");
    },
    search: async () => [],
    setFlags: async () => {},
    move: async (ref) => ref,
  };
}

function protonRef(mailbox: string, uid: number): Envelope["ref"] {
  return {
    provider: "proton",
    account: "hello@example.com",
    mailbox,
    uidValidity: "1",
    uid,
  };
}

describe("runSyncTick", () => {
  test("ingests every mailbox and a failing one doesn't block the other", async () => {
    const { accounts, messages } = repos();
    const provider = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [envelope({ ref: protonRef("INBOX", 1) })],
        cursor: undefined,
      }),
      Spam: async () => {
        throw new Error("bridge down");
      },
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [provider],
      mailboxesFor: () => ["Spam", "INBOX"],
    });

    expect(result.new).toBe(1);
    expect(result.errors).toEqual(["Spam: bridge down"]);
  });

  test("one provider's failure never blocks another provider in the same tick", async () => {
    const { accounts, messages } = repos();
    const gmail = stubProvider("gmail", "me@gmail.com", {
      INBOX: async () => {
        throw new Error("gmail outage");
      },
    });
    const proton = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [envelope({ ref: protonRef("INBOX", 1) })],
        cursor: undefined,
      }),
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [gmail, proton],
      mailboxesFor: () => ["INBOX"],
    });

    expect(result.errors).toEqual(["INBOX: gmail outage"]);
    expect(result.new).toBe(1);
  });

  test("a mailboxesFor throw for one provider doesn't block a later provider in the same tick", async () => {
    const { accounts, messages } = repos();
    const gmail = stubProvider("gmail", "me@gmail.com", {});
    const proton = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [envelope({ ref: protonRef("INBOX", 1) })],
        cursor: undefined,
      }),
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [gmail, proton],
      mailboxesFor: (provider) => {
        if (provider.id === "gmail") {
          throw new Error("mailboxesFor exploded");
        }
        return ["INBOX"];
      },
    });

    expect(result.errors).toEqual([
      "gmail:me@gmail.com: mailboxesFor exploded",
    ]);
    expect(result.new).toBe(1);
  });

  test("enqueues classify for every newly ingested key", async () => {
    const { accounts, messages } = repos();
    const provider = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [envelope({ ref: protonRef("INBOX", 1) })],
        cursor: undefined,
      }),
    });
    const enqueued: string[] = [];

    await runSyncTick({
      accounts,
      messages,
      providers: [provider],
      mailboxesFor: () => ["INBOX"],
      enqueueClassify: (key) => enqueued.push(key),
    });

    expect(enqueued).toHaveLength(1);
  });

  test("defaultMailboxesFor gives each provider its own configured mailbox list", () => {
    const proton = stubProvider("proton", "hello@example.com", {});
    const gmail = stubProvider("gmail", "me@gmail.com", {});
    const protonConfig = imapConfig(["INBOX", "Spam"]);
    const gmailConfig = imapConfig(["INBOX", "[Gmail]/All Mail"]);

    expect(
      defaultMailboxesFor(proton, { proton: protonConfig, gmail: gmailConfig }),
    ).toEqual(["INBOX", "Spam"]);
    expect(
      defaultMailboxesFor(gmail, { proton: protonConfig, gmail: gmailConfig }),
    ).toEqual(["INBOX", "[Gmail]/All Mail"]);
    // An unconfigured account has no mailboxes to ingest.
    expect(defaultMailboxesFor(proton, {})).toEqual([]);
    expect(defaultMailboxesFor(gmail, {})).toEqual([]);
    // An unknown provider id fails closed rather than borrowing Gmail's list.
    const unknown = { ...gmail, id: "other" } as unknown as MailProvider;
    expect(
      defaultMailboxesFor(unknown, {
        proton: protonConfig,
        gmail: gmailConfig,
      }),
    ).toEqual([]);
  });

  test("ingests Proton and Gmail into their own accounts, each from its own mailboxes", async () => {
    const { accounts, messages } = repos();
    const proton = createFakeMailProvider({
      id: "proton",
      account: "hello@example.com",
      pages: {
        INBOX: [
          [
            envelope({
              ref: {
                provider: "proton",
                account: "hello@example.com",
                mailbox: "INBOX",
                uidValidity: "1",
                uid: 1,
              },
            }),
          ],
        ],
      },
    });
    const gmail = createFakeMailProvider({
      id: "gmail",
      account: "me@gmail.com",
      mailboxes: [
        { path: "INBOX", name: "INBOX" },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
      ],
      pages: {
        INBOX: [
          [
            envelope({
              threadKey: "1278455344230334865",
              ref: {
                provider: "gmail",
                account: "me@gmail.com",
                mailbox: "INBOX",
                uidValidity: "2",
                uid: 1,
              },
            }),
          ],
        ],
        // Explicitly configured, so it is ingested too — proves the Gmail
        // mailbox list is applied to the Gmail provider only.
        "[Gmail]/All Mail": [
          [
            envelope({
              ref: {
                provider: "gmail",
                account: "me@gmail.com",
                mailbox: "[Gmail]/All Mail",
                uidValidity: "2",
                uid: 9,
              },
            }),
          ],
        ],
      },
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [proton, gmail],
      mailboxesFor: (provider) =>
        defaultMailboxesFor(provider, {
          proton: imapConfig(["INBOX"]),
          gmail: imapConfig(["INBOX", "[Gmail]/All Mail"]),
        }),
    });

    expect(result.new).toBe(3);
    expect(
      accounts
        .listAccounts()
        .map((account) => account.id)
        .sort(),
    ).toEqual(["gmail:me@gmail.com", "proton:hello@example.com"]);
    const gmailRows = messages.listMessages({
      accountIds: ["gmail:me@gmail.com"],
    }).rows;
    expect(gmailRows.map((row) => row.threadKey)).toContain(
      "1278455344230334865",
    );
    // The Gmail provider's special-use folder is surfaced by listMailboxes().
    expect(
      (await gmail.listMailboxes()).find(
        (mailbox) => mailbox.path === "[Gmail]/All Mail",
      )?.specialUse,
    ).toBe("\\All");
  });
});

function imapConfig(mailboxes: string[]): ImapConfig {
  return {
    host: "h",
    port: 993,
    user: "u",
    password: "p",
    mailboxes,
    tls: "implicit",
    tlsInsecure: false,
  };
}
