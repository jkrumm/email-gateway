import { X509Certificate } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CONNECTION_TIMEOUT_MS,
  createImapflowPort,
  GREETING_TIMEOUT_MS,
  SOCKET_TIMEOUT_MS,
  tlsOptions,
  type ImapClient,
  type ImapConfig,
} from "./adapter";
import { CERT_A, CERT_B } from "../../test/certs";

const config: ImapConfig = {
  host: "bridge.example",
  port: 1143,
  user: "hello",
  password: "secret",
  mailboxes: ["INBOX"],
  tlsInsecure: false,
};

interface FakeFetched {
  uid: number;
  size?: number;
  internalDate?: Date | string;
  source?: Buffer;
  headers?: Buffer;
  envelope?: {
    subject?: string;
    from?: { address?: string }[];
    to?: { address?: string }[];
  };
  flags?: Set<string>;
  bodyStructure?: FakeBodyStructure;
}

interface FakeBodyStructure {
  disposition?: string;
  childNodes?: FakeBodyStructure[];
}

interface FakeListed {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
}

interface MoveResult {
  path: string;
  destination: string;
  uidValidity?: bigint;
  uidMap?: Map<number, number>;
}

// Read/write surface a fake test can opt into: `capabilities` defaults to
// nothing beyond core IMAP (no MOVE/IDLE), so a test proves what Bridge vs.
// Gmail actually advertise rather than assuming it.
function createFakeClient({
  fetched = [],
  mailbox = { uidValidity: 42n, uidNext: 100 },
  usable = true,
  logoutFails = false,
  connectFails = false,
  capabilities = new Map<string, boolean | number>(),
  listed = [],
  moveResult = false as false | MoveResult,
  searchResult = [] as number[] | false,
}: {
  fetched?: FakeFetched[];
  mailbox?: { uidValidity: bigint; uidNext: number } | false;
  usable?: boolean;
  logoutFails?: boolean;
  connectFails?: boolean;
  capabilities?: Map<string, boolean | number>;
  listed?: FakeListed[];
  moveResult?: false | MoveResult;
  searchResult?: number[] | false;
} = {}) {
  const record = {
    options: undefined as Record<string, unknown> | undefined,
    lockCalls: [] as [string, unknown][],
    fetchAllCalls: [] as [unknown, unknown, unknown][],
    fetchOneCalls: [] as [unknown, unknown, unknown][],
    flagCalls: [] as [string, unknown, unknown][],
    moveCalls: [] as [unknown, unknown, unknown][],
    searchCalls: [] as [unknown, unknown][],
    released: 0,
    logouts: 0,
    closes: 0,
    errorHandlers: 0,
  };

  const client = {
    usable,
    mailbox,
    capabilities,
    on: () => {
      record.errorHandlers++;
      return client;
    },
    connect: async () => {
      if (connectFails) throw new Error("greeting timeout");
    },
    logout: async () => {
      record.logouts++;
      if (logoutFails) throw new Error("connection closed");
    },
    close: () => {
      record.closes++;
    },
    list: async () => listed,
    getMailboxLock: async (path: string, options: unknown) => {
      record.lockCalls.push([path, options]);
      return { path, release: () => record.released++ };
    },
    fetchAll: async (range: unknown, query: unknown, options: unknown) => {
      record.fetchAllCalls.push([range, query, options]);
      return fetched;
    },
    fetchOne: async (seq: unknown, query: unknown, options: unknown) => {
      record.fetchOneCalls.push([seq, query, options]);
      return fetched[0] ?? false;
    },
    messageFlagsAdd: async (
      range: string | number[],
      flags: string[],
      options: unknown,
    ) => {
      record.flagCalls.push(["add", flags, { range, options }]);
      return true;
    },
    messageFlagsRemove: async (
      range: string | number[],
      flags: string[],
      options: unknown,
    ) => {
      record.flagCalls.push(["remove", flags, { range, options }]);
      return true;
    },
    messageFlagsSet: async (
      range: string | number[],
      flags: string[],
      options: unknown,
    ) => {
      record.flagCalls.push(["set", flags, { range, options }]);
      return true;
    },
    messageMove: async (
      range: unknown,
      destination: unknown,
      options: unknown,
    ) => {
      record.moveCalls.push([range, destination, options]);
      return moveResult;
    },
    search: async (query: unknown, options: unknown) => {
      record.searchCalls.push([query, options]);
      return searchResult;
    },
  } as unknown as ImapClient;

  const createClient = (options: Record<string, unknown>) => {
    record.options = options;
    return client;
  };

  return { record, createClient: createClient as never };
}

describe("createImapflowPort", () => {
  test("connects with STARTTLS-only, timeouts and no logger", async () => {
    const { record, createClient } = createFakeClient();

    await createImapflowPort(config, { createClient }).connect();

    expect(record.options).toMatchObject({
      host: "bridge.example",
      port: 1143,
      secure: false,
      doSTARTTLS: true,
      logger: false,
      auth: { user: "hello", pass: "secret" },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
    // An error listener is attached so socket errors can't crash the process.
    expect(record.errorHandlers).toBe(1);
    // A hostname is its own SNI; only IP hosts get an explicit servername.
    expect(record.options).not.toHaveProperty("servername");
  });

  test("an IP host gets a string servername (Bun rejects imapflow's false)", async () => {
    const { record, createClient } = createFakeClient();

    await createImapflowPort(
      { ...config, host: "100.64.0.1" },
      { createClient },
    ).connect();

    expect(record.options).toMatchObject({ servername: "localhost" });
  });

  test("a failed connect closes the client and rethrows", async () => {
    const { record, createClient } = createFakeClient({ connectFails: true });

    await expect(
      createImapflowPort(config, { createClient }).connect(),
    ).rejects.toThrow("greeting timeout");
    expect(record.closes).toBe(1);
  });

  test("opens mailboxes read-only and reports UIDVALIDITY as a string", async () => {
    const { record, createClient } = createFakeClient();
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    const mailbox = await session.openMailbox("Spam");

    expect(record.lockCalls).toEqual([["Spam", { readOnly: true }]]);
    expect(mailbox.uidValidity).toBe("42");
    mailbox.release();
    expect(record.released).toBe(1);
  });

  test("releases the lock and throws when the mailbox did not open", async () => {
    const { record, createClient } = createFakeClient({ mailbox: false });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    await expect(session.openMailbox("INBOX")).rejects.toThrow(
      "mailbox INBOX did not open",
    );
    expect(record.released).toBe(1);
  });

  test("listAfter drops the phantom 'N:*' message, sorts ascending and normalises dates and sizes", async () => {
    const { record, createClient } = createFakeClient({
      fetched: [
        { uid: 30, size: 300, internalDate: "garbage" },
        { uid: 5, size: 50 }, // already-seen uid the server returned anyway
        { uid: 12, internalDate: new Date("2026-09-15T07:00:00.000Z") },
        { uid: 20, size: 200, internalDate: new Date("not a date") },
      ],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const { messages, truncated } = await mailbox.listAfter(10, 100);

    expect(messages).toEqual([
      {
        uid: 12,
        size: null,
        internalDate: new Date("2026-09-15T07:00:00.000Z"),
      },
      { uid: 20, size: 200, internalDate: null },
      { uid: 30, size: 300, internalDate: null },
    ]);
    expect(truncated).toBe(false);
    expect(record.fetchAllCalls).toEqual([
      ["11:2010", { uid: true, size: true, internalDate: true }, { uid: true }],
    ]);
  });

  test("listAfter walks bounded UID windows and reports truncation", async () => {
    const { record, createClient } = createFakeClient({
      mailbox: { uidValidity: 1n, uidNext: 10_000 },
      fetched: [], // sparse mailbox: every window is empty
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const listing = await mailbox.listAfter(0, 10);

    expect(record.fetchAllCalls.map(([range]) => range)).toEqual([
      "1:2000",
      "2001:4000",
      "4001:6000",
      "6001:8000",
      "8001:10000",
    ]);
    expect(listing).toEqual({ messages: [], truncated: false });
  });

  test("listAfter stops at the limit and flags more pending", async () => {
    const { record, createClient } = createFakeClient({
      mailbox: { uidValidity: 1n, uidNext: 10_000 },
      fetched: Array.from({ length: 5 }, (_, i) => ({ uid: i + 1, size: 1 })),
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const listing = await mailbox.listAfter(0, 3);

    expect(listing.messages.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(listing.truncated).toBe(true);
    expect(record.fetchAllCalls).toHaveLength(1);
  });

  test("uses only fetchAll/fetchOne, always by UID, for sources, headers and existence", async () => {
    const { record, createClient } = createFakeClient({
      fetched: [
        { uid: 7, source: Buffer.from("raw"), headers: Buffer.from("h") },
      ],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const sources = await mailbox.fetchSources([7, 8]);
    const headers = await mailbox.fetchHeaders(7);
    const existing = await mailbox.existingUids([7, 8]);

    expect(Buffer.from(sources.get(7)!).toString()).toBe("raw");
    expect(sources.has(8)).toBe(false);
    expect(Buffer.from(headers!).toString()).toBe("h");
    expect(existing).toEqual(new Set([7]));
    expect(record.fetchAllCalls).toEqual([
      [[7, 8], { uid: true, source: true }, { uid: true }],
      [[7, 8], { uid: true }, { uid: true }],
    ]);
    expect(record.fetchOneCalls).toEqual([
      ["7", { uid: true, headers: true }, { uid: true }],
    ]);
  });

  test("close() logs out when the connection is usable", async () => {
    const { record, createClient } = createFakeClient();
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    await session.close();

    expect(record.logouts).toBe(1);
    expect(record.closes).toBe(0);
  });

  test("close() falls back to a hard close when logout fails", async () => {
    const { record, createClient } = createFakeClient({ logoutFails: true });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    await session.close();

    expect(record.logouts).toBe(1);
    expect(record.closes).toBe(1);
  });

  test("close() skips logout on an already dead connection", async () => {
    const { record, createClient } = createFakeClient({ usable: false });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    await session.close();

    expect(record.logouts).toBe(0);
    expect(record.closes).toBe(1);
  });

  test("capabilities are read from the connection, not assumed from the config", async () => {
    const { createClient: bare } = createFakeClient();
    const bareSession = await createImapflowPort(config, {
      createClient: bare,
    }).connect();
    expect(bareSession.capabilities!()).toEqual({
      list: true,
      read: true,
      search: true,
      flag: true,
      move: false,
      send: false,
      idle: false,
    });

    const { createClient: full } = createFakeClient({
      capabilities: new Map([
        ["MOVE", true],
        ["UIDPLUS", true],
        ["IDLE", true],
      ]),
    });
    const fullSession = await createImapflowPort(config, {
      createClient: full,
    }).connect();
    expect(fullSession.capabilities!()).toMatchObject({
      move: true,
      idle: true,
    });

    const { createClient: moveOnly } = createFakeClient({
      capabilities: new Map([["MOVE", true]]),
    });
    const moveOnlySession = await createImapflowPort(config, {
      createClient: moveOnly,
    }).connect();
    expect(moveOnlySession.capabilities!()).toMatchObject({
      // MOVE without UIDPLUS can't report a destination ref, so it's not
      // advertised as usable — see makeMove's own guard for why.
      move: false,
    });
  });

  test("listMailboxes maps LIST entries, keeping special-use", async () => {
    const { createClient } = createFakeClient({
      listed: [
        { path: "INBOX", name: "INBOX", delimiter: "/" },
        { path: "Trash", name: "Trash", delimiter: "/", specialUse: "\\Trash" },
      ],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    expect(await session.listMailboxes!()).toEqual([
      { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: undefined },
      { path: "Trash", name: "Trash", delimiter: "/", specialUse: "\\Trash" },
    ]);
  });

  test("openMailbox opens EXAMINE by default and SELECT only when a write is requested", async () => {
    const { record, createClient } = createFakeClient();
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    await session.openMailbox("INBOX");
    await session.openMailbox("INBOX", { readOnly: false });

    expect(record.lockCalls).toEqual([
      ["INBOX", { readOnly: true }],
      ["INBOX", { readOnly: false }],
    ]);
  });

  test("listBefore walks descending windows, maps envelope/flags/attachments and reports truncation", async () => {
    const { record, createClient } = createFakeClient({
      mailbox: { uidValidity: 1n, uidNext: 10 },
      fetched: [
        {
          uid: 5,
          size: 100,
          envelope: {
            subject: "Hi",
            from: [{ address: "ada@example.com" }],
            to: [{ address: "hello@example.com" }],
          },
          flags: new Set(["\\Seen"]),
          bodyStructure: { childNodes: [{ disposition: "attachment" }] },
        },
        { uid: 3, size: 50, envelope: { subject: "Bye" } },
      ],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const { messages, truncated } = await mailbox.listBefore!(undefined, 1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      uid: 5,
      from: "ada@example.com",
      to: ["hello@example.com"],
      subject: "Hi",
      flags: ["\\Seen"],
      hasAttachments: true,
    });
    expect(truncated).toBe(true);
    expect(record.fetchAllCalls[0]?.[1]).toMatchObject({
      envelope: true,
      flags: true,
      bodyStructure: true,
    });
  });

  test("listBefore reports hasAttachments for a single-part message whose root IS the attachment", async () => {
    const { createClient } = createFakeClient({
      mailbox: { uidValidity: 1n, uidNext: 10 },
      fetched: [{ uid: 5, bodyStructure: { disposition: "attachment" } }],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const { messages } = await mailbox.listBefore!(undefined, 1);

    expect(messages[0]?.hasAttachments).toBe(true);
  });

  test("listBefore reports hasAttachments for an attachment nested several multipart levels deep", async () => {
    const { createClient } = createFakeClient({
      mailbox: { uidValidity: 1n, uidNext: 10 },
      fetched: [
        {
          uid: 5,
          bodyStructure: {
            childNodes: [
              { disposition: undefined }, // multipart/alternative, text part
              {
                childNodes: [
                  { disposition: undefined },
                  { disposition: "attachment" }, // multipart/related > attachment
                ],
              },
            ],
          },
        },
      ],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const { messages } = await mailbox.listBefore!(undefined, 1);

    expect(messages[0]?.hasAttachments).toBe(true);
  });

  test("listBefore caps the number of windows scanned on a sparse mailbox, instead of walking every window down to uid 1", async () => {
    const { record, createClient } = createFakeClient({
      // A huge, empty mailbox: every window comes back with nothing.
      mailbox: { uidValidity: 1n, uidNext: 10_000_000 },
      fetched: [],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const { messages, truncated, nextBeforeUid } = await mailbox.listBefore!(
      undefined,
      500,
    );

    expect(messages).toHaveLength(0);
    expect(truncated).toBe(true);
    // The continuation point, even though nothing was found this page — a
    // caller must be able to resume the scan, not read this as "the end".
    expect(nextBeforeUid).toBe(9_960_000);
    // Bounded regardless of how sparse/huge the mailbox is — not the ~5000
    // windows an unbounded walk down to uid 1 would take here.
    expect(record.fetchAllCalls.length).toBeLessThanOrEqual(20);
  });

  test("setFlags maps a FlagChange onto messageFlagsAdd/Remove/Set, always by UID", async () => {
    const { record, createClient } = createFakeClient();
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX", { readOnly: false });

    await mailbox.setFlags!(7, { add: ["\\Flagged"], remove: ["\\Seen"] });

    expect(record.flagCalls).toEqual([
      ["add", ["\\Flagged"], { range: 7, options: { uid: true } }],
      ["remove", ["\\Seen"], { range: 7, options: { uid: true } }],
    ]);
  });

  const CAN_MOVE = new Map<string, boolean | number>([
    ["MOVE", true],
    ["UIDPLUS", true],
  ]);

  test("move calls messageMove and maps the destination uid + UIDVALIDITY from the response", async () => {
    const { record, createClient } = createFakeClient({
      capabilities: CAN_MOVE,
      moveResult: {
        path: "INBOX",
        destination: "Archive",
        uidValidity: 5n,
        uidMap: new Map([[7, 99]]),
      },
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX", { readOnly: false });

    const moved = await mailbox.move!(7, "Archive");

    expect(moved).toEqual({ uid: 99, uidValidity: "5" });
    expect(record.moveCalls).toEqual([[7, "Archive", { uid: true }]]);
  });

  test("move refuses to call messageMove at all unless the server has both MOVE and UIDPLUS", async () => {
    const moveResult = {
      path: "INBOX",
      destination: "Archive",
      uidMap: new Map([[7, 99]]),
    };

    for (const capabilities of [
      new Map<string, boolean | number>(), // neither
      new Map<string, boolean | number>([["MOVE", true]]), // MOVE, no UIDPLUS
      new Map<string, boolean | number>([["UIDPLUS", true]]), // UIDPLUS, no MOVE
    ]) {
      const { record, createClient } = createFakeClient({
        capabilities,
        moveResult,
      });
      const session = await createImapflowPort(config, {
        createClient,
      }).connect();
      const mailbox = await session.openMailbox("INBOX", { readOnly: false });

      await expect(mailbox.move!(7, "Archive")).rejects.toThrow(
        "needs both MOVE and UIDPLUS",
      );
      expect(record.moveCalls).toHaveLength(0);
    }
  });

  test("move reports no UIDVALIDITY when a UIDPLUS response's COPYUID data doesn't include it, rather than fabricating one", async () => {
    const { createClient } = createFakeClient({
      capabilities: CAN_MOVE,
      moveResult: {
        path: "INBOX",
        destination: "Archive",
        uidMap: new Map([[7, 99]]),
      },
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX", { readOnly: false });

    expect(await mailbox.move!(7, "Archive")).toEqual({
      uid: 99,
      uidValidity: null,
    });
  });

  test("move reports no destination uid when the response's uidMap has no entry for it, without treating that as a failure", async () => {
    const { createClient } = createFakeClient({
      capabilities: CAN_MOVE,
      moveResult: { path: "INBOX", destination: "Archive", uidMap: new Map() },
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX", { readOnly: false });

    expect(await mailbox.move!(7, "Archive")).toEqual({
      uid: null,
      uidValidity: null,
    });
  });

  test("move reports null (not a partial result) when messageMove itself resolves falsy", async () => {
    const { createClient } = createFakeClient({ capabilities: CAN_MOVE });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX", { readOnly: false });

    expect(await mailbox.move!(7, "Archive")).toBeNull();
  });

  test("setFlags and move are absent on a read-only open — a write there would be a live protocol error, not a typed one", async () => {
    const { createClient } = createFakeClient();
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();

    const mailbox = await session.openMailbox("INBOX");

    expect(mailbox.setFlags).toBeUndefined();
    expect(mailbox.move).toBeUndefined();
  });

  test("search compiles a SearchQuery into imapflow's SearchObject and returns uids", async () => {
    const { record, createClient } = createFakeClient({
      searchResult: [1, 2, 3],
    });
    const session = await createImapflowPort(config, {
      createClient,
    }).connect();
    const mailbox = await session.openMailbox("INBOX");

    const uids = await mailbox.search!({ from: "ada@example.com" });

    expect(uids).toEqual([1, 2, 3]);
    expect(record.searchCalls).toEqual([
      [{ from: "ada@example.com" }, { uid: true }],
    ]);
  });
});

describe("tlsOptions", () => {
  test("default: system trust store, nothing overridden", () => {
    expect(tlsOptions({ tlsInsecure: false })).toEqual({});
  });

  test("insecure: certificate verification is off", () => {
    expect(tlsOptions({ tlsInsecure: true })).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("pinned: the cert is the only trust anchor and the peer must be that exact cert", () => {
    const options = tlsOptions({ tlsCert: CERT_A, tlsInsecure: false });

    expect(options).toMatchObject({ ca: [CERT_A] });
    const check = (options as { checkServerIdentity: Function })
      .checkServerIdentity;
    const fingerprint = (pem: string) =>
      new X509Certificate(pem).fingerprint256;

    expect(check("any-host", { fingerprint256: fingerprint(CERT_A) })).toBe(
      undefined,
    );
    expect(
      check("any-host", { fingerprint256: fingerprint(CERT_B) }),
    ).toBeInstanceOf(Error);
  });

  test("pinned wins over insecure, and escaped newlines are accepted", () => {
    const oneLine = CERT_A.replace(/\n/g, "\\n");
    const options = tlsOptions({ tlsCert: oneLine, tlsInsecure: true });

    expect(options).toMatchObject({ ca: [CERT_A] });
    expect(options).not.toHaveProperty("rejectUnauthorized");
  });
});
