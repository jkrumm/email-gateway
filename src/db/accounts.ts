import type { Database } from "bun:sqlite";

export type AccountProvider = "proton" | "gmail" | "resend";

export interface Account {
  id: string;
  provider: AccountProvider;
  address: string;
  mailboxes: string[];
  cursors: Record<string, string>;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastWarning: string | null;
  lastWarningAt: string | null;
  createdAt: string;
}

export interface UpsertAccountInput {
  id: string;
  provider: AccountProvider;
  address: string;
}

interface AccountRow {
  id: string;
  provider: AccountProvider;
  address: string;
  mailboxes: string | null;
  cursors: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_warning: string | null;
  last_warning_at: string | null;
  created_at: string;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    address: row.address,
    mailboxes: row.mailboxes ? JSON.parse(row.mailboxes) : [],
    cursors: row.cursors ? JSON.parse(row.cursors) : {},
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastWarning: row.last_warning,
    lastWarningAt: row.last_warning_at,
    createdAt: row.created_at,
  };
}

// One row per mail account (Proton hello@, a Gmail address, the Resend
// send-only "account"); docs/architecture.md §Lean store `accounts` table.
export function createAccountsRepo(db: Database) {
  // id is the account's stable identity (e.g. "proton:hello@example.com");
  // provider/address are set once on first sight and never change afterwards.
  function upsertAccount(input: UpsertAccountInput): void {
    db.run(
      `INSERT INTO accounts (id, provider, address, mailboxes, cursors, created_at)
       VALUES (?, ?, ?, '[]', '{}', ?)
       ON CONFLICT(id) DO NOTHING`,
      [input.id, input.provider, input.address, new Date().toISOString()],
    );
  }

  function getAccount(id: string): Account | null {
    const row = db
      .query<AccountRow, [string]>("SELECT * FROM accounts WHERE id = ?")
      .get(id);
    return row ? toAccount(row) : null;
  }

  function listAccounts(): Account[] {
    return db
      .query<AccountRow, []>("SELECT * FROM accounts ORDER BY id")
      .all()
      .map(toAccount);
  }

  function updateMailboxes(id: string, mailboxes: string[]): void {
    db.run("UPDATE accounts SET mailboxes = ? WHERE id = ?", [
      JSON.stringify(mailboxes),
      id,
    ]);
  }

  // Single atomic statement — merges one mailbox's cursor into the stored
  // blob without disturbing the others. A prior SELECT -> JSON.parse ->
  // merge -> JSON.stringify -> UPDATE here raced: two concurrent calls for
  // the same account (e.g. a head and a backfill pass for different
  // mailboxes) could interleave and the second commit clobbered the first's
  // key.
  //
  // json_object(?, ?) builds a single-key {mailbox: cursor} object with
  // SQLite doing its own JSON-string escaping for the key — no hand-built
  // JSON path string. A prior version built the path as `$."key"` via SQL
  // string concatenation, which broke on mailbox names containing '\' (an
  // unescaped backslash either mis-escaped into \n/\u.../etc or produced an
  // invalid path outright) on top of needing manual quote-escaping for '.'/
  // '['/']' (IMAP hierarchy separators, Gmail's "[Gmail]/All Mail"..
  // json_patch's shallow top-level merge is exactly "add or overwrite this
  // one key, leave every other key alone" — verified against '.', '[', ']',
  // '"', and '\' in the mailbox name, all round-trip exactly.
  function updateCursor(id: string, mailbox: string, cursor: string): void {
    db.run(
      `UPDATE accounts
       SET cursors = json_patch(COALESCE(cursors, '{}'), json_object(?, ?))
       WHERE id = ?`,
      [mailbox, cursor, id],
    );
  }

  function recordSuccess(
    id: string,
    now: string = new Date().toISOString(),
  ): void {
    db.run(
      `UPDATE accounts SET
         last_success_at = ?,
         last_error = NULL,
         last_error_at = NULL
       WHERE id = ?`,
      [now, id],
    );
  }

  function recordError(
    id: string,
    error: string,
    now: string = new Date().toISOString(),
  ): void {
    db.run(
      "UPDATE accounts SET last_error = ?, last_error_at = ? WHERE id = ?",
      [error, now, id],
    );
  }

  function recordWarning(
    id: string,
    warning: string,
    now: string = new Date().toISOString(),
  ): void {
    db.run(
      "UPDATE accounts SET last_warning = ?, last_warning_at = ? WHERE id = ?",
      [warning, now, id],
    );
  }

  return {
    upsertAccount,
    getAccount,
    listAccounts,
    updateMailboxes,
    updateCursor,
    recordSuccess,
    recordError,
    recordWarning,
  };
}

export type AccountsRepo = ReturnType<typeof createAccountsRepo>;
