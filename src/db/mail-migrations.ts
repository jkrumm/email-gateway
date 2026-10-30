import type { Database } from 'bun:sqlite'
import { type Migration, applyMigrations } from './migration-runner'

// Ordered, idempotent migrations for the lean `mail.sqlite` store (Wave 4,
// docs/architecture.md §Lean store), tracked via its own PRAGMA user_version —
// independent of src/db/migrations.ts's `email-gateway.sqlite` counter. Add
// new entries with the next integer version — never edit a migration that has
// already shipped. The `jobs` table is deliberately not created here: it is
// owned by src/db/jobs.ts's `ensureJobsSchema` (see mail-client.ts).
const MAIL_MIGRATIONS: Migration[] = [
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
  {
    // Wave 7: src/jobs/reconcile-send-log.ts's listReconcilable runs every
    // 5 minutes, filtering send_log by provider and ordering by updated_at —
    // a pattern neither of version 1's send_log indexes cover.
    version: 2,
    up: `
      CREATE INDEX idx_send_log_provider_updated_at
        ON send_log (provider, updated_at);
    `,
  },
  {
    // Wave 8: cached LLM thread summaries, keyed by the message's own key when
    // it has no threadKey (src/services/agent-api.ts). message_count lets a
    // cached row be invalidated when the thread gains a message.
    version: 3,
    up: `
      CREATE TABLE thread_summaries (
        thread_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        model TEXT,
        message_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // Wave 8 follow-up: invalidate the cache on the thread's newest message
    // key instead of its row count, which a thread longer than one page can
    // never advance (src/services/agent-api.ts getThreadSummary). Existing
    // rows get NULL, so the next call re-summarizes and repopulates.
    version: 4,
    up: `
      ALTER TABLE thread_summaries ADD COLUMN latest_key TEXT;
    `,
  },
  {
    // Resend is no longer a provider: drop its account's data, dependents
    // first. Explicit deletes rather than ON DELETE CASCADE, since foreign
    // keys cannot be toggled inside the migration transaction. Resend never
    // set a threadKey, so its thread_summaries rows are keyed by message key.
    // send_log history rows stay, except in-flight Resend sends (no provider
    // message id, never delivered to Resend): those become 'failed' so they
    // are visible. Their pending send/reconcile_send_log jobs are discarded at
    // boot (src/jobs/discard-resend.ts) — the jobs table is not guaranteed to
    // exist yet when migrations run. The reconcile index has no reader left.
    version: 5,
    up: `
      DELETE FROM thread_summaries
        WHERE thread_key IN (
          SELECT key FROM messages
            WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend')
        );
      DELETE FROM messages_fts
        WHERE message_key IN (
          SELECT key FROM messages
            WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend')
        );
      DELETE FROM classifications
        WHERE key IN (
          SELECT key FROM messages
            WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend')
        );
      DELETE FROM body_cache
        WHERE key IN (
          SELECT key FROM messages
            WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend')
        );
      DELETE FROM message_locations
        WHERE key IN (
          SELECT key FROM messages
            WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend')
        );
      DELETE FROM messages
        WHERE account IN (SELECT id FROM accounts WHERE provider = 'resend');
      DELETE FROM accounts WHERE provider = 'resend';
      UPDATE send_log
        SET status = 'failed',
            last_event = 'resend_removed',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE provider = 'resend'
          AND provider_message_id IS NULL
          AND (status IS NULL OR status = 'sending');
      DROP INDEX IF EXISTS idx_send_log_provider_updated_at;
    `,
  },
  {
    // Wave 16: POST /jkrumm-contact adds a third submission source. SQLite
    // cannot alter a CHECK, so rebuild `submissions` (nothing references it by
    // foreign key; jev_submission jobs point at it by subject_key only).
    version: 6,
    up: `
      CREATE TABLE submissions_new (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('fpp', 'sy-serendipity', 'jkrumm-contact')),
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
      INSERT INTO submissions_new (
        id, received_at, source, verdict, confidence, reason, model, delivered,
        submission, llm_latency_ms, jev_verdict, jev_confidence,
        jev_probabilities, jev_latency_ms, jev_model, jev_error
      ) SELECT
        id, received_at, source, verdict, confidence, reason, model, delivered,
        submission, llm_latency_ms, jev_verdict, jev_confidence,
        jev_probabilities, jev_latency_ms, jev_model, jev_error
      FROM submissions;
      DROP TABLE submissions;
      ALTER TABLE submissions_new RENAME TO submissions;
      CREATE INDEX idx_submissions_received_at ON submissions (received_at);
      CREATE INDEX idx_submissions_verdict ON submissions (verdict);
    `,
  },
  {
    // Wave 18: SES delivery timeline. Bounce detail lands on the send_log row;
    // every SES event (Send included) lands in send_events, which has no
    // address column on purpose — the webhook never stores SNS recipient PII.
    // The UNIQUE index makes an SNS redelivery of the same event a no-op.
    version: 7,
    up: `
      ALTER TABLE send_log ADD COLUMN bounce_type TEXT;
      ALTER TABLE send_log ADD COLUMN bounce_subtype TEXT;
      ALTER TABLE send_log ADD COLUMN diagnostic_code TEXT;
      CREATE TABLE send_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        send_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT,
        bounce_type TEXT,
        bounce_subtype TEXT,
        diagnostic_code TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX idx_send_events_send_id_occurred_at ON send_events (send_id, occurred_at);
      CREATE UNIQUE INDEX idx_send_events_unique ON send_events (send_id, event_type, occurred_at);
    `,
  },
  {
    // Wave 18: the rendered mail of a dispatched send, kept 30 days for review
    // (pruned by the prune_send_bodies job). Secrets are redacted before the
    // row is written (src/utils/send-body.ts).
    version: 8,
    up: `
      CREATE TABLE send_bodies (
        send_id TEXT PRIMARY KEY,
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_send_bodies_created_at ON send_bodies (created_at);
    `,
  },
  {
    // Wave 18: the latest SES GetAccount snapshot (the ses_account job), one
    // row, upserted.
    version: 9,
    up: `
      CREATE TABLE ses_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `,
  },
]

export function runMailMigrations(db: Database, opts?: { targetVersion?: number }): void {
  applyMigrations(db, MAIL_MIGRATIONS, opts)
}
