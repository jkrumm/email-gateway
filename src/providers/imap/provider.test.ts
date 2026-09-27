import { describe, expect, test } from "bun:test";
import { createImapProvider } from "./provider";
import type {
  ImapEnvelopeInfo,
  ImapMailbox,
  ImapPort,
  ImapSession,
} from "./adapter";
import type { Capabilities } from "../port";

const config = {
  host: "h",
  port: 1143,
  user: "u",
  password: "p",
  mailboxes: ["INBOX"],
  tlsInsecure: false,
};

// A fake at the ImapPort/ImapSession level (the shape createImapProvider
// wraps), not the raw imapflow client — proves the generic MailProvider
// surface without re-testing the wire details adapter.test.ts already covers.
function createFakePort({
  capabilities = {
    list: true,
    read: true,
    search: true,
    flag: true,
    move: true,
    send: false,
    idle: false,
  },
  envelopes = [] as ImapEnvelopeInfo[],
  source = new TextEncoder().encode(
    "From: Ada <ada@example.com>\r\nTo: hello@example.com\r\nSubject: Hi\r\n\r\nBody",
  ),
  // A destination UIDVALIDITY distinct from the source mailbox's ("1"),
  // so a test that asserts on it catches the adapter reusing the wrong one.
  movedUidValidity = "2" as string | null,
}: {
  capabilities?: Capabilities;
  envelopes?: ImapEnvelopeInfo[];
  source?: Uint8Array;
  movedUidValidity?: string | null;
} = {}) {
  const closes = { session: 0, mailbox: 0 };

  const mailbox: ImapMailbox = {
    uidValidity: "1",
    listAfter: async () => ({ messages: [], truncated: false }),
    listBefore: async () => ({
      messages: envelopes,
      truncated: false,
      nextBeforeUid: 0,
    }),
    fetchSources: async (uids) => new Map(uids.map((uid) => [uid, source])),
    fetchHeaders: async () => null,
    existingUids: async (uids) => new Set(uids),
    setFlags: async () => undefined,
    move: async (uid) => ({ uid: uid + 1000, uidValidity: movedUidValidity }),
    search: async () => [1, 2],
    release: () => {
      closes.mailbox++;
    },
  };

  const session: ImapSession = {
    capabilities: () => capabilities,
    listMailboxes: async () => [{ path: "INBOX", name: "INBOX" }],
    openMailbox: async () => mailbox,
    close: async () => {
      closes.session++;
    },
  };

  const port: ImapPort = { connect: async () => session };
  return { port, closes };
}

function freshRef() {
  return {
    provider: "proton" as const,
    account: "hello@example.com",
    mailbox: "INBOX",
    uidValidity: "1",
    uid: 5,
  };
}

describe("createImapProvider", () => {
  test("capabilities() and listMailboxes() pass through the session, closing it afterwards", async () => {
    const { port, closes } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect(await provider.capabilities()).toMatchObject({ move: true });
    // The session may report idle:true (server advertises IDLE), but
    // watch() isn't implemented yet — never claim a capability that would
    // fail with "not a function" if a caller actually used it.
    expect(
      await createImapProvider(config, {
        id: "proton",
        account: "hello@example.com",
        port: createFakePort({
          capabilities: {
            list: true,
            read: true,
            search: true,
            flag: true,
            move: true,
            send: false,
            idle: true,
          },
        }).port,
      }).capabilities(),
    ).toMatchObject({ idle: false });
    expect(await provider.listMailboxes()).toEqual([
      { path: "INBOX", name: "INBOX" },
    ]);
    expect(closes.session).toBe(2);
  });

  test("list() maps envelopes to the generic Envelope shape with an opaque ref", async () => {
    const { port } = createFakePort({
      envelopes: [
        {
          uid: 5,
          size: 10,
          internalDate: new Date("2026-09-15T00:00:00.000Z"),
          from: "ada@example.com",
          to: ["hello@example.com"],
          subject: "Hi",
          hasAttachments: false,
          flags: [],
        },
      ],
    });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    const page = await provider.list("INBOX", undefined);

    expect(page.items).toEqual([
      {
        ref: {
          provider: "proton",
          account: "hello@example.com",
          mailbox: "INBOX",
          uidValidity: "1",
          uid: 5,
        },
        from: "ada@example.com",
        to: ["hello@example.com"],
        subject: "Hi",
        date: "2026-09-15T00:00:00.000Z",
        size: 10,
        hasAttachments: false,
        flags: [],
      },
    ]);
    expect(page.cursor).toBeUndefined();
  });

  test("list() reports a null date rather than fabricating one when the server gave no internal date", async () => {
    const { port } = createFakePort({
      envelopes: [
        {
          uid: 5,
          size: 10,
          internalDate: null,
          from: "ada@example.com",
          to: [],
          subject: "Hi",
          hasAttachments: false,
          flags: [],
        },
      ],
    });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect((await provider.list("INBOX", undefined)).items[0]?.date).toBeNull();
  });

  test("read() fetches the source by ref and parses it", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    const message = await provider.read(freshRef());

    expect(message.from).toBe("ada@example.com");
    expect(message.subject).toBe("Hi");
    expect(message.text?.trim()).toBe("Body");
  });

  test("read() maps a Cc header onto Message.cc", async () => {
    const { port } = createFakePort({
      source: new TextEncoder().encode(
        "From: Ada <ada@example.com>\r\nTo: hello@example.com\r\n" +
          "Cc: extra@example.com\r\nSubject: Hi\r\n\r\nBody",
      ),
    });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect((await provider.read(freshRef())).cc).toEqual(["extra@example.com"]);
  });

  test("read() normalizes a valid Date header to ISO and a malformed one to null", async () => {
    const { port } = createFakePort({
      source: new TextEncoder().encode(
        "From: Ada <ada@example.com>\r\nTo: hello@example.com\r\n" +
          "Date: Tue, 15 Sep 2026 07:15:57 +0000\r\nSubject: Hi\r\n\r\nBody",
      ),
    });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect((await provider.read(freshRef())).date).toBe(
      "2026-09-15T07:15:57.000Z",
    );

    const { port: malformedPort } = createFakePort({
      source: new TextEncoder().encode(
        "From: Ada <ada@example.com>\r\nTo: hello@example.com\r\n" +
          "Date: not a date\r\nSubject: Hi\r\n\r\nBody",
      ),
    });
    const malformedProvider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: malformedPort,
    });

    expect((await malformedProvider.read(freshRef())).date).toBeNull();
  });

  test("read()/setFlags()/move() reject a ref from a stale UIDVALIDITY", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });
    const staleRef = { ...freshRef(), uidValidity: "0" };

    await expect(provider.read(staleRef)).rejects.toThrow("stale ref");
    await expect(provider.setFlags(staleRef, {})).rejects.toThrow("stale ref");
    await expect(provider.move(staleRef, "Archive")).rejects.toThrow(
      "stale ref",
    );
  });

  test("read()/setFlags()/move() reject a ref issued for a different provider instance", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });
    const gmailRef = { ...freshRef(), provider: "gmail" as const };

    await expect(provider.read(gmailRef)).rejects.toThrow(
      'ref for provider "gmail"',
    );
    await expect(provider.setFlags(gmailRef, {})).rejects.toThrow(
      'ref for provider "gmail"',
    );
    await expect(provider.move(gmailRef, "Archive")).rejects.toThrow(
      'ref for provider "gmail"',
    );
  });

  test("read()/setFlags()/move() reject a ref issued for a different account of the same provider kind (Wave 8: two Gmail accounts)", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });
    const otherAccountRef = { ...freshRef(), account: "other@example.com" };

    await expect(provider.read(otherAccountRef)).rejects.toThrow(
      'received a ref for account "other@example.com"',
    );
    await expect(provider.setFlags(otherAccountRef, {})).rejects.toThrow(
      'received a ref for account "other@example.com"',
    );
    await expect(provider.move(otherAccountRef, "Archive")).rejects.toThrow(
      'received a ref for account "other@example.com"',
    );
  });

  test("list() still returns a continuation cursor on an empty-but-truncated page (window budget hit before finding anything)", async () => {
    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      // Simulates makeListBefore hitting its window cap on a sparse mailbox:
      // nothing found, but there's more mailbox below nextBeforeUid.
      listBefore: async () => ({
        messages: [],
        truncated: true,
        nextBeforeUid: 42,
      }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };
    const session: ImapSession = {
      openMailbox: async () => mailbox,
      close: async () => undefined,
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: { connect: async () => session },
    });

    const page = await provider.list("INBOX", undefined);

    expect(page.items).toEqual([]);
    // Must NOT be undefined — that would read as "pagination ended" and
    // silently drop everything below uid 42.
    expect(page.cursor).toBe("1:42");
  });

  test("list() rejects a stale cursor from a UIDVALIDITY the mailbox no longer has", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    // The fake mailbox is at uidValidity "1"; this cursor was issued for "0".
    await expect(provider.list("INBOX", "0:5")).rejects.toThrow(
      "stale list() cursor",
    );
  });

  test("list() rejects a garbage cursor instead of silently returning an empty page", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(provider.list("INBOX", "not-a-number")).rejects.toThrow(
      "invalid list() cursor",
    );
    await expect(provider.list("INBOX", "")).rejects.toThrow(
      "invalid list() cursor",
    );
    // No uidValidity part at all.
    await expect(provider.list("INBOX", "5")).rejects.toThrow(
      "invalid list() cursor",
    );
    // Number("") is 0, not NaN — must not silently pass as uid 0.
    await expect(provider.list("INBOX", "1:")).rejects.toThrow(
      "invalid list() cursor",
    );
    // IMAP UIDs start at 1: "0" must not silently look like a valid uid and
    // return an empty page that reads as "pagination legitimately ended".
    await expect(provider.list("INBOX", "1:0")).rejects.toThrow(
      "invalid list() cursor",
    );
  });

  test("a resend-shaped ref is rejected before any mailbox is opened", async () => {
    const { port, closes } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });
    const resendRef = { provider: "resend" as const, id: "x", mailbox: "sent" };

    await expect(provider.read(resendRef)).rejects.toThrow(
      'ref for provider "resend"',
    );
    await expect(provider.setFlags(resendRef, {})).rejects.toThrow(
      'ref for provider "resend"',
    );
    await expect(provider.move(resendRef, "Archive")).rejects.toThrow(
      'ref for provider "resend"',
    );
    // No mailbox/session was ever touched for the rejected calls.
    expect(closes.session).toBe(0);
    expect(closes.mailbox).toBe(0);
  });

  test("search() returns opaque refs built from the mailbox's search()", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect(await provider.search({ from: "ada@example.com" })).toEqual([
      {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 1,
      },
      {
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 2,
      },
    ]);
  });

  test("move() uses the destination's own UIDVALIDITY from the move response, not the source ref's", async () => {
    const { port } = createFakePort({ movedUidValidity: "2" });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    const moved = await provider.move(freshRef(), "Archive");

    expect(moved).toEqual({
      provider: "proton",
      account: "hello@example.com",
      mailbox: "Archive",
      uidValidity: "2",
      uid: 1005,
    });
  });

  test("move() refuses to build a ref when the server reports no destination UIDVALIDITY", async () => {
    const { port } = createFakePort({ movedUidValidity: null });
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(provider.move(freshRef(), "Archive")).rejects.toThrow(
      "no destination UID/UIDVALIDITY",
    );
  });

  test("capabilities()/listMailboxes()/list()/search() reject when the session/mailbox doesn't implement them", async () => {
    const bareMailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };
    const bareSession: ImapSession = {
      openMailbox: async () => bareMailbox,
      close: async () => undefined,
    };
    const port: ImapPort = { connect: async () => bareSession };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(provider.capabilities()).rejects.toThrow("capabilities");
    await expect(provider.listMailboxes()).rejects.toThrow("listMailboxes");
    await expect(provider.list("INBOX", undefined)).rejects.toThrow("list");
    await expect(provider.search({})).rejects.toThrow("search");
    await expect(provider.setFlags(freshRef(), {})).rejects.toThrow("setFlags");
    await expect(provider.move(freshRef(), "Archive")).rejects.toThrow("move");
  });

  test("read() throws when the fetched uid has no source", async () => {
    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };
    const session: ImapSession = {
      openMailbox: async () => mailbox,
      close: async () => undefined,
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: { connect: async () => session },
    });

    await expect(provider.read(freshRef())).rejects.toThrow(
      "not found in INBOX",
    );
  });

  test("move() throws when the low-level move() resolves null", async () => {
    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      move: async () => null,
      release: () => undefined,
    };
    const session: ImapSession = {
      openMailbox: async () => mailbox,
      close: async () => undefined,
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: { connect: async () => session },
    });

    await expect(provider.move(freshRef(), "Archive")).rejects.toThrow(
      "failed",
    );
  });

  test("send() is unsupported on the IMAP adapter", async () => {
    const { port } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(
      provider.send({
        to: "a@example.com",
        subject: "x",
        template: null as never,
      }),
    ).rejects.toThrow("does not support send");
  });
});
