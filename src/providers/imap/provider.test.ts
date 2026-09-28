import { describe, expect, test } from "bun:test";
import { createImapProvider } from "./provider";
import type {
  ImapEnvelopeInfo,
  ImapIdleClient,
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
  const connects = { count: 0 };
  const opens: { path: string; readOnly?: boolean }[] = [];
  let usable = true;

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
    openMailbox: async (path, options) => {
      opens.push({ path, readOnly: options?.readOnly });
      return mailbox;
    },
    close: async () => {
      closes.session++;
    },
    isUsable: () => usable,
  };

  const port: ImapPort = {
    connect: async () => {
      connects.count++;
      usable = true;
      return session;
    },
  };
  return {
    port,
    closes,
    connects,
    opens,
    setUsable: (value: boolean) => {
      usable = value;
    },
  };
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
  test("capabilities() and listMailboxes() pass through the session, reusing the pooled connection", async () => {
    const { port, closes, connects } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    expect(await provider.capabilities()).toMatchObject({ move: true });
    // watch() exists now — idle must reflect exactly what the session
    // reported, never a hardcoded override.
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
    ).toMatchObject({ idle: true });
    expect(await provider.listMailboxes()).toEqual([
      { path: "INBOX", name: "INBOX" },
    ]);
    // Both calls into the same provider instance shared one pooled
    // connection instead of opening one per call.
    expect(connects.count).toBe(1);
    expect(closes.session).toBe(0);
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

describe("createImapProvider session pooling", () => {
  test("two sequential calls into the same provider instance reuse one connect()", async () => {
    const { port, connects } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await provider.list("INBOX", undefined);
    await provider.list("INBOX", undefined);

    expect(connects.count).toBe(1);
  });

  test("a call to a different mailbox reopens the mailbox but not the connection", async () => {
    const { port, connects, opens } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await provider.list("INBOX", undefined);
    await provider.list("Archive", undefined);

    expect(connects.count).toBe(1);
    expect(opens.map((open) => open.path)).toEqual(["INBOX", "Archive"]);
  });

  test("a call to the same mailbox in a different read/write mode reopens it too", async () => {
    const { port, connects, opens } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await provider.list("INBOX", undefined);
    await provider.setFlags(freshRef(), { add: ["\\Seen"] });
    await provider.list("INBOX", undefined);

    expect(connects.count).toBe(1);
    expect(opens.map((open) => [open.path, open.readOnly])).toEqual([
      ["INBOX", true],
      ["INBOX", false],
      ["INBOX", true],
    ]);
  });

  test("a connection-level failure invalidates the pooled session and retries once against a fresh one", async () => {
    let failuresLeft = 1;
    let usable = true;
    const connects = { count: 0 };
    const closes = { session: 0 };
    const opens: string[] = [];
    const source = new TextEncoder().encode(
      "From: Ada <ada@example.com>\r\nTo: hello@example.com\r\nSubject: Hi\r\n\r\nBody",
    );

    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      listBefore: async () => ({
        messages: [],
        truncated: false,
        nextBeforeUid: 0,
      }),
      fetchSources: async (uids) => {
        if (failuresLeft > 0) {
          failuresLeft--;
          usable = false;
          throw new Error("socket closed unexpectedly");
        }
        return new Map(uids.map((uid) => [uid, source]));
      },
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };

    const session: ImapSession = {
      openMailbox: async (path) => {
        opens.push(path);
        return mailbox;
      },
      close: async () => {
        closes.session++;
      },
      isUsable: () => usable,
    };

    const port: ImapPort = {
      connect: async () => {
        connects.count++;
        usable = true;
        return session;
      },
    };

    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    const message = await provider.read(freshRef());

    expect(message.subject).toBe("Hi");
    // One connect for the attempt that hit the dead connection, one more for
    // the retry's fresh session.
    expect(connects.count).toBe(2);
    // The dead session was closed before the retry opened a new one.
    expect(closes.session).toBe(1);
    expect(opens).toEqual(["INBOX", "INBOX"]);
  });

  test("a dead connection detected while opening the mailbox (not during fn) also invalidates and retries once", async () => {
    let openFailuresLeft = 1;
    let usable = true;
    const connects = { count: 0 };
    const closes = { session: 0 };
    const opens: string[] = [];

    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      listBefore: async () => ({
        messages: [],
        truncated: false,
        nextBeforeUid: 0,
      }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };

    const session: ImapSession = {
      openMailbox: async (path) => {
        opens.push(path);
        // The pooled connection died between calls, not mid-fn: the very
        // next call's openMailbox() (a cache miss, since the path changes)
        // is what discovers it.
        if (path === "Archive" && openFailuresLeft > 0) {
          openFailuresLeft--;
          usable = false;
          throw new Error("socket closed unexpectedly");
        }
        return mailbox;
      },
      close: async () => {
        closes.session++;
      },
      isUsable: () => usable,
    };

    const port: ImapPort = {
      connect: async () => {
        connects.count++;
        usable = true;
        return session;
      },
    };

    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    // First call opens and caches INBOX on the one pooled connection.
    await provider.list("INBOX", undefined);
    expect(connects.count).toBe(1);

    // Second call switches mailboxes, forcing a fresh openMailbox("Archive")
    // — it fails because the pooled connection died in between, and must hit
    // the same dead-connection retry a fn-time failure would.
    const page = await provider.list("Archive", undefined);

    expect(page.items).toEqual([]);
    expect(opens).toEqual(["INBOX", "Archive", "Archive"]);
    // One connect for the original session, one more for the retry's fresh
    // session.
    expect(connects.count).toBe(2);
    expect(closes.session).toBe(1);
  });

  test("an application-level error on a healthy connection is never retried", async () => {
    const connects = { count: 0 };
    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      listBefore: async () => ({
        messages: [],
        truncated: false,
        nextBeforeUid: 0,
      }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      release: () => undefined,
    };
    const session: ImapSession = {
      openMailbox: async () => mailbox,
      close: async () => undefined,
      isUsable: () => true,
    };
    const port: ImapPort = {
      connect: async () => {
        connects.count++;
        return session;
      },
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(provider.read(freshRef())).rejects.toThrow(
      "not found in INBOX",
    );
    expect(connects.count).toBe(1);
  });

  test("idle-closes the pooled session after poolIdleMs of no calls, then reconnects on the next call", async () => {
    const { port, closes, connects } = createFakePort();
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
      poolIdleMs: 20,
    });

    await provider.capabilities();
    expect(connects.count).toBe(1);
    expect(closes.session).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(closes.session).toBe(1);

    await provider.capabilities();
    expect(connects.count).toBe(2);
  });

  test("the idle-close timer only starts counting after a call completes, never mid-call", async () => {
    const closes = { session: 0 };
    const connects = { count: 0 };
    const session: ImapSession = {
      listMailboxes: async () => {
        // Outlasts poolIdleMs below — if the timer were armed before this
        // call ran (the bug), it would fire mid-flight and invalidate a
        // perfectly healthy, still in-progress session.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [{ path: "INBOX", name: "INBOX" }];
      },
      openMailbox: async () => {
        throw new Error("not used by this test");
      },
      close: async () => {
        closes.session++;
      },
      isUsable: () => true,
    };
    const port: ImapPort = {
      connect: async () => {
        connects.count++;
        return session;
      },
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
      poolIdleMs: 20,
    });

    await provider.listMailboxes();

    expect(closes.session).toBe(0);
    expect(connects.count).toBe(1);

    // The timer only starts once the call returns — confirm it still fires
    // on its own from there.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(closes.session).toBe(1);
  });

  test("setFlags()/move() never retry a mutating command after the connection turns unusable — the error propagates and the session is dropped instead", async () => {
    let setFlagsCalls = 0;
    let usable = true;
    const connects = { count: 0 };
    const closes = { session: 0 };
    const mailbox: ImapMailbox = {
      uidValidity: "1",
      listAfter: async () => ({ messages: [], truncated: false }),
      fetchSources: async () => new Map(),
      fetchHeaders: async () => null,
      existingUids: async () => new Set(),
      setFlags: async () => {
        setFlagsCalls++;
        usable = false;
        throw new Error("socket closed unexpectedly");
      },
      release: () => undefined,
    };
    const session: ImapSession = {
      openMailbox: async () => mailbox,
      close: async () => {
        closes.session++;
      },
      isUsable: () => usable,
    };
    const port: ImapPort = {
      connect: async () => {
        connects.count++;
        usable = true;
        return session;
      },
    };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port,
    });

    await expect(
      provider.setFlags(freshRef(), { add: ["\\Seen"] }),
    ).rejects.toThrow("socket closed unexpectedly");

    // The mutating command was issued exactly once — never replayed once its
    // outcome became unknown.
    expect(setFlagsCalls).toBe(1);
    expect(connects.count).toBe(1);
    // The dead session was still dropped so the next, unrelated call gets a
    // fresh one.
    expect(closes.session).toBe(1);
  });
});

// A fake at the ImapIdleClient level (the Pick<ImapFlow, ...> shape
// watch()'s dedicated connection consumes) — an event-emitter-ish stub the
// test drives directly, not a real socket.
function createFakeIdleClient({
  // When set, connect() rejects with this error instead of succeeding —
  // simulates the very first connect (or a reconnect attempt) failing.
  connectError,
  // Shared across multiple fakes so a test can assert relative ordering of
  // calls across the outgoing and incoming client on a reconnect.
  log,
}: { connectError?: Error; log?: string[] } = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls = { connect: 0, mailboxOpen: 0, logout: 0, idle: 0 };
  const idleWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  function on(event: string, listener: (...args: unknown[]) => void) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)?.add(listener);
    return client;
  }

  function off(event: string, listener: (...args: unknown[]) => void) {
    listeners.get(event)?.delete(listener);
    log?.push(`off:${event}`);
    return client;
  }

  const client = {
    usable: true,
    on,
    off,
    connect: async () => {
      calls.connect++;
      log?.push("connect");
      if (connectError) throw connectError;
    },
    mailboxOpen: async () => {
      calls.mailboxOpen++;
      log?.push("mailboxOpen");
      return {} as never;
    },
    logout: async () => {
      calls.logout++;
      log?.push("logout");
    },
    close: () => undefined,
    idle: () => {
      calls.idle++;
      return new Promise<boolean>((resolve, reject) => {
        idleWaiters.push({ resolve: () => resolve(true), reject });
      });
    },
  } as unknown as ImapIdleClient;

  // Mirrors adapter.ts's createIdleClient, which attaches its own 'error'
  // listener directly to the real socket so an emitted error can never reach
  // zero listeners and crash the process. That listener is never exposed
  // through the ImapIdleClient surface and provider.ts must never be able to
  // remove it — bake in an equivalent survivor here so a test can assert it
  // stays attached across every detach path.
  let crashGuardFired = false;
  on("error", () => {
    crashGuardFired = true;
  });

  return {
    client,
    calls,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    get crashGuardFired() {
      return crashGuardFired;
    },
    // Rejects (or resolves) the oldest still-pending idle() call — simulates
    // IDLE finally reporting the drop of a socket that was already torn down
    // earlier via some other signal (e.g. 'close').
    rejectIdle: (error: unknown) => idleWaiters.shift()?.reject(error),
    resolveIdle: () => idleWaiters.shift()?.resolve(),
  };
}

describe("createImapProvider watch()", () => {
  function immediateWait() {
    return Promise.resolve();
  }

  // Flushes both the microtask queue and one macrotask turn, so every
  // `await` in the reconnect loop (wait(), connect(), mailboxOpen()) has
  // settled — more robust than counting microtask hops by hand.
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("fires onChange on exists/expunge/flags events", async () => {
    const fake = createFakeIdleClient();
    const changes = { count: 0 };
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => fake.client,
    });

    const unsubscribe = await provider.watch!("INBOX", () => {
      changes.count++;
    });

    fake.emit("exists");
    fake.emit("expunge");
    fake.emit("flags");

    expect(changes.count).toBe(3);
    expect(fake.calls.mailboxOpen).toBe(1);

    unsubscribe();
  });

  test("reconnects after an unsolicited close, not triggered by unsubscribe()", async () => {
    const instances: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient();
        instances.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    const unsubscribe = await provider.watch!("INBOX", () => undefined);
    expect(instances).toHaveLength(1);

    instances[0]!.emit("close");
    await flush();

    expect(instances).toHaveLength(2);
    expect(instances[1]!.calls.connect).toBe(1);
    expect(instances[1]!.calls.mailboxOpen).toBe(1);

    unsubscribe();
  });

  test("Unsubscribe stops further reconnects and logs out", async () => {
    const instances: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient();
        instances.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    const unsubscribe = await provider.watch!("INBOX", () => undefined);
    const first = instances[0]!;

    unsubscribe();

    // Only the listeners this module attached are gone; the crash-guard
    // 'error' listener baked into the fake (mirroring adapter.ts's own) is
    // never touched.
    expect(first.listenerCount("close")).toBe(0);
    expect(first.listenerCount("error")).toBe(1);
    expect(first.calls.logout).toBe(1);

    // A close arriving after unsubscribe (listeners already removed) must
    // not start a reconnect.
    first.emit("close");
    await flush();

    expect(instances).toHaveLength(1);
  });

  test("removeAllListeners is never called bare — a discarded client's crash-guard 'error' listener survives detachment and unsubscribe, and emitting 'error' on it never throws", async () => {
    const instances: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient();
        instances.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    const unsubscribe = await provider.watch!("INBOX", () => undefined);
    const first = instances[0]!;

    // Trigger a reconnect, which detaches the outgoing (first) client.
    first.emit("close");
    await flush();

    expect(instances).toHaveLength(2);
    // The crash-preventing 'error' listener is still attached to the
    // discarded client — a late error on that dying socket must not crash
    // the process by hitting zero listeners.
    expect(first.listenerCount("error")).toBe(1);
    expect(() =>
      first.emit("error", new Error("late socket error")),
    ).not.toThrow();
    expect(first.crashGuardFired).toBe(true);

    unsubscribe();
  });

  test("a superseded connection's late idle() rejection does not start a second reconnect loop", async () => {
    const instances: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient();
        instances.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    const unsubscribe = await provider.watch!("INBOX", () => undefined);
    const first = instances[0]!;

    // A legitimate reconnect via 'close' completes, swapping in a second
    // client — the first client's own idle() call is still pending.
    first.emit("close");
    await flush();
    expect(instances).toHaveLength(2);
    expect(instances[1]!.calls.connect).toBe(1);

    // The old (now-superseded) connection's pending idle() finally rejects
    // late — its socket was already torn down, just slow to report it.
    first.rejectIdle(new Error("late socket teardown"));
    await flush();

    // Must not start a second, redundant reconnect beyond the one legitimate
    // reconnect that already completed.
    expect(instances).toHaveLength(2);
    expect(instances[1]!.calls.connect).toBe(1);

    unsubscribe();
  });

  test("watch() rejects cleanly when the very first connect() fails, and never starts a background reconnect loop", async () => {
    const attempts: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient({
          connectError: new Error("ECONNREFUSED"),
        });
        attempts.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    await expect(provider.watch!("INBOX", () => undefined)).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.calls.connect).toBe(1);

    // A late close/error firing on the failed client (imapflow can emit
    // these around a failed connect) must not start a reconnect loop —
    // watch() already rejected, and its caller never got an Unsubscribe to
    // stop one.
    attempts[0]!.emit("close");
    attempts[0]!.emit("error");
    await flush();
    await flush();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.calls.connect).toBe(1);
  });

  test("a reconnect detaches and closes the outgoing client before the new one ever connects", async () => {
    const log: string[] = [];
    const instances: ReturnType<typeof createFakeIdleClient>[] = [];
    const provider = createImapProvider(config, {
      id: "proton",
      account: "hello@example.com",
      port: createFakePort().port,
      createIdleClient: () => {
        const fake = createFakeIdleClient({ log });
        instances.push(fake);
        return fake.client;
      },
      idleReconnectWait: immediateWait,
      idleReconnectRandom: () => 0,
    });

    const unsubscribe = await provider.watch!("INBOX", () => undefined);
    log.length = 0; // drop the initial connect's own log entries

    instances[0]!.emit("close");
    await flush();

    expect(instances).toHaveLength(2);
    // Only this module's own listeners were detached — the crash-guard
    // 'error' listener baked into the fake (mirroring adapter.ts's own)
    // survives.
    expect(instances[0]!.listenerCount("close")).toBe(0);
    expect(instances[0]!.listenerCount("error")).toBe(1);
    expect(instances[0]!.calls.logout).toBe(1);
    // The outgoing client was detached and logged out strictly before the
    // incoming one connected and opened the mailbox.
    expect(log).toEqual([
      "off:exists",
      "off:expunge",
      "off:flags",
      "off:close",
      "off:error",
      "logout",
      "connect",
      "mailboxOpen",
    ]);

    unsubscribe();
  });
});
