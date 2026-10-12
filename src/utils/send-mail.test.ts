import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { recordSendLog, sendMail } from "./send-mail";
import type { InsertSendLogInput, SendLogRepo } from "../db/mail-index";
import { createFakeSendProvider } from "../test/fake-send-provider";

const TEMPLATE = createElement("p", null, "Hello guest");

function throwingRepo(): Pick<SendLogRepo, "insertSendLog"> {
  return {
    insertSendLog: () => {
      throw new Error("unable to open database file");
    },
  };
}

function recordingRepo(): {
  sendLog: Pick<SendLogRepo, "insertSendLog">;
  rows: InsertSendLogInput[];
} {
  const rows: InsertSendLogInput[] = [];
  return {
    rows,
    sendLog: { insertSendLog: (input) => rows.push(input) },
  };
}

describe("recordSendLog", () => {
  test("a throwing repo is logged and swallowed, never thrown", () => {
    expect(() =>
      recordSendLog(throwingRepo(), {
        id: "email_1",
        recipients: ["guest@example.com"],
        provider: "resend",
        requestedBy: "route",
      }),
    ).not.toThrow();
  });
});

describe("sendMail", () => {
  test("happy path: renders, sends through the provider, records the send_log row and returns the provider's id + the resolved from", async () => {
    const { sendLog, rows } = recordingRepo();
    const provider = createFakeSendProvider({
      id: "fake",
      providerMessageId: "email_42",
    });

    const receipt = await sendMail({
      to: "guest@example.com",
      subject: "Hello",
      template: TEMPLATE,
      source: "fpp-sender",
      provider,
      sendLog,
    });

    expect(receipt).toEqual({
      id: "email_42",
      from: "Free-Planning-Poker.com <no-reply@free-planning-poker.com>",
    });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      from: "Free-Planning-Poker.com <no-reply@free-planning-poker.com>",
      to: "guest@example.com",
      subject: "Hello",
    });
    expect(provider.sent[0]?.html).toContain("Hello guest");
    expect(provider.sent[0]?.text).toContain("Hello guest");
    expect(provider.sent[0]?.idempotencyKey).toBeUndefined();
    expect(rows).toEqual([
      {
        id: "email_42",
        templateId: "fpp-sender",
        recipients: ["guest@example.com"],
        provider: "fake",
        providerMessageId: "email_42",
        status: "sent",
        requestedBy: "route",
      },
    ]);
  });

  test("the returned from reflects an explicit from, not the default", async () => {
    const { sendLog } = recordingRepo();
    const provider = createFakeSendProvider();

    const receipt = await sendMail({
      from: "Someone <someone@example.com>",
      to: "guest@example.com",
      subject: "Hello",
      template: TEMPLATE,
      provider,
      sendLog,
    });

    expect(receipt.from).toBe("Someone <someone@example.com>");
    expect(provider.sent[0]?.from).toBe("Someone <someone@example.com>");
  });

  test("a provider error throws and records nothing", async () => {
    const { sendLog, rows } = recordingRepo();

    await expect(
      sendMail({
        to: "guest@example.com",
        subject: "Hello",
        template: TEMPLATE,
        provider: createFakeSendProvider({
          sendError: "429 - rate_limit - too fast",
        }),
        sendLog,
      }),
    ).rejects.toThrow("429 - rate_limit - too fast");
    expect(rows).toHaveLength(0);
  });

  test("a throwing send_log write never fails an already-sent email", async () => {
    const receipt = await sendMail({
      to: "guest@example.com",
      subject: "Hello",
      template: TEMPLATE,
      provider: createFakeSendProvider({ providerMessageId: "email_7" }),
      sendLog: throwingRepo(),
    });

    expect(receipt.id).toBe("email_7");
  });
});
