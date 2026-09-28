import type { Database } from "bun:sqlite";
import { type Migration, applyMigrations } from "./migration-runner";

// Ordered, idempotent migrations for the lean `mail.sqlite` store (Wave 4,
// docs/architecture.md §Lean store), tracked via its own PRAGMA user_version —
// independent of src/db/migrations.ts's `email-gateway.sqlite` counter. Add
// new entries with the next integer version — never edit a migration that has
// already shipped. The `jobs` table is deliberately not created here: it is
// owned by src/db/jobs.ts's `ensureJobsSchema` (see mail-client.ts).
export const MAIL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('proton', 'gmail', 'resend')),
        address TEXT NOT NULL,
        mailboxes TEXT,
        cursors TEXT,
        last_success_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        last_warning TEXT,
        last_warning_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        key TEXT PRIMARY KEY,
        account TEXT NOT NULL REFERENCES accounts(id),
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        from_address TEXT,
        to_addresses TEXT NOT NULL,
        cc TEXT,
        bcc TEXT,
        reply_to TEXT,
        subject TEXT,
        date TEXT NOT NULL,
        size INTEGER,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        thread_key TEXT,
        flags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_account_date ON messages (account, date);
      CREATE INDEX idx_messages_thread_key ON messages (thread_key);
      CREATE INDEX idx_messages_direction ON messages (direction);

      CREATE TABLE message_locations (
        key TEXT NOT NULL REFERENCES messages(key) ON DELETE CASCADE,
        mailbox TEXT NOT NULL,
        uid_validity TEXT,
        uid INTEGER,
        provider_ref TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (key, mailbox)
      );
      CREATE INDEX idx_message_locations_mailbox ON message_locations (mailbox);

      CREATE TABLE classifications (
        key TEXT PRIMARY KEY REFERENCES messages(key) ON DELETE CASCADE,
        category TEXT,
        priority TEXT,
        action_required INTEGER,
        summary TEXT,
        suggested_action TEXT,
        language TEXT,
        facts TEXT,
        model TEXT,
        error TEXT,
        jev_spam_probability REAL,
        jev_category TEXT,
        jev_category_confidence REAL,
        jev_latency_ms INTEGER,
        jev_model TEXT,
        jev_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_classifications_category ON classifications (category);
      CREATE INDEX idx_classifications_action_required ON classifications (action_required);

      CREATE TABLE body_cache (
        key TEXT PRIMARY KEY REFERENCES messages(key) ON DELETE CASCADE,
        html TEXT,
        text TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX idx_body_cache_fetched_at ON body_cache (fetched_at);

      CREATE TABLE send_log (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        recipients TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT,
        status TEXT,
        last_event TEXT,
        requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_send_log_created_at ON send_log (created_at);
      CREATE INDEX idx_send_log_provider_message_id ON send_log (provider_message_id);

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('fpp', 'sy-serendipity')),
        verdict TEXT NOT NULL CHECK (verdict IN ('legit', 'spam', 'marketing')),
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        model TEXT,
        delivered INTEGER NOT NULL,
        submission TEXT NOT NULL,
        llm_latency_ms INTEGER,
        jev_verdict TEXT,
        jev_confidence REAL,
        jev_probabilities TEXT,
        jev_latency_ms INTEGER,
        jev_model TEXT,
        jev_error TEXT
      );
      CREATE INDEX idx_submissions_received_at ON submissions (received_at);
      CREATE INDEX idx_submissions_verdict ON submissions (verdict);

      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preview_props TEXT,
        last_test_send_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, addresses, summary, message_key UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
];

export function runMailMigrations(
  db: Database,
  opts?: { targetVersion?: number },
): void {
  applyMigrations(db, MAIL_MIGRATIONS, opts);
}
