import { describe, expect, test } from "bun:test";
import { createAccountsRepo } from "./accounts";
import { openMailDatabase } from "./mail-client";

function setup() {
  return createAccountsRepo(openMailDatabase(":memory:"));
}

describe("accounts repo", () => {
  test("upsertAccount inserts once; a second call does not change provider/address", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "gmail",
      address: "someone-else@example.com",
    });

    const account = accounts.getAccount("proton:hello@example.com");
    expect(account).toMatchObject({
      provider: "proton",
      address: "hello@example.com",
      mailboxes: [],
      cursors: {},
    });
    expect(account?.createdAt).not.toBeNull();
  });

  test("getAccount returns null for an unknown id", () => {
    const accounts = setup();
    expect(accounts.getAccount("missing")).toBeNull();
  });

  test("listAccounts returns every account ordered by id", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });
    accounts.upsertAccount({
      id: "gmail:me@gmail.com",
      provider: "gmail",
      address: "me@gmail.com",
    });

    expect(accounts.listAccounts().map((a) => a.id)).toEqual([
      "gmail:me@gmail.com",
      "proton:hello@example.com",
    ]);
  });

  test("updateMailboxes replaces the mailbox list", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });

    accounts.updateMailboxes("proton:hello@example.com", ["INBOX", "Sent"]);

    expect(accounts.getAccount("proton:hello@example.com")?.mailboxes).toEqual([
      "INBOX",
      "Sent",
    ]);
  });

  test("updateCursor merges one mailbox's cursor without disturbing others", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });

    accounts.updateCursor("proton:hello@example.com", "INBOX", "7:12");
    accounts.updateCursor("proton:hello@example.com", "Sent", "3:5");
    accounts.updateCursor("proton:hello@example.com", "INBOX", "7:20");

    expect(accounts.getAccount("proton:hello@example.com")?.cursors).toEqual({
      INBOX: "7:20",
      Sent: "3:5",
    });
  });

  test("updateCursor round-trips mailbox keys with '.', '[', ']', '\\' and a literal '\"'", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });

    accounts.updateCursor("proton:hello@example.com", "INBOX", "1:1");
    accounts.updateCursor(
      "proton:hello@example.com",
      "Lists.foo#backfill",
      "2:2",
    );
    accounts.updateCursor(
      "proton:hello@example.com",
      "[Gmail]/All Mail#backfill",
      "3:3",
    );
    accounts.updateCursor("proton:hello@example.com", 'weird"quote', "4:4");
    // A hand-built JSON path (an earlier version of this fix) either
    // mis-escaped a backslash in the key or produced an invalid path
    // outright — json_object()/json_patch() sidesteps that entirely.
    accounts.updateCursor("proton:hello@example.com", "back\\slash", "5:5");

    expect(accounts.getAccount("proton:hello@example.com")?.cursors).toEqual({
      INBOX: "1:1",
      "Lists.foo#backfill": "2:2",
      "[Gmail]/All Mail#backfill": "3:3",
      'weird"quote': "4:4",
      "back\\slash": "5:5",
    });
  });

  test("recordSuccess clears a previous error", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });

    accounts.recordError("proton:hello@example.com", "connect: ECONNREFUSED");
    expect(accounts.getAccount("proton:hello@example.com")).toMatchObject({
      lastError: "connect: ECONNREFUSED",
    });

    accounts.recordSuccess(
      "proton:hello@example.com",
      "2026-09-28T08:00:00.000Z",
    );
    expect(accounts.getAccount("proton:hello@example.com")).toMatchObject({
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: "2026-09-28T08:00:00.000Z",
    });
  });

  test("recordWarning sets the warning fields", () => {
    const accounts = setup();
    accounts.upsertAccount({
      id: "proton:hello@example.com",
      provider: "proton",
      address: "hello@example.com",
    });

    accounts.recordWarning(
      "proton:hello@example.com",
      "uid 3 unparseable",
      "2026-09-28T08:00:00.000Z",
    );

    expect(accounts.getAccount("proton:hello@example.com")).toMatchObject({
      lastWarning: "uid 3 unparseable",
      lastWarningAt: "2026-09-28T08:00:00.000Z",
    });
  });
});
