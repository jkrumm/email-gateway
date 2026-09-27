import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { Resend } from "resend";
import { recordOutboundEmail, sendMail } from "./send-mail";
import type { EmailsRepo, UpsertEmailInput } from "../db";

const FAKE_TEMPLATE = {} as ReactElement;

function throwingRepo(): Pick<EmailsRepo, "upsertEmail"> {
  return {
    upsertEmail: () => {
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
  emails: Pick<EmailsRepo, "upsertEmail">;
  rows: UpsertEmailInput[];
} {
  const rows: UpsertEmailInput[] = [];
  return {
    rows,
    emails: { upsertEmail: (input) => rows.push(input) },
  };
}

describe("recordOutboundEmail", () => {
  test("a throwing repo is logged and swallowed, never thrown", () => {
    expect(() =>
      recordOutboundEmail(throwingRepo(), {
        id: "email_1",
        direction: "outbound",
        fromAddress: "no-reply@example.com",
        toAddresses: ["guest@example.com"],
        subject: "Hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

describe("sendMail", () => {
  test("happy path: sends, records the outbound row and returns Resend's id + the resolved from", async () => {
    const { emails, rows } = recordingRepo();

    const receipt = await sendMail({
      to: "guest@example.com",
      subject: "Hello",
      template: FAKE_TEMPLATE,
      resendClient: fakeResendClient({ id: "email_42" }),
      emails,
    });

    expect(receipt).toEqual({
      id: "email_42",
      from: "Free-Planning-Poker.com <no-reply@free-planning-poker.com>",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "email_42", direction: "outbound" });
  });

  test("the returned from reflects an explicit from, not the default", async () => {
    const { emails } = recordingRepo();

    const receipt = await sendMail({
      from: "Someone <someone@example.com>",
      to: "guest@example.com",
      subject: "Hello",
      template: FAKE_TEMPLATE,
      resendClient: fakeResendClient({ id: "email_43" }),
      emails,
    });

    expect(receipt.from).toBe("Someone <someone@example.com>");
  });

  test("a Resend error throws and records nothing", async () => {
    const { emails, rows } = recordingRepo();

    await expect(
      sendMail({
        to: "guest@example.com",
        subject: "Hello",
        template: FAKE_TEMPLATE,
        resendClient: fakeResendClient({
          error: { statusCode: 429, name: "rate_limit", message: "too fast" },
        }),
        emails,
      }),
    ).rejects.toThrow("rate_limit");
    expect(rows).toHaveLength(0);
  });
});
