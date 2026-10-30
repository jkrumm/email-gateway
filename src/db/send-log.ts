import type { Database } from 'bun:sqlite'
import { JOB_STALE_CLAIM_MS } from './jobs'

// Status of a row whose send a worker has claimed (claimSend) but not yet
// recorded. Never a provider-reported status; ranks 0 like "sent".
const SENDING_STATUS = 'sending'

// How long a 'sending' claim is honoured before another worker may take it
// over as a crashed worker's. Its own knob, tied to the job-claim window only
// for now.
export const SEND_CLAIM_STALE_MS = JOB_STALE_CLAIM_MS

export interface SendLogEntry {
  id: string
  templateId: string | null
  recipients: string[]
  provider: string
  providerMessageId: string | null
  status: string | null
  lastEvent: string | null
  requestedBy: string
  createdAt: string
  updatedAt: string
  // Set by a bounce event (the SES webhook); the diagnostic code never
  // carries an address.
  bounceType: string | null
  bounceSubtype: string | null
  diagnosticCode: string | null
}

export interface InsertSendLogInput {
  id: string
  templateId?: string | null
  recipients: string[]
  provider: string
  // Set when the row is written after the provider already accepted the
  // message (the synchronous route sends); the send job records them later
  // via recordProviderResult instead.
  providerMessageId?: string | null
  status?: string | null
  requestedBy: string
}

export interface RecordProviderResultInput {
  providerMessageId?: string | null
  status?: string | null
  lastEvent?: string | null
}

export interface RecordEventInput {
  status: string
  lastEvent: string
  bounceType?: string
  bounceSubtype?: string
  diagnosticCode?: string
}

// One provider event as the timeline records it. `status` null is a
// timeline-only event (SES "Send"): it never touches send_log.
export interface ProviderEventInput {
  eventType: string
  status: string | null
  lastEvent: string
  occurredAt: string
  bounceType?: string
  bounceSubtype?: string
  diagnosticCode?: string
}

export interface RecordProviderEventOutcome {
  // A send_log row carries this provider message id.
  found: boolean
  // send_log rows whose status the event advanced (0: stale or timeline-only).
  changed: number
  // A new send_events row was written (false for a redelivered event).
  recorded: boolean
}

export interface SendEvent {
  id: number
  sendId: string
  eventType: string
  status: string | null
  bounceType: string | null
  bounceSubtype: string | null
  diagnosticCode: string | null
  occurredAt: string
  receivedAt: string
}

export interface SendStatsBucket {
  // UTC calendar day, YYYY-MM-DD.
  date: string
  templateId: string
  status: string
  count: number
}

export interface SendRates {
  // Sends that reached the provider (have a provider message id).
  sends: number
  // Null when there were no sends.
  bounceRate: number | null
  complaintRate: number | null
}

export interface SendStats {
  days: number
  since: string
  daily: SendStatsBucket[]
  rates: { last7Days: SendRates; last30Days: SendRates }
}

export interface ListSendLogFilters {
  templateId?: string
  limit?: number
  cursor?: string
}

export interface ListSendLogResult {
  data: SendLogEntry[]
  nextCursor: string | null
}

const DEFAULT_LIST_LIMIT = 25
const MAX_LIST_LIMIT = 100

// How far along a delivery a status is, for provider events that can arrive
// out of order: sent/null/anything unranked (0) < delivery_delayed (1) <
// delivered (2) < a terminal failure (3). Referenced twice in the UPDATE
// below, so it lives here once.
const STATUS_RANK_SQL = (column: string) => `CASE ${column}
  WHEN '${SENDING_STATUS}' THEN 0
  WHEN 'delivery_delayed' THEN 1
  WHEN 'delivered' THEN 2
  WHEN 'bounced' THEN 3 WHEN 'complained' THEN 3
  WHEN 'rejected' THEN 3 WHEN 'failed' THEN 3
  ELSE 0 END`

interface SendLogRow {
  id: string
  template_id: string | null
  recipients: string
  provider: string
  provider_message_id: string | null
  status: string | null
  last_event: string | null
  requested_by: string
  created_at: string
  updated_at: string
  bounce_type: string | null
  bounce_subtype: string | null
  diagnostic_code: string | null
}

interface SendEventRow {
  id: number
  send_id: string
  event_type: string
  status: string | null
  bounce_type: string | null
  bounce_subtype: string | null
  diagnostic_code: string | null
  occurred_at: string
  received_at: string
}

const DAY_MS = 24 * 60 * 60_000

function toSendEvent(row: SendEventRow): SendEvent {
  return {
    id: row.id,
    sendId: row.send_id,
    eventType: row.event_type,
    status: row.status,
    bounceType: row.bounce_type,
    bounceSubtype: row.bounce_subtype,
    diagnosticCode: row.diagnostic_code,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  }
}

function toSendLogEntry(row: SendLogRow): SendLogEntry {
  return {
    id: row.id,
    templateId: row.template_id,
    recipients: JSON.parse(row.recipients),
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    status: row.status,
    lastEvent: row.last_event,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bounceType: row.bounce_type,
    bounceSubtype: row.bounce_subtype,
    diagnosticCode: row.diagnostic_code,
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf-8').toString('base64url')
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
  const separatorIndex = decoded.lastIndexOf('|')
  if (separatorIndex === -1) {
    throw new Error('Invalid cursor')
  }
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  }
}

export function createSendLogRepo(db: Database) {
  // INSERT OR IGNORE rather than a plain INSERT: `id` is caller-supplied
  // (a random UUID for the route sends, a caller-generated id for the send
  // job's enqueue) and this whole pipeline is built around at-least-once retry
  // under the documented two-container deploy overlap — a retried insert of
  // the same row must be a safe no-op, not a UNIQUE constraint error.
  function insertSendLog(input: InsertSendLogInput): void {
    const now = new Date().toISOString()
    db.run(
      `INSERT OR IGNORE INTO send_log (id, template_id, recipients, provider, provider_message_id, status, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.templateId ?? null,
        JSON.stringify(input.recipients),
        input.provider,
        input.providerMessageId ?? null,
        input.status ?? null,
        input.requestedBy,
        now,
        now,
      ],
    )
  }

  function recordProviderResult(id: string, patch: RecordProviderResultInput): void {
    db.run(
      `UPDATE send_log SET
         provider_message_id = COALESCE(?, provider_message_id),
         status = COALESCE(?, status),
         last_event = COALESCE(?, last_event),
         updated_at = ?
       WHERE id = ?`,
      [
        patch.providerMessageId ?? null,
        patch.status ?? null,
        patch.lastEvent ?? null,
        new Date().toISOString(),
        id,
      ],
    )
  }

  // A provider event (the SES webhook) for the row it belongs to. The status
  // never regresses: the event applies only when its rank is >= the row's
  // current one, so a late "delivery_delayed" cannot undo "delivered", while
  // an equal-rank event may overwrite (bounce detail after a bounce).
  // Bounce detail is written only when the event carries it (COALESCE), so a
  // later non-bounce event of the same rank cannot blank it.
  // Returns rows changed: 0 means no such row or a stale event.
  function recordEventByProviderMessageId(
    provider: string,
    providerMessageId: string,
    event: RecordEventInput,
  ): number {
    return db.run(
      `UPDATE send_log SET status = ?, last_event = ?, updated_at = ?,
         bounce_type = COALESCE(?, bounce_type),
         bounce_subtype = COALESCE(?, bounce_subtype),
         diagnostic_code = COALESCE(?, diagnostic_code)
       WHERE provider = ? AND provider_message_id = ?
         AND ${STATUS_RANK_SQL('?')} >= ${STATUS_RANK_SQL('status')}`,
      [
        event.status,
        event.lastEvent,
        new Date().toISOString(),
        event.bounceType ?? null,
        event.bounceSubtype ?? null,
        event.diagnosticCode ?? null,
        provider,
        providerMessageId,
        event.status,
      ],
    ).changes
  }

  // The webhook's one write: the status update (when the event implies one)
  // and the send_events timeline row, in one transaction. The timeline row is
  // INSERT OR IGNORE against the (send_id, event_type, occurred_at) unique
  // index, so an SNS redelivery changes nothing; no send_log row for the
  // provider message id writes nothing at all.
  const recordProviderEventTx = db.transaction(
    (
      provider: string,
      providerMessageId: string,
      event: ProviderEventInput,
    ): RecordProviderEventOutcome => {
      const send = db
        .query<{ id: string }, [string, string]>(
          'SELECT id FROM send_log WHERE provider = ? AND provider_message_id = ? LIMIT 1',
        )
        .get(provider, providerMessageId)
      if (!send) return { found: false, changed: 0, recorded: false }

      const changed =
        event.status === null
          ? 0
          : recordEventByProviderMessageId(provider, providerMessageId, {
              ...event,
              status: event.status,
            })
      const recorded =
        db.run(
          `INSERT OR IGNORE INTO send_events (send_id, event_type, status, bounce_type, bounce_subtype, diagnostic_code, occurred_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            send.id,
            event.eventType,
            event.status,
            event.bounceType ?? null,
            event.bounceSubtype ?? null,
            event.diagnosticCode ?? null,
            event.occurredAt,
            new Date().toISOString(),
          ],
        ).changes === 1
      return { found: true, changed, recorded }
    },
  )

  function recordProviderEvent(
    provider: string,
    providerMessageId: string,
    event: ProviderEventInput,
  ): RecordProviderEventOutcome {
    return recordProviderEventTx(provider, providerMessageId, event)
  }

  // A send's timeline, oldest first.
  function listSendEvents(sendId: string): SendEvent[] {
    return db
      .query<SendEventRow, [string]>(
        'SELECT * FROM send_events WHERE send_id = ? ORDER BY occurred_at, id',
      )
      .all(sendId)
      .map(toSendEvent)
  }

  // Deletes every timeline row received before `iso`. Returns how many.
  function pruneEventsOlderThan(iso: string): number {
    return db.run('DELETE FROM send_events WHERE received_at < ?', [iso]).changes
  }

  function ratesSince(since: string): SendRates {
    const row = db
      .query<{ sends: number; bounced: number | null; complained: number | null }, [string]>(
        `SELECT COUNT(*) AS sends,
           SUM(status = 'bounced') AS bounced,
           SUM(status = 'complained') AS complained
         FROM send_log
         WHERE provider_message_id IS NOT NULL AND created_at >= ?`,
      )
      .get(since)!
    if (row.sends === 0) {
      return { sends: 0, bounceRate: null, complaintRate: null }
    }
    return {
      sends: row.sends,
      bounceRate: (row.bounced ?? 0) / row.sends,
      complaintRate: (row.complained ?? 0) / row.sends,
    }
  }

  // Counts per UTC day, template and status over the last `days` days, plus
  // the bounce/complaint rates SES judges an account by (7 and 30 days).
  function getSendStats({ days, now = new Date() }: { days: number; now?: Date }): SendStats {
    const since = new Date(now.getTime() - days * DAY_MS).toISOString()
    const daily = db
      .query<{ date: string; template_id: string; status: string; count: number }, [string]>(
        `SELECT substr(created_at, 1, 10) AS date,
           COALESCE(template_id, 'unknown') AS template_id,
           COALESCE(status, 'pending') AS status,
           COUNT(*) AS count
         FROM send_log WHERE created_at >= ?
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      )
      .all(since)
      .map((row) => ({
        date: row.date,
        templateId: row.template_id,
        status: row.status,
        count: row.count,
      }))
    return {
      days,
      since,
      daily,
      rates: {
        last7Days: ratesSince(new Date(now.getTime() - 7 * DAY_MS).toISOString()),
        last30Days: ratesSince(new Date(now.getTime() - 30 * DAY_MS).toISOString()),
      },
    }
  }

  // Atomic claim of a send before calling the provider: marks the row
  // 'sending' unless it already has a provider message id or another worker
  // holds a fresh claim. A claim older than `staleBefore` (ISO timestamp) is a
  // crashed worker's and may be taken over. One UPDATE, so two containers
  // sharing the SQLite file cannot both win. Returns the `updated_at` stamp it
  // wrote — the claim holder's token for releaseSend — or null when not claimed.
  function claimSend(id: string, staleBefore: string): string | null {
    const stamp = new Date().toISOString()
    const changed = db.run(
      `UPDATE send_log SET status = '${SENDING_STATUS}', updated_at = ?
       WHERE id = ? AND provider_message_id IS NULL
         AND (status IS NULL OR status != '${SENDING_STATUS}' OR updated_at < ?)`,
      [stamp, id, staleBefore],
    ).changes
    return changed === 1 ? stamp : null
  }

  // Gives a failed send's claim back so the retry can claim again. Scoped to
  // the claim holder: the row must still carry this claim's `stamp`, so a
  // late release from a worker whose claim was taken over (and is now sending)
  // clears nothing.
  function releaseSend(id: string, stamp: string): void {
    db.run(
      `UPDATE send_log SET status = NULL, updated_at = ?
       WHERE id = ? AND status = '${SENDING_STATUS}'
         AND provider_message_id IS NULL AND updated_at = ?`,
      [new Date().toISOString(), id, stamp],
    )
  }

  // Point lookup by id — used by src/jobs/send.ts's idempotency guard so a
  // retried send job (e.g. after this row's own UPDATE failed with
  // SQLITE_BUSY, per the two-container deploy overlap) can detect an
  // already-sent row and skip calling the provider a second time.
  function getSendLog(id: string): SendLogEntry | null {
    const row = db.query<SendLogRow, [string]>('SELECT * FROM send_log WHERE id = ?').get(id)
    return row ? toSendLogEntry(row) : null
  }

  function listSendLog(filters: ListSendLogFilters = {}): ListSendLogResult {
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (filters.templateId) {
      conditions.push('template_id = ?')
      params.push(filters.templateId)
    }
    if (filters.cursor) {
      const { createdAt, id } = decodeCursor(filters.cursor)
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(createdAt, createdAt, id)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db
      .query<SendLogRow, (string | number)[]>(
        `SELECT * FROM send_log
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const data = page.map(toSendLogEntry)

    const last = data[data.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null

    return { data, nextCursor }
  }

  return {
    insertSendLog,
    recordProviderResult,
    recordEventByProviderMessageId,
    recordProviderEvent,
    listSendEvents,
    pruneEventsOlderThan,
    getSendStats,
    claimSend,
    releaseSend,
    listSendLog,
    getSendLog,
  }
}

export type SendLogRepo = ReturnType<typeof createSendLogRepo>
