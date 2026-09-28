import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo } from "../db/messages";
import type {
  Envelope,
  MailProvider,
  Page,
  ProviderId,
} from "../providers/port";
import { ingestMailbox } from "./ingest";

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

function imapRef(uid: number, mailbox = "INBOX") {
  return {
    provider: "proton" as const,
    account: "hello@example.com",
    mailbox,
    uidValidity: "1",
    uid,
  };
}

// A cursor-paginated fake: page index is the cursor itself, so resuming a
// second ingestMailbox call against the same provider genuinely continues
// from where the first left off. `pages` is captured by reference (not
// cloned), so tests can mutate a mailbox's page arrays in place between
// ingestMailbox calls to simulate new mail arriving.
function fakeProvider({
  id = "proton" as ProviderId,
  account = "hello@example.com",
  pages,
  onList,
}: {
  id?: ProviderId;
  account?: string;
  pages: Record<string, Page<Envelope>["items"][]>;
  onList?: (mailbox: string, cursor: string | undefined) => void;
}): MailProvider {
  return {
    id,
    account,
    async capabilities() {
      return {
        list: true,
        read: true,
        search: false,
        flag: false,
        move: false,
        send: false,
        idle: false,
      };
    },
    async listMailboxes() {
      return [];
    },
    async list(mailbox, cursor) {
      onList?.(mailbox, cursor);
      const mailboxPages = pages[mailbox] ?? [];
      const index = cursor ? Number(cursor) : 0;
      const items = mailboxPages[index] ?? [];
      const hasMore = index + 1 < mailboxPages.length;
      return { items, cursor: hasMore ? String(index + 1) : undefined };
    },
    async read() {
      throw new Error("not implemented in fake");
    },
    async search() {
      return [];
    },
    async setFlags() {},
    async move(ref) {
      return ref;
    },
    async send() {
      throw new Error("not implemented in fake");
    },
  };
}

describe("ingestMailbox", () => {
  test("paginates across multiple pages in one run (head pass plus backfill catching up to it)", async () => {
    const { accounts, messages } = repos();
    const provider = fakeProvider({
      pages: {
        INBOX: [
          [envelope({ ref: imapRef(1) }), envelope({ ref: imapRef(2) })],
          [envelope({ ref: imapRef(3) })],
        ],
      },
    });

    const result = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });

    expect(result).toEqual({ new: 3, errors: [] });
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");
  });

  test("persists the backfill cursor and resumes from it on the next call", async () => {
    const { accounts, messages } = repos();
    const listedCursors: (string | undefined)[] = [];
    const provider = fakeProvider({
      pages: {
        INBOX: [
          [envelope({ ref: imapRef(1) })],
          [envelope({ ref: imapRef(2) })],
          [envelope({ ref: imapRef(3) })],
        ],
      },
      onList: (_mailbox, cursor) => listedCursors.push(cursor),
    });

    // Head pass (page 0) + one backfill page (page 1) per tick, since
    // maxPagesPerRun bounds the backfill pass to one page.
    const first = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      maxPagesPerRun: 1,
    });
    expect(first.new).toBe(2);

    const account = accounts.getAccount("proton:hello@example.com");
    expect(account?.cursors["INBOX#backfill"]).toBe("2");

    const second = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      maxPagesPerRun: 1,
    });
    expect(second.new).toBe(1);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");
    expect(listedCursors).toEqual([undefined, "1", undefined, "2"]);
  });

  test("re-listing a known message is not counted as new and does not re-enqueue", async () => {
    const { accounts, messages } = repos();
    const provider = fakeProvider({
      pages: { INBOX: [[envelope({ ref: imapRef(1) })]] },
    });
    const enqueued: string[] = [];

    await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      enqueueClassify: (key) => enqueued.push(key),
    });
    const result = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      enqueueClassify: (key) => enqueued.push(key),
    });

    expect(result.new).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  test("infers outbound for Resend's sent mailbox and inbound otherwise", async () => {
    const { accounts, messages } = repos();
    const resendRef = (id: string) => ({
      provider: "resend" as const,
      id,
      mailbox: "sent",
    });
    const provider = fakeProvider({
      id: "resend",
      account: "resend-domain",
      pages: {
        sent: [[envelope({ ref: resendRef("r1") })]],
        received: [
          [envelope({ ref: { ...resendRef("r2"), mailbox: "received" } })],
        ],
      },
    });

    await ingestMailbox({ provider, mailbox: "sent", accounts, messages });
    await ingestMailbox({ provider, mailbox: "received", accounts, messages });

    const all = messages.listMessages();
    expect(all.rows.map((row) => row.direction).sort()).toEqual([
      "inbound",
      "outbound",
    ]);
  });

  test("a provider failure mid-run is recorded and does not throw, and a later run on the same mailbox still works", async () => {
    const { accounts, messages } = repos();
    let calls = 0;
    const provider: MailProvider = {
      ...fakeProvider({ pages: {} }),
      async list() {
        calls++;
        if (calls === 1) throw new Error("connection reset");
        return { items: [envelope({ ref: imapRef(9) })], cursor: undefined };
      },
    };

    const first = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(first.errors).toEqual(["INBOX: connection reset"]);
    expect(accounts.getAccount("proton:hello@example.com")?.lastError).toBe(
      "connection reset",
    );

    const second = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(second).toEqual({ new: 1, errors: [] });
  });

  test("steady state: new mail at the top is detected by the head pass alone once backfill is done, with zero backfill list() calls", async () => {
    const { accounts, messages } = repos();
    const listCalls: (string | undefined)[] = [];
    const pages: Record<string, Page<Envelope>["items"][]> = {
      INBOX: [
        [envelope({ ref: imapRef(1) }), envelope({ ref: imapRef(2) })],
        [envelope({ ref: imapRef(3) })],
      ],
    };
    const provider = fakeProvider({
      pages,
      onList: (_mailbox, cursor) => listCalls.push(cursor),
    });

    const first = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(first.new).toBe(3);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");

    // New mail arrives at the very top of the mailbox.
    pages.INBOX[0]!.unshift(envelope({ ref: imapRef(99) }));
    listCalls.length = 0;

    const second = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });

    expect(second.new).toBe(1);
    // Only the head pass ran — backfill is "done" and made no provider calls.
    expect(listCalls).toEqual([undefined]);
  });

  test("regression: new top-of-mailbox mail is still detected after several no-op ticks once the mailbox has exceeded one page", async () => {
    const { accounts, messages } = repos();
    const pages: Record<string, Page<Envelope>["items"][]> = {
      INBOX: [
        [envelope({ ref: imapRef(1) }), envelope({ ref: imapRef(2) })],
        [envelope({ ref: imapRef(3) })],
        [envelope({ ref: imapRef(4) })],
      ],
    };
    const provider = fakeProvider({ pages });

    // Several ticks, simulating the 5-minute schedule, with no new mail.
    for (let tick = 0; tick < 3; tick++) {
      await ingestMailbox({ provider, mailbox: "INBOX", accounts, messages });
    }

    // New mail arrives at the top of the mailbox.
    pages.INBOX[0]!.unshift(envelope({ ref: imapRef(100) }));

    const result = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });

    expect(result.new).toBe(1);
  });

  test("backfill resumes correctly across multiple ticks and eventually reaches done, ingesting every message exactly once", async () => {
    const { accounts, messages } = repos();
    const pages: Record<string, Page<Envelope>["items"][]> = {
      INBOX: [
        [envelope({ ref: imapRef(1) })],
        [envelope({ ref: imapRef(2) })],
        [envelope({ ref: imapRef(3) })],
        [envelope({ ref: imapRef(4) })],
        [envelope({ ref: imapRef(5) })],
      ],
    };
    const provider = fakeProvider({ pages });

    let totalNew = 0;
    let ticks = 0;
    while (
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ] !== "done" &&
      ticks < 10
    ) {
      const result = await ingestMailbox({
        provider,
        mailbox: "INBOX",
        accounts,
        messages,
        maxPagesPerRun: 1,
      });
      totalNew += result.new;
      ticks++;
    }

    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");
    expect(totalNew).toBe(5);
    expect(messages.listMessages().rows).toHaveLength(5);
  });

  test("small mailbox that fits in one head page marks backfill done immediately with no extra list() calls", async () => {
    const { accounts, messages } = repos();
    const listCalls: (string | undefined)[] = [];
    const provider = fakeProvider({
      pages: { INBOX: [[envelope({ ref: imapRef(1) })]] },
      onList: (_mailbox, cursor) => listCalls.push(cursor),
    });

    const result = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });

    expect(result.new).toBe(1);
    expect(listCalls).toEqual([undefined]);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");
  });

  test("a head-pass failure is recorded without disturbing a previously completed backfill's done state", async () => {
    const { accounts, messages } = repos();
    let failNext = false;
    const provider: MailProvider = {
      ...fakeProvider({
        pages: { INBOX: [[envelope({ ref: imapRef(1) })]] },
      }),
      async list(mailbox, cursor) {
        if (failNext) throw new Error("connection reset");
        const mailboxPages: Page<Envelope>["items"][] =
          mailbox === "INBOX" ? [[envelope({ ref: imapRef(1) })]] : [];
        const index = cursor ? Number(cursor) : 0;
        const items = mailboxPages[index] ?? [];
        const hasMore = index + 1 < mailboxPages.length;
        return { items, cursor: hasMore ? String(index + 1) : undefined };
      },
    };

    const first = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(first.errors).toEqual([]);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");

    failNext = true;
    const second = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });

    expect(second.errors).toEqual(["INBOX: connection reset"]);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("done");
  });

  test("one item's enqueueClassify failure doesn't lose the rest of the page", async () => {
    const { accounts, messages } = repos();
    const provider = fakeProvider({
      pages: {
        INBOX: [[envelope({ ref: imapRef(1) }), envelope({ ref: imapRef(2) })]],
      },
    });

    const enqueued: string[] = [];
    let calls = 0;
    const result = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      enqueueClassify: (key) => {
        calls++;
        if (calls === 1) throw new Error("jobs table busy");
        enqueued.push(key);
      },
    });

    // Both messages are still stored and counted new, even though the first
    // one's enqueue threw — a jobs-table hiccup on one item must not lose
    // the rest of the page.
    expect(result.new).toBe(2);
    expect(result.errors).toEqual([]);
    expect(enqueued).toHaveLength(1);
  });

  test("a stale backfill cursor (UIDVALIDITY changed) resets instead of retrying forever", async () => {
    const { accounts, messages } = repos();
    let backfillCalls = 0;

    const provider: MailProvider = {
      id: "proton",
      account: "hello@example.com",
      async capabilities() {
        return {
          list: true,
          read: true,
          search: false,
          flag: false,
          move: false,
          send: false,
          idle: false,
        };
      },
      async listMailboxes() {
        return [];
      },
      async list(_mailbox, cursor) {
        if (cursor === undefined) {
          // Head pass: one message, with a continuation cursor so the
          // backfill pass has somewhere to seed from.
          return { items: [envelope({ ref: imapRef(1) })], cursor: "1" };
        }
        // Backfill pass, using the seeded cursor: simulate the mailbox
        // having been recreated (UIDVALIDITY bump) since that cursor was
        // issued — exactly the error src/providers/imap/provider.ts's
        // imapList throws in this situation.
        backfillCalls++;
        throw new Error(
          "stale list() cursor: issued for UIDVALIDITY 1, mailbox INBOX is now at 2",
        );
      },
      async read() {
        throw new Error("not implemented in fake");
      },
      async search() {
        return [];
      },
      async setFlags() {},
      async move(ref) {
        return ref;
      },
      async send() {
        throw new Error("not implemented in fake");
      },
    };

    const first = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(first.errors).toEqual([
      "INBOX: stale list() cursor: issued for UIDVALIDITY 1, mailbox INBOX is now at 2",
    ]);
    expect(
      accounts.getAccount("proton:hello@example.com")?.cursors[
        "INBOX#backfill"
      ],
    ).toBe("restart");
    expect(backfillCalls).toBe(1);

    // Next tick: the reset cursor re-seeds from the head pass's own
    // continuation point instead of retrying the same doomed cursor again.
    const second = await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
    });
    expect(second.errors).toEqual([
      "INBOX: stale list() cursor: issued for UIDVALIDITY 1, mailbox INBOX is now at 2",
    ]);
    expect(backfillCalls).toBe(2);
  });

  test("a message with no provider date keeps its originally-assigned date across multiple ticks instead of drifting forward", async () => {
    const { accounts, messages } = repos();
    const provider = fakeProvider({
      pages: { INBOX: [[envelope({ ref: imapRef(1), date: null })]] },
    });

    await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      now: () => new Date("2026-09-28T08:00:00.000Z"),
    });

    const firstDate = messages.listMessages().rows[0]?.date;
    expect(firstDate).toBe("2026-09-28T08:00:00.000Z");

    // A later tick, still no provider date, at a much later "now" — the
    // stored date must not advance.
    await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    await ingestMailbox({
      provider,
      mailbox: "INBOX",
      accounts,
      messages,
      now: () => new Date("2026-09-29T08:00:00.000Z"),
    });

    expect(messages.listMessages().rows[0]?.date).toBe(firstDate);
  });
});
