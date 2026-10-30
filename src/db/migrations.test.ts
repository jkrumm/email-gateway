import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMigrations } from './migrations'

describe('runMigrations', () => {
  test('creates the expected tables', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      )
      .all()
      .map((row) => row.name)

    expect(tables).toContain('emails')
    expect(tables).toContain('email_enrichments')
    expect(tables).toContain('submissions')
    expect(tables).toContain('emails_fts')
    expect(tables).toContain('sync_state')
    expect(tables).toContain('imap_sync_state')
  })

  test('is idempotent — running twice does not throw or duplicate schema', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()

    const { user_version } = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
    expect(user_version).toBeGreaterThan(0)
  })
})

describe('migration 3', () => {
  test('rewrites Resend-style created_at values to ISO', () => {
    const db = new Database(':memory:')
    runMigrations(db, { targetVersion: 2 })
    db.run(
      `INSERT INTO emails (id, direction, from_address, to_addresses, subject, created_at, attachments, synced_at)
       VALUES ('e1', 'outbound', 'a@example.com', '[]', 's', '2026-09-15 07:15:57.115000+00', '[]', '2026-09-15T08:00:00.000Z')`,
    )
    runMigrations(db)
    const row = db.query<{ created_at: string }, []>('SELECT created_at FROM emails').get()!
    expect(row.created_at).toBe('2026-09-15T07:15:57.115Z')
  })
})

describe('migration 4', () => {
  test('adds the Jev shadow columns to submissions and email_enrichments', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const columns = (table: string) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)

    expect(columns('submissions')).toEqual(
      expect.arrayContaining(['llm_latency_ms', 'jev_verdict', 'jev_error']),
    )
    expect(columns('email_enrichments')).toEqual(
      expect.arrayContaining(['jev_spam_probability', 'jev_category']),
    )
  })

  test('v3 → v4 keeps existing rows with NULL jev_* columns', () => {
    const db = new Database(':memory:')
    runMigrations(db, { targetVersion: 3 })
    db.run(
      `INSERT INTO submissions (id, received_at, source, verdict, confidence, reason, delivered, submission)
       VALUES ('s1', '2026-09-15T08:00:00.000Z', 'fpp', 'legit', 0.9, 'r', 1, '{}')`,
    )
    db.run(
      `INSERT INTO emails (id, direction, from_address, to_addresses, subject, created_at, attachments, synced_at)
       VALUES ('e1', 'inbound', 'a@example.com', '[]', 's', '2026-09-15T07:00:00.000Z', '[]', '2026-09-15T08:00:00.000Z')`,
    )
    db.run(
      `INSERT INTO email_enrichments (email_id, status, attempts, updated_at)
       VALUES ('e1', 'pending', 0, '2026-09-15T08:00:00.000Z')`,
    )

    runMigrations(db)

    expect(
      db
        .query<Record<string, unknown>, []>(
          'SELECT llm_latency_ms, jev_verdict, jev_confidence, jev_probabilities, jev_latency_ms, jev_model, jev_error FROM submissions',
        )
        .get(),
    ).toEqual({
      llm_latency_ms: null,
      jev_verdict: null,
      jev_confidence: null,
      jev_probabilities: null,
      jev_latency_ms: null,
      jev_model: null,
      jev_error: null,
    })
    expect(
      db
        .query<Record<string, unknown>, []>(
          'SELECT jev_spam_probability, jev_category, jev_category_confidence, jev_latency_ms, jev_model, jev_error FROM email_enrichments',
        )
        .get(),
    ).toEqual({
      jev_spam_probability: null,
      jev_category: null,
      jev_category_confidence: null,
      jev_latency_ms: null,
      jev_model: null,
      jev_error: null,
    })
  })
})

describe('migration 5', () => {
  test('backfills existing rows as provider resend', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    db.run(
      `INSERT INTO emails (id, direction, from_address, to_addresses, subject, created_at, attachments, synced_at)
       VALUES ('e1', 'inbound', 'a@example.com', '[]', 's', '2026-09-15T07:15:57.115Z', '[]', '2026-09-15T08:00:00.000Z')`,
    )
    const row = db
      .query<{ provider: string; mailbox: string | null }, []>(
        'SELECT provider, mailbox FROM emails',
      )
      .get()!
    expect(row).toEqual({ provider: 'resend', mailbox: null })
  })
})

describe('migration 6', () => {
  function seedV5() {
    const db = new Database(':memory:')
    runMigrations(db, { targetVersion: 5 })

    const submission = (id: string, jev: string) =>
      db.run(
        `INSERT INTO submissions (id, received_at, source, verdict, confidence, reason, delivered, submission,
           jev_verdict, jev_confidence, jev_latency_ms, jev_model, jev_error)
         VALUES ('${id}', '2026-09-15T08:00:00.000Z', 'fpp', 'legit', 0.9, 'r', 1, '{"message":"hi"}', ${jev})`,
      )
    submission('s_none', 'NULL, NULL, NULL, NULL, NULL')
    submission('s_ok', "'spam', 0.9, 800, 'jev', NULL")
    submission('s_err', "NULL, NULL, 30, 'jev', 'gateway 429'")
    // Error/model set but no verdict: still not a successful result.
    submission('s_model_only', "NULL, NULL, NULL, 'jev', NULL")

    const email = (id: string, direction: string) => {
      db.run(
        `INSERT INTO emails (id, direction, from_address, to_addresses, subject, created_at, attachments, synced_at)
         VALUES ('${id}', '${direction}', 'a@example.com', '[]', 's', '2026-09-15T07:00:00.000Z', '[]', '2026-09-15T08:00:00.000Z')`,
      )
    }
    const enrichment = (id: string, jev: string) =>
      db.run(
        `INSERT INTO email_enrichments (email_id, status, attempts, updated_at,
           jev_spam_probability, jev_category, jev_category_confidence, jev_latency_ms, jev_model, jev_error)
         VALUES ('${id}', 'done', 1, '2026-09-15T08:00:00.000Z', ${jev})`,
      )
    email('in_none', 'inbound')
    enrichment('in_none', 'NULL, NULL, NULL, NULL, NULL, NULL')
    email('in_ok', 'inbound')
    enrichment('in_ok', "0.1, 'inquiry', 0.8, 400, 'jev', NULL")
    email('in_err', 'inbound')
    enrichment('in_err', "NULL, NULL, NULL, 30, 'jev', 'gateway 429'")
    email('out_1', 'outbound')
    enrichment('out_1', 'NULL, NULL, NULL, NULL, NULL, NULL')
    // Inbound email whose enrichment row was lost.
    email('in_orphan', 'inbound')

    runMigrations(db)
    return db
  }

  test('adds the queue columns to both tables', () => {
    const db = seedV5()
    const columns = (table: string) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)

    for (const table of ['submissions', 'email_enrichments']) {
      expect(columns(table)).toEqual(
        expect.arrayContaining([
          'jev_status',
          'jev_attempts',
          'jev_next_attempt_at',
          'jev_claimed_at',
        ]),
      )
    }
  })

  test('backfills submissions: no or failed result → pending, successful → done', () => {
    const db = seedV5()
    const rows = db
      .query<Record<string, unknown>, []>(
        'SELECT id, jev_status, jev_attempts, jev_verdict, jev_model, jev_error FROM submissions ORDER BY id',
      )
      .all()

    expect(rows).toEqual([
      {
        id: 's_err',
        jev_status: 'pending',
        jev_attempts: 0,
        jev_verdict: null,
        jev_model: null,
        jev_error: null,
      },
      {
        id: 's_model_only',
        jev_status: 'pending',
        jev_attempts: 0,
        jev_verdict: null,
        jev_model: null,
        jev_error: null,
      },
      {
        id: 's_none',
        jev_status: 'pending',
        jev_attempts: 0,
        jev_verdict: null,
        jev_model: null,
        jev_error: null,
      },
      {
        id: 's_ok',
        jev_status: 'done',
        jev_attempts: 1,
        jev_verdict: 'spam',
        jev_model: 'jev',
        jev_error: null,
      },
    ])
  })

  test('creates partial indexes on the pending queue rows', () => {
    const db = seedV5()
    const indexes = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE '%jev_status'",
      )
      .all()

    expect(indexes.map((index) => index.name).sort()).toEqual([
      'idx_email_enrichments_jev_status',
      'idx_submissions_jev_status',
    ])
    for (const index of indexes) expect(index.sql).toContain('WHERE')
  })

  test('backfills inbound enrichments pending/done, outbound NULL, and creates a lost row', () => {
    const db = seedV5()
    const rows = db
      .query<Record<string, unknown>, []>(
        'SELECT email_id, jev_status, jev_category, jev_error FROM email_enrichments ORDER BY email_id',
      )
      .all()

    expect(rows).toEqual([
      {
        email_id: 'in_err',
        jev_status: 'pending',
        jev_category: null,
        jev_error: null,
      },
      {
        email_id: 'in_none',
        jev_status: 'pending',
        jev_category: null,
        jev_error: null,
      },
      {
        email_id: 'in_ok',
        jev_status: 'done',
        jev_category: 'inquiry',
        jev_error: null,
      },
      {
        email_id: 'in_orphan',
        jev_status: 'pending',
        jev_category: null,
        jev_error: null,
      },
      {
        email_id: 'out_1',
        jev_status: null,
        jev_category: null,
        jev_error: null,
      },
    ])
  })
})
