import type { Database } from "bun:sqlite";
import { type Migration, applyMigrations } from "./migration-runner";

// Ordered, idempotent migrations tracked via PRAGMA user_version. Add new
// entries with the next integer version — never edit a migration that has
// already shipped.
const migrations: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL,
        cc TEXT,
        bcc TEXT,
        reply_to TEXT,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_event TEXT,
        html TEXT,
        text TEXT,
        attachments TEXT,
        source TEXT,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX idx_emails_direction_created_at ON emails (direction, created_at);
      CREATE INDEX idx_emails_created_at ON emails (created_at);
      CREATE INDEX idx_emails_from_address ON emails (from_address);

      CREATE TABLE email_enrichments (
        email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
        category TEXT,
        priority TEXT,
        action_required INTEGER,
        summary TEXT,
        suggested_action TEXT,
        language TEXT,
        facts TEXT,
        model TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_email_enrichments_category ON email_enrichments (category);
      CREATE INDEX idx_email_enrichments_action_required ON email_enrichments (action_required);

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        model TEXT,
        delivered INTEGER NOT NULL,
        submission TEXT NOT NULL
      );
      CREATE INDEX idx_submissions_received_at ON submissions (received_at);
      CREATE INDEX idx_submissions_verdict ON submissions (verdict);

      CREATE VIRTUAL TABLE emails_fts USING fts5(
        subject,
        from_address,
        to_addresses,
        text,
        summary,
        email_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE sync_state (
        direction TEXT PRIMARY KEY CHECK (direction IN ('inbound', 'outbound')),
        last_run_complete INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT
      );
    `,
  },
  {
    // Resend returns created_at as "2026-09-15 07:15:57.115000+00" (UTC);
    // rows are compared as ISO strings, so rewrite synced rows to ISO.
    version: 3,
    up: `
      UPDATE emails
      SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', substr(created_at, 1, 26))
      WHERE created_at LIKE '____-__-__ %';
    `,
  },
  {
    // Jev shadow-mode decisions, stored beside (never replacing) the LLM's.
    version: 4,
    up: `
      ALTER TABLE submissions ADD COLUMN llm_latency_ms INTEGER;
      ALTER TABLE submissions ADD COLUMN jev_verdict TEXT;
      ALTER TABLE submissions ADD COLUMN jev_confidence REAL;
      ALTER TABLE submissions ADD COLUMN jev_probabilities TEXT;
      ALTER TABLE submissions ADD COLUMN jev_latency_ms INTEGER;
      ALTER TABLE submissions ADD COLUMN jev_model TEXT;
      ALTER TABLE submissions ADD COLUMN jev_error TEXT;

      ALTER TABLE email_enrichments ADD COLUMN jev_spam_probability REAL;
      ALTER TABLE email_enrichments ADD COLUMN jev_category TEXT;
      ALTER TABLE email_enrichments ADD COLUMN jev_category_confidence REAL;
      ALTER TABLE email_enrichments ADD COLUMN jev_latency_ms INTEGER;
      ALTER TABLE email_enrichments ADD COLUMN jev_model TEXT;
      ALTER TABLE email_enrichments ADD COLUMN jev_error TEXT;
    `,
  },
  {
    // IMAP ingest: every row records which provider produced it (existing
    // rows are Resend by definition), plus the IMAP mailbox and RFC
    // Message-ID. imap_sync_state holds the per-mailbox UID cursor.
    version: 5,
    up: `
      ALTER TABLE emails ADD COLUMN provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend', 'imap'));
      ALTER TABLE emails ADD COLUMN mailbox TEXT;
      ALTER TABLE emails ADD COLUMN message_id TEXT;
      ALTER TABLE emails ADD COLUMN content_hash TEXT;
      CREATE INDEX idx_emails_provider_mailbox ON emails (provider, mailbox COLLATE NOCASE);
      CREATE INDEX idx_emails_message_id ON emails (message_id);

      CREATE TABLE imap_sync_state (
        mailbox TEXT PRIMARY KEY,
        uid_validity TEXT,
        last_uid INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        last_success_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        last_warning TEXT,
        last_warning_at TEXT,
        held_uid INTEGER,
        held_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    // Durable Jev queue. jev_status: NULL = not applicable (outbound email,
    // or Jev was off when the submission was recorded), 'pending' = waiting
    // for the Jev worker, 'done' / 'failed' = terminal. Backfill: rows
    // without a successful Jev result are queued (the raw payload is stored),
    // rows with one are 'done'.
    version: 6,
    up: `
      ALTER TABLE submissions ADD COLUMN jev_status TEXT CHECK (jev_status IN ('pending', 'done', 'failed'));
      ALTER TABLE submissions ADD COLUMN jev_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE submissions ADD COLUMN jev_next_attempt_at TEXT;
      ALTER TABLE submissions ADD COLUMN jev_claimed_at TEXT;

      ALTER TABLE email_enrichments ADD COLUMN jev_status TEXT CHECK (jev_status IN ('pending', 'done', 'failed'));
      ALTER TABLE email_enrichments ADD COLUMN jev_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE email_enrichments ADD COLUMN jev_next_attempt_at TEXT;
      ALTER TABLE email_enrichments ADD COLUMN jev_claimed_at TEXT;

      UPDATE submissions SET
        jev_status = CASE WHEN jev_verdict IS NOT NULL THEN 'done' ELSE 'pending' END,
        jev_attempts = CASE WHEN jev_verdict IS NOT NULL THEN 1 ELSE 0 END;
      UPDATE submissions SET
        jev_model = NULL, jev_latency_ms = NULL, jev_error = NULL
      WHERE jev_status = 'pending';

      -- Every email has an enrichment row (upsertEmail creates it in the same
      -- transaction); this only guards against a row lost to an old bug.
      INSERT INTO email_enrichments (email_id, status, attempts, updated_at)
      SELECT id, 'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM emails e
      WHERE NOT EXISTS (SELECT 1 FROM email_enrichments en WHERE en.email_id = e.id);

      UPDATE email_enrichments SET
        jev_status = CASE
          WHEN jev_model IS NOT NULL AND jev_error IS NULL THEN 'done'
          ELSE 'pending'
        END,
        jev_attempts = CASE WHEN jev_model IS NOT NULL AND jev_error IS NULL THEN 1 ELSE 0 END
      WHERE email_id IN (SELECT id FROM emails WHERE direction = 'inbound');
      UPDATE email_enrichments SET
        jev_spam_probability = NULL, jev_category = NULL,
        jev_category_confidence = NULL, jev_latency_ms = NULL,
        jev_model = NULL, jev_error = NULL
      WHERE jev_status = 'pending';

      CREATE INDEX idx_submissions_jev_status ON submissions (jev_status) WHERE jev_status = 'pending';
      CREATE INDEX idx_email_enrichments_jev_status ON email_enrichments (jev_status) WHERE jev_status = 'pending';
    `,
  },
];

export function runMigrations(
  db: Database,
  opts?: { targetVersion?: number },
): void {
  applyMigrations(db, migrations, opts);
}
