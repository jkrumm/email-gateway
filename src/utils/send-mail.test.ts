import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { Resend } from "resend";
import { recordSendLog, sendMail } from "./send-mail";
import type { InsertSendLogInput, SendLogRepo } from "../db/mail-index";

const FAKE_TEMPLATE = {} as ReactElement;

function throwingRepo(): Pick<SendLogRepo, "insertSendLog"> {
  return {
    insertSendLog: () => {
      throw new Error("unable to open database file");
    },
  };
}

function fakeResendClient({
  id = "email_1",
  error = null as { statusCode?: number; name: string; message: string } | null,
} = {}): Pick<Resend, "emails"> {
  return {
    emails: {
      send: async () =>
        error ? { data: null, error } : { data: { id }, error: null },
    },
  } as unknown as Pick<Resend, "emails">;
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
  test("happy path: sends, records the send_log row and returns Resend's id + the resolved from", async () => {
    const { sendLog, rows } = recordingRepo();

    const receipt = await sendMail({
      to: "guest@example.com",
      subject: "Hello",
      template: FAKE_TEMPLATE,
      resendClient: fakeResendClient({ id: "email_42" }),
      sendLog,
    });

    expect(receipt).toEqual({
      id: "email_42",
      from: "Free-Planning-Poker.com <no-reply@free-planning-poker.com>",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "email_42",
      provider: "resend",
      recipients: ["guest@example.com"],
    });
  });

  test("the returned from reflects an explicit from, not the default", async () => {
    const { sendLog } = recordingRepo();

    const receipt = await sendMail({
      from: "Someone <someone@example.com>",
      to: "guest@example.com",
      subject: "Hello",
      template: FAKE_TEMPLATE,
      resendClient: fakeResendClient({ id: "email_43" }),
      sendLog,
    });

    expect(receipt.from).toBe("Someone <someone@example.com>");
  });

  test("a Resend error throws and records nothing", async () => {
    const { sendLog, rows } = recordingRepo();

    await expect(
      sendMail({
        to: "guest@example.com",
        subject: "Hello",
        template: FAKE_TEMPLATE,
        resendClient: fakeResendClient({
          error: { statusCode: 429, name: "rate_limit", message: "too fast" },
        }),
        sendLog,
      }),
    ).rejects.toThrow("rate_limit");
    expect(rows).toHaveLength(0);
  });
});
