import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMailMigrations } from './mail-migrations'

describe('mail migration 5', () => {
  function count(db: Database, table: string): number {
    return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count
  }

  function seedAccount(
    db: Database,
    provider: string,
    address: string,
    threadKey: string | null,
  ): void {
    const now = '2026-09-28T08:00:00.000Z'
    const account = `${provider}:${address}`
    const key = `msg-${provider}`
    db.run(`INSERT INTO accounts (id, provider, address, created_at) VALUES (?, ?, ?, ?)`, [
      account,
      provider,
      address,
      now,
    ])
    db.run(
      `INSERT INTO messages (key, account, direction, to_addresses, date, thread_key, created_at, updated_at)
       VALUES (?, ?, 'inbound', '[]', ?, ?, ?, ?)`,
      [key, account, now, `thread-${provider}`, now, now],
    )
    db.run(
      `INSERT INTO message_locations (key, mailbox, provider_ref, last_seen_at) VALUES (?, 'INBOX', '{}', ?)`,
      [key, now],
    )
    db.run(`INSERT INTO classifications (key, updated_at) VALUES (?, ?)`, [key, now])
    db.run(`INSERT INTO body_cache (key, fetched_at) VALUES (?, ?)`, [key, now])
    db.run(
      `INSERT INTO messages_fts (subject, addresses, summary, message_key) VALUES ('s', 'a', 'x', ?)`,
      [key],
    )
    if (threadKey) {
      db.run(
        `INSERT INTO thread_summaries (thread_key, summary, message_count, updated_at) VALUES (?, 'sum', 1, ?)`,
        [threadKey, now],
      )
    }
    db.run(
      `INSERT INTO thread_summaries (thread_key, summary, message_count, updated_at) VALUES (?, 'sum', 1, ?)`,
      [key, now],
    )
  }

  function seedSendLog(
    db: Database,
    id: string,
    provider: string,
    status: string | null,
    providerMessageId: string | null = null,
  ): void {
    db.run(
      `INSERT INTO send_log (id, recipients, provider, provider_message_id, status, requested_by, created_at, updated_at)
       VALUES (?, '[]', ?, ?, ?, 'route', '2026-09-28T08:00:00.000Z', '2026-09-28T08:00:00.000Z')`,
      [id, provider, providerMessageId, status],
    )
  }

  function sendLogStatuses(db: Database): Record<string, string | null> {
    return Object.fromEntries(
      db
        .query<{ id: string; status: string | null }, []>('SELECT id, status FROM send_log')
        .all()
        .map((row) => [row.id, row.status]),
    )
  }

  test("deletes the resend account's data and keeps other accounts", () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    runMailMigrations(db, { targetVersion: 4 })
    seedAccount(db, 'resend', 'app', null)
    seedAccount(db, 'proton', 'hello@example.com', 'thread-proton')
    seedSendLog(db, 's1', 'resend', 'delivered', 're_1')

    runMailMigrations(db)

    expect(db.query<{ id: string }, []>('SELECT id FROM accounts').all()).toEqual([
      { id: 'proton:hello@example.com' },
    ])
    expect(db.query<{ key: string }, []>('SELECT key FROM messages').all()).toEqual([
      { key: 'msg-proton' },
    ])
    for (const table of ['message_locations', 'classifications', 'body_cache', 'messages_fts']) {
      expect(count(db, table)).toBe(1)
    }
    expect(
      db
        .query<{ thread_key: string }, []>(
          'SELECT thread_key FROM thread_summaries ORDER BY thread_key',
        )
        .all(),
    ).toEqual([{ thread_key: 'msg-proton' }, { thread_key: 'thread-proton' }])
    expect(count(db, 'send_log')).toBe(1)
  })

  test('fails in-flight resend sends, leaves finished and non-resend rows alone', () => {
    const db = new Database(':memory:')
    runMailMigrations(db, { targetVersion: 4 })
    seedSendLog(db, 'queued', 'resend', null)
    seedSendLog(db, 'claimed', 'resend', 'sending')
    seedSendLog(db, 'sent', 'resend', 'sent', 're_1')
    seedSendLog(db, 'bounced', 'resend', 'bounced', 're_2')
    seedSendLog(db, 'ses-queued', 'ses', null)

    runMailMigrations(db)

    expect(sendLogStatuses(db)).toEqual({
      queued: 'failed',
      claimed: 'failed',
      sent: 'sent',
      bounced: 'bounced',
      'ses-queued': null,
    })
  })

  test('drops the reconcile index', () => {
    const db = new Database(':memory:')
    runMailMigrations(db, { targetVersion: 4 })
    const indexNames = () =>
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => row.name)
    expect(indexNames()).toContain('idx_send_log_provider_updated_at')

    runMailMigrations(db)

    expect(indexNames()).not.toContain('idx_send_log_provider_updated_at')
  })
})

describe('mail migration 6', () => {
  const insert = (db: Database, id: string, source: string) =>
    db.run(
      `INSERT INTO submissions (id, received_at, source, verdict, confidence, reason, delivered, submission)
       VALUES (?, '2026-10-13T08:00:00.000Z', ?, 'legit', 1, 'ok', 1, '{}')`,
      [id, source],
    )

  test('keeps existing submissions and accepts the jkrumm-contact source', () => {
    const db = new Database(':memory:')
    runMailMigrations(db, { targetVersion: 5 })
    insert(db, 'old', 'fpp')
    expect(() => insert(db, 'new', 'jkrumm-contact')).toThrow()

    runMailMigrations(db)

    insert(db, 'new', 'jkrumm-contact')
    const rows = db.query<{ id: string }, []>('SELECT id FROM submissions ORDER BY id').all()
    expect(rows.map((row) => row.id)).toEqual(['new', 'old'])
    expect(() => insert(db, 'bad', 'other')).toThrow()
  })

  test('round-trips every column', () => {
    const db = new Database(':memory:')
    runMailMigrations(db, { targetVersion: 5 })
    db.run(
      `INSERT INTO submissions VALUES ('r', '2026-10-13T08:00:00.000Z', 'fpp', 'spam', 0.8, 'why', 'mod', 0, '{"a":1}', 42, 'legit', 0.6, '{"legit":0.6}', 7, 'jev', 'err')`,
    )
    const before = db.query('SELECT * FROM submissions').all()

    runMailMigrations(db)

    expect(db.query('SELECT * FROM submissions').all()).toEqual(before)
  })

  test('recreates the submissions indexes', () => {
    const db = new Database(':memory:')
    runMailMigrations(db)
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'submissions'",
      )
      .all()
      .map((row) => row.name)
    expect(names).toContain('idx_submissions_received_at')
    expect(names).toContain('idx_submissions_verdict')
  })
})

describe('mail migrations 7-9 (Wave 18)', () => {
  test('keeps send_log rows and adds the bounce columns, null for old rows', () => {
    const db = new Database(':memory:')
    runMailMigrations(db, { targetVersion: 6 })
    db.run(
      `INSERT INTO send_log (id, recipients, provider, requested_by, created_at, updated_at)
       VALUES ('old', '[]', 'ses', 'route', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )

    runMailMigrations(db)

    expect(
      db
        .query("SELECT bounce_type, bounce_subtype, diagnostic_code FROM send_log WHERE id = 'old'")
        .get(),
    ).toEqual({
      bounce_type: null,
      bounce_subtype: null,
      diagnostic_code: null,
    })
  })

  test('send_events rejects a duplicate (send_id, event_type, occurred_at)', () => {
    const db = new Database(':memory:')
    runMailMigrations(db)
    const insert = (occurredAt: string) =>
      db.run(
        `INSERT INTO send_events (send_id, event_type, occurred_at, received_at)
         VALUES ('s1', 'Delivery', ?, '2026-10-14T00:00:00.000Z')`,
        [occurredAt],
      )

    insert('2026-10-14T08:00:00.000Z')
    expect(() => insert('2026-10-14T08:00:00.000Z')).toThrow()
    expect(() => insert('2026-10-14T08:00:01.000Z')).not.toThrow()
  })

  test('ses_account holds a single row', () => {
    const db = new Database(':memory:')
    runMailMigrations(db)

    db.run("INSERT INTO ses_account (id, data, fetched_at) VALUES (1, '{}', 'now')")

    expect(() =>
      db.run("INSERT INTO ses_account (id, data, fetched_at) VALUES (2, '{}', 'now')"),
    ).toThrow()
  })

  test('send_bodies is keyed by the send id', () => {
    const db = new Database(':memory:')
    runMailMigrations(db)
    const insert = () =>
      db.run(
        "INSERT INTO send_bodies (send_id, html, text, created_at) VALUES ('s1', 'h', 't', 'now')",
      )

    insert()
    expect(insert).toThrow()
  })
})
