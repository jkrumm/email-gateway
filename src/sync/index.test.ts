import { describe, expect, test } from "bun:test";
import type { ResendClient } from "../providers/resend/client";
import { openDatabase } from "../db/client";
import type { ImapPort, ImapSession } from "../providers/imap/adapter";
import { createSyncRunner } from "./index";

const emptyList = async () => ({
  data: { object: "list" as const, has_more: false, data: [] },
  error: null,
});

function healthyResend(): ResendClient {
  return {
    emails: {
      list: emptyList,
      receiving: { list: emptyList },
    },
  } as unknown as ResendClient;
}

function failingResend(): ResendClient {
  const boom = async () => {
    throw new Error("resend down");
  };
  return {
    emails: { list: boom, receiving: { list: boom } },
  } as unknown as ResendClient;
}

function imapWithMessages(count: number): ImapPort {
  const raw = (i: number) =>
    `From: a@example.com\r\nTo: hello@example.com\r\nSubject: m${i}\r\nMessage-ID: <m${i}@x>\r\n\r\nbody`;
  const encoder = new TextEncoder();
  const session: ImapSession = {
    close: async () => undefined,
    openMailbox: async () => ({
      uidValidity: "1",
      listAfter: async (after) => ({
        messages: Array.from({ length: count }, (_, i) => i + 1)
          .filter((uid) => uid > after)
          .map((uid) => ({
            uid,
            size: encoder.encode(raw(uid)).length,
            internalDate: null,
          })),
        truncated: false,
      }),
      fetchSources: async (uids) =>
        new Map(uids.map((uid) => [uid, encoder.encode(raw(uid))])),
      fetchHeaders: async () => null,
      existingUids: async (uids) => new Set(uids),
      release: () => undefined,
    }),
  };
  return { connect: async () => session };
}

// syncImap itself throwing (not just returning errors) must still be isolated.
function explodingImap(): { port: ImapPort; mailboxes: string[] } {
  const mailboxes = {
    [Symbol.iterator]() {
      throw new Error("imap exploded");
    },
  } as unknown as string[];
  const session: ImapSession = {
    close: async () => undefined,
    openMailbox: async () => {
      throw new Error("unused");
    },
  };
  return { port: { connect: async () => session }, mailboxes };
}

function setup({
  resend = healthyResend(),
  imap,
}: {
  resend?: ResendClient;
  imap?: { port: ImapPort; mailboxes: string[] };
}) {
  const db = openDatabase(":memory:");
  let enrichCalls = 0;
  let jevKicks = 0;
  const runner = createSyncRunner({
    db,
    resend,
    imap,
    enrich: async () => {
      enrichCalls++;
    },
    kickJev: () => {
      jevKicks++;
    },
  });
  return {
    db,
    runner,
    enrichCalls: () => enrichCalls,
    jevKicks: () => jevKicks,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSyncRunner.runAllSources", () => {
  test("runs both sources, reports IMAP counts and kicks enrichment", async () => {
    const { runner, enrichCalls } = setup({
      imap: { port: imapWithMessages(3), mailboxes: ["INBOX"] },
    });

    const result = await runner.runAllSources();
    await flush();

    expect(result).toEqual({
      outbound: { new: 0, updated: 0 },
      inbound: { new: 0 },
      imap: { new: 3 },
      errors: [],
    });
    expect(enrichCalls()).toBe(1);
  });

  test("queues synced inbound mail for Jev and kicks the Jev worker", async () => {
    const { db, runner, jevKicks } = setup({
      imap: { port: imapWithMessages(3), mailboxes: ["INBOX"] },
    });

    await runner.runAllSources();

    const statuses = db
      .query<{ jev_status: string | null }, []>(
        `SELECT en.jev_status FROM email_enrichments en
         JOIN emails e ON e.id = en.email_id WHERE e.direction = 'inbound'`,
      )
      .all()
      .map((row) => row.jev_status);
    expect(statuses).toEqual(["pending", "pending", "pending"]);
    expect(jevKicks()).toBe(1);
  });

  test("without IMAP configured there is no imap summary and no enrichment kick", async () => {
    const { runner, enrichCalls } = setup({});

    const result = await runner.runAllSources();
    await flush();

    expect(result).not.toHaveProperty("imap");
    expect(enrichCalls()).toBe(0);
  });

  test("a Resend failure does not block IMAP", async () => {
    const { runner, enrichCalls } = setup({
      resend: failingResend(),
      imap: { port: imapWithMessages(2), mailboxes: ["INBOX"] },
    });

    const result = (await runner.runAllSources()) as {
      imap?: { new: number };
      errors: string[];
    };
    await flush();

    expect(result.errors).toEqual(["resend: resend down"]);
    expect(result.imap).toEqual({ new: 2 });
    // The trigger is still evaluated: IMAP added rows.
    expect(enrichCalls()).toBe(1);
  });

  test("an IMAP failure does not block or discard Resend", async () => {
    const { runner } = setup({ imap: explodingImap() });

    const result = (await runner.runAllSources()) as {
      outbound: { new: number; updated: number };
      errors: string[];
    };

    expect(result.outbound).toEqual({ new: 0, updated: 0 });
    expect(result.errors).toEqual(["imap: imap exploded"]);
  });

  test("the lock is released after every source throws", async () => {
    const { runner } = setup({
      resend: failingResend(),
      imap: explodingImap(),
    });

    const first = (await runner.runAllSources()) as { errors: string[] };
    const second = await runner.runAllSources();

    expect(first.errors).toEqual([
      "resend: resend down",
      "imap: imap exploded",
    ]);
    expect(second).not.toEqual({ busy: true });
  });

  test("a concurrent run gets busy, and the lock frees once the first finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowResend = {
      emails: {
        list: async () => {
          await gate;
          return emptyList();
        },
        receiving: { list: emptyList },
      },
    } as unknown as ResendClient;
    const { runner } = setup({ resend: slowResend });

    const first = runner.runAllSources();
    expect(await runner.runAllSources()).toEqual({ busy: true });

    release();
    await first;
    expect(await runner.runAllSources()).not.toEqual({ busy: true });
  });

  test("an enrichment failure never fails the sync", async () => {
    const db = openDatabase(":memory:");
    const runner = createSyncRunner({
      db,
      resend: healthyResend(),
      imap: { port: imapWithMessages(1), mailboxes: ["INBOX"] },
      enrich: () => {
        throw new Error("enrich exploded synchronously");
      },
    });

    const result = await runner.runAllSources();
    await flush();

    expect(result).toMatchObject({ imap: { new: 1 }, errors: [] });
  });
});
