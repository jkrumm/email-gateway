import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { ResendSendClient } from "./client";
import { createResendProvider } from "./adapter";

interface Fixture {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
}

function fakeResend({
  sentItems = [],
  receivedItems = [],
  sendCalls = [] as unknown[],
}: {
  sentItems?: Fixture[];
  receivedItems?: Fixture[];
  sendCalls?: unknown[];
} = {}): ResendSendClient {
  const list =
    (items: Fixture[]) =>
    async ({ after }: { after?: string }) => {
      const startIndex = after ? items.findIndex((i) => i.id === after) + 1 : 0;
      const page = items.slice(startIndex, startIndex + 1);
      return {
        data: {
          object: "list" as const,
          has_more: startIndex + page.length < items.length,
          data: page,
        },
        error: null,
      };
    };

  const get = (items: Fixture[], extra: object) => async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) {
      return {
        data: null,
        error: {
          message: "not found",
          statusCode: 404,
          name: "not_found" as const,
        },
      };
    }
    return {
      data: { ...item, html: "<p>hi</p>", text: "hi", ...extra },
      error: null,
    };
  };

  return {
    emails: {
      list: list(sentItems),
      get: get(sentItems, {}),
      send: async (input: unknown) => {
        sendCalls.push(input);
        return { data: { id: "email_sent_1" }, error: null };
      },
      receiving: {
        list: list(receivedItems),
        get: get(receivedItems, {
          attachments: [
            { filename: "a.pdf", content_type: "application/pdf", size: 10 },
          ],
        }),
      },
    },
  } as unknown as ResendSendClient;
}

describe("createResendProvider", () => {
  test("capabilities: send + list only, no folders to search/flag/move", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    expect(await provider.capabilities()).toEqual({
      list: true,
      read: true,
      search: false,
      flag: false,
      move: false,
      send: true,
      idle: false,
    });
  });

  test("listMailboxes reports the two Resend histories as mailboxes", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    expect(await provider.listMailboxes()).toEqual([
      { path: "sent", name: "Sent" },
      { path: "received", name: "Received" },
    ]);
  });

  test("list()/read() normalize Resend's non-ISO created_at, matching the IMAP provider's true ISO dates", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend({
        sentItems: [
          {
            id: "s1",
            from: "a@x.com",
            to: ["b@x.com"],
            subject: "S1",
            created_at: "2026-09-15 07:15:57.115000+00",
          },
        ],
      }),
    });

    const listed = (await provider.list("sent", undefined)).items[0]?.date;
    const read = (
      await provider.read({ provider: "resend", id: "s1", mailbox: "sent" })
    ).date;

    expect(listed).toBe("2026-09-15T07:15:57.115Z");
    expect(read).toBe("2026-09-15T07:15:57.115Z");
  });

  test("list('sent') and list('received') page independently, newest first", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend({
        sentItems: [
          {
            id: "s1",
            from: "a@x.com",
            to: ["b@x.com"],
            subject: "S1",
            created_at: "2026-01-02",
          },
          {
            id: "s2",
            from: "a@x.com",
            to: ["b@x.com"],
            subject: "S2",
            created_at: "2026-01-01",
          },
        ],
        receivedItems: [
          {
            id: "r1",
            from: "c@x.com",
            to: ["hello@x.com"],
            subject: "R1",
            created_at: "2026-01-03",
          },
        ],
      }),
    });

    const sentPage = await provider.list("sent", undefined);
    expect(sentPage.items.map((item) => item.ref)).toEqual([
      { provider: "resend", id: "s1", mailbox: "sent" },
    ]);
    expect(sentPage.cursor).toBe("s1");

    const receivedPage = await provider.list("received", undefined);
    expect(receivedPage.items).toHaveLength(1);
    expect(receivedPage.items[0]?.ref).toEqual({
      provider: "resend",
      id: "r1",
      mailbox: "received",
    });
    expect(receivedPage.cursor).toBeUndefined();
  });

  test("read() dispatches to the endpoint the ref's mailbox names", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend({
        receivedItems: [
          {
            id: "r1",
            from: "c@x.com",
            to: ["hello@x.com"],
            subject: "R1",
            created_at: "2026-01-03",
          },
        ],
      }),
    });

    const message = await provider.read({
      provider: "resend",
      id: "r1",
      mailbox: "received",
    });

    expect(message.subject).toBe("R1");
    expect(message.attachments).toEqual([
      { filename: "a.pdf", contentType: "application/pdf", size: 10 },
    ]);
    expect(message.hasAttachments).toBe(true);
  });

  test("list() throws Resend's error message and read() throws Resend's error message", async () => {
    const erroringResend = {
      emails: {
        list: async () => ({
          data: null,
          error: { message: "unauthorized", statusCode: 401, name: "x" },
        }),
        get: async () => ({
          data: null,
          error: { message: "not found", statusCode: 404, name: "x" },
        }),
        receiving: { list: async () => ({}), get: async () => ({}) },
      },
    } as unknown as ResendSendClient;
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: erroringResend,
    });

    await expect(provider.list("sent", undefined)).rejects.toThrow(
      "unauthorized",
    );
    await expect(
      provider.read({ provider: "resend", id: "s1", mailbox: "sent" }),
    ).rejects.toThrow("not found");
  });

  test("list()/read() reject a mailbox path this adapter doesn't have", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    await expect(provider.list("drafts", undefined)).rejects.toThrow(
      'no mailbox "drafts"',
    );
  });

  test("read() rejects a ref naming a mailbox this adapter doesn't have, instead of silently reading 'sent'", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    await expect(
      provider.read({ provider: "resend", id: "s1", mailbox: "drafts" }),
    ).rejects.toThrow('no mailbox "drafts"');
  });

  test("read() rejects an IMAP-shaped ref", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    await expect(
      provider.read({
        provider: "proton",
        account: "hello@example.com",
        mailbox: "INBOX",
        uidValidity: "1",
        uid: 5,
      }),
    ).rejects.toThrow('received a ref for provider "proton"');
  });

  test("send() goes through this provider's own injected client, never the global send-route singleton", async () => {
    const sendCalls: unknown[] = [];
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend({ sendCalls }),
    });

    const receipt = await provider.send({
      to: "guest@example.com",
      subject: "Hi",
      template: {} as ReactElement,
    });

    expect(receipt.id).toBe("email_sent_1");
    expect(sendCalls).toHaveLength(1);
  });

  test("send()'s receipt reports the sender sendMail actually used, not the account or draft.from blindly", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });

    // No `from` on the draft: sendMail resolves its own default, which
    // differs from `account` — the receipt must reflect that, not `account`.
    const receipt = await provider.send({
      to: "guest@example.com",
      subject: "Hi",
      template: {} as ReactElement,
    });

    expect(receipt.from).not.toBe("no-reply@example.com");
    expect(receipt.from).toContain("free-planning-poker.com");
  });

  test("search/setFlags/move reject — Resend has no folders", async () => {
    const provider = createResendProvider({
      account: "no-reply@example.com",
      resend: fakeResend(),
    });
    const ref = {
      provider: "resend" as const,
      id: "s1",
      mailbox: "sent" as const,
    };

    await expect(provider.search({})).rejects.toThrow(
      "does not support search",
    );
    await expect(provider.setFlags(ref, {})).rejects.toThrow(
      "does not support setFlags",
    );
    await expect(provider.move(ref, "sent")).rejects.toThrow(
      "does not support move",
    );
  });
});
