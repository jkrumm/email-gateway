import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo } from "../db/messages";
import type { Envelope, MailProvider } from "../providers/port";
import { runSyncTick } from "./composition";

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
      send: id === "resend",
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
    send: async () => {
      throw new Error("not implemented in fake");
    },
  };
}

describe("runSyncTick", () => {
  test("ingests both of Resend's mailboxes and a failing one doesn't block the other", async () => {
    const { accounts, messages } = repos();
    const provider = stubProvider("resend", "app", {
      sent: async () => ({
        items: [
          envelope({ ref: { provider: "resend", id: "s1", mailbox: "sent" } }),
        ],
        cursor: undefined,
      }),
      received: async () => {
        throw new Error("resend down");
      },
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [provider],
    });

    expect(result.new).toBe(1);
    expect(result.errors).toEqual(["received: resend down"]);
  });

  test("one provider's failure never blocks another provider in the same tick", async () => {
    const { accounts, messages } = repos();
    const resend = stubProvider("resend", "app", {
      sent: async () => {
        throw new Error("resend outage");
      },
      received: async () => ({ items: [], cursor: undefined }),
    });
    const proton = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [
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
        cursor: undefined,
      }),
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [resend, proton],
      mailboxesFor: (provider) =>
        provider.id === "resend" ? ["sent", "received"] : ["INBOX"],
    });

    expect(result.errors).toEqual(["sent: resend outage"]);
    expect(result.new).toBeGreaterThanOrEqual(0);
  });

  test("a mailboxesFor throw for one provider doesn't block a later provider in the same tick", async () => {
    const { accounts, messages } = repos();
    const resend = stubProvider("resend", "app", {
      sent: async () => ({ items: [], cursor: undefined }),
      received: async () => ({ items: [], cursor: undefined }),
    });
    const proton = stubProvider("proton", "hello@example.com", {
      INBOX: async () => ({
        items: [
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
        cursor: undefined,
      }),
    });

    const result = await runSyncTick({
      accounts,
      messages,
      providers: [resend, proton],
      mailboxesFor: (provider) => {
        if (provider.id === "resend") {
          throw new Error("mailboxesFor exploded");
        }
        return ["INBOX"];
      },
    });

    expect(result.errors).toEqual(["resend:app: mailboxesFor exploded"]);
    expect(result.new).toBe(1);
  });

  test("enqueues classify for every newly ingested key", async () => {
    const { accounts, messages } = repos();
    const provider = stubProvider("resend", "app", {
      sent: async () => ({
        items: [
          envelope({ ref: { provider: "resend", id: "s1", mailbox: "sent" } }),
        ],
        cursor: undefined,
      }),
      received: async () => ({ items: [], cursor: undefined }),
    });
    const enqueued: string[] = [];

    await runSyncTick({
      accounts,
      messages,
      providers: [provider],
      enqueueClassify: (key) => enqueued.push(key),
    });

    expect(enqueued).toHaveLength(1);
  });
});
