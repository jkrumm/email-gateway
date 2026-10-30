import type { Database } from 'bun:sqlite'
import { createJevQueue, type JevClaim, type JevStatus } from './jev-queue'

export type SubmissionSource = 'fpp' | 'sy-serendipity'
export type Verdict = 'legit' | 'spam' | 'marketing'

// A successful Jev call on a submission.
export interface JevSubmissionResult {
  verdict: Verdict
  confidence: number
  probabilities: Record<string, number> | null
  latencyMs: number
  model: string
}

// Jev's shadow verdict as stored on the row. The verdict fields are only set
// when `status` is "done"; `error` is the last failure (pending retry, or
// terminal when "failed").
export interface JevSubmissionView {
  status: JevStatus
  attempts: number
  nextAttemptAt: string | null
  verdict: Verdict | null
  confidence: number | null
  probabilities: Record<string, number> | null
  latencyMs: number | null
  model: string | null
  error: string | null
}

export interface SubmissionRecord {
  id: string
  receivedAt: string
  source: SubmissionSource
  verdict: Verdict
  confidence: number
  reason: string
  model: string | null
  delivered: boolean
  submission: Record<string, string | number | null>
  llmLatencyMs: number | null
  // Null when Jev was disabled at record time.
  jev: JevSubmissionView | null
}

export interface RecordSubmissionInput {
  source: SubmissionSource
  verdict: Verdict
  confidence: number
  reason: string
  model: string | null
  delivered: boolean
  submission: Record<string, string | number | null>
  llmLatencyMs?: number | null
  // Queue the row for the Jev worker (Jev is configured).
  jevPending?: boolean
}

// What the Jev worker needs to judge a claimed submission (`submission` is
// the raw stored JSON).
type ClaimedJevSubmission = JevClaim & {
  source: SubmissionSource
  submission: string
}

export interface ListSubmissionsFilters {
  verdict?: Verdict
  source?: SubmissionSource
  delivered?: boolean
  limit?: number
  cursor?: string
}

export interface JevComparison {
  compared: number
  agreed: number
  agreementRate: number | null
  llmMedianLatencyMs: number | null
  jevMedianLatencyMs: number | null
}

export interface ListSubmissionsResult {
  data: SubmissionRecord[]
  nextCursor: string | null
}

const DEFAULT_LIST_LIMIT = 25
const MAX_LIST_LIMIT = 100

interface SubmissionRow {
  id: string
  received_at: string
  source: SubmissionSource
  verdict: Verdict
  confidence: number
  reason: string
  model: string | null
  delivered: number
  submission: string
  llm_latency_ms: number | null
  jev_verdict: Verdict | null
  jev_confidence: number | null
  jev_probabilities: string | null
  jev_latency_ms: number | null
  jev_model: string | null
  jev_error: string | null
  jev_status: JevStatus | null
  jev_attempts: number
  jev_next_attempt_at: string | null
}

function toSubmissionRecord(row: SubmissionRow): SubmissionRecord {
  return {
    id: row.id,
    receivedAt: row.received_at,
    source: row.source,
    verdict: row.verdict,
    confidence: row.confidence,
    reason: row.reason,
    model: row.model,
    delivered: Boolean(row.delivered),
    submission: JSON.parse(row.submission),
    llmLatencyMs: row.llm_latency_ms,
    jev: row.jev_status
      ? {
          status: row.jev_status,
          attempts: row.jev_attempts,
          nextAttemptAt: row.jev_next_attempt_at,
          verdict: row.jev_verdict,
          confidence: row.jev_confidence,
          probabilities: row.jev_probabilities ? JSON.parse(row.jev_probabilities) : null,
          latencyMs: row.jev_latency_ms,
          model: row.jev_model,
          error: row.jev_error,
        }
      : null,
  }
}

function encodeCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}|${id}`, 'utf-8').toString('base64url')
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
  const separatorIndex = decoded.lastIndexOf('|')
  if (separatorIndex === -1) {
    throw new Error('Invalid cursor')
  }
  return {
    receivedAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  }
}

function pendingJevView(): JevSubmissionView {
  return {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    verdict: null,
    confidence: null,
    probabilities: null,
    latencyMs: null,
    model: null,
    error: null,
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function createSubmissionsRepo(db: Database) {
  function recordSubmission(input: RecordSubmissionInput): SubmissionRecord {
    const { jevPending: _jevPending, ...persisted } = input
    const record: SubmissionRecord = {
      ...persisted,
      llmLatencyMs: input.llmLatencyMs ?? null,
      jev: input.jevPending ? pendingJevView() : null,
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    }

    db.run(
      `INSERT INTO submissions (
         id, received_at, source, verdict, confidence, reason, model, delivered, submission,
         llm_latency_ms, jev_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.receivedAt,
        record.source,
        record.verdict,
        record.confidence,
        record.reason,
        record.model,
        record.delivered ? 1 : 0,
        JSON.stringify(record.submission),
        record.llmLatencyMs,
        record.jev?.status ?? null,
      ],
    )

    return record
  }

  const jevQueue = createJevQueue({
    db,
    table: 'submissions',
    idColumn: 'id',
    orderColumn: 'received_at',
  })

  // Claims the next submission whose Jev verdict is due. `submission` is the
  // raw stored JSON — the worker parses it per row so one bad row can't
  // abort the drain.
  function claimNextJev({ now }: { now?: Date } = {}): ClaimedJevSubmission | null {
    return jevQueue.claimNext<{
      source: SubmissionSource
      submission: string
    }>({ now, extraColumns: ['source', 'submission'] })
  }

  function completeJev({
    id,
    claimToken,
    result,
  }: JevClaim & { result: JevSubmissionResult }): boolean {
    return jevQueue.complete({
      id,
      claimToken,
      result: {
        jev_verdict: result.verdict,
        jev_confidence: result.confidence,
        jev_probabilities: result.probabilities ? JSON.stringify(result.probabilities) : null,
        jev_latency_ms: result.latencyMs,
        jev_model: result.model,
      },
    })
  }

  function listSubmissions(filters: ListSubmissionsFilters = {}): ListSubmissionsResult {
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (filters.verdict) {
      conditions.push('verdict = ?')
      params.push(filters.verdict)
    }
    if (filters.source) {
      conditions.push('source = ?')
      params.push(filters.source)
    }
    if (filters.delivered !== undefined) {
      conditions.push('delivered = ?')
      params.push(filters.delivered ? 1 : 0)
    }
    if (filters.cursor) {
      const { receivedAt, id } = decodeCursor(filters.cursor)
      conditions.push('(received_at < ? OR (received_at = ? AND id < ?))')
      params.push(receivedAt, receivedAt, id)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db
      .query<SubmissionRow, (string | number)[]>(
        `SELECT * FROM submissions
         ${where}
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const data = page.map(toSubmissionRecord)

    const last = data[data.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.receivedAt, last.id) : null

    return { data, nextCursor }
  }

  // LLM↔Jev agreement plus median latencies over submissions Jev judged
  // since `since`.
  function getJevComparison({ since }: { since: string }): JevComparison {
    const { compared, agreed } = db
      .query<{ compared: number; agreed: number | null }, [string]>(
        `SELECT COUNT(jev_verdict) AS compared,
                SUM(jev_verdict = verdict) AS agreed
         FROM submissions
         WHERE received_at >= ? AND jev_status = 'done'`,
      )
      .get(since)!

    const latencies = db
      .query<{ llm_latency_ms: number | null; jev_latency_ms: number }, [string]>(
        `SELECT llm_latency_ms, jev_latency_ms
         FROM submissions
         WHERE received_at >= ? AND jev_status = 'done' AND jev_latency_ms IS NOT NULL`,
      )
      .all(since)

    return {
      compared,
      agreed: agreed ?? 0,
      agreementRate: compared > 0 ? (agreed ?? 0) / compared : null,
      llmMedianLatencyMs: median(
        latencies.flatMap((row) => (row.llm_latency_ms === null ? [] : [row.llm_latency_ms])),
      ),
      jevMedianLatencyMs: median(latencies.map((row) => row.jev_latency_ms)),
    }
  }

  return {
    recordSubmission,
    claimNextJev,
    completeJev,
    failJev: jevQueue.fail,
    jevQueueCounts: jevQueue.counts,
    listSubmissions,
    getJevComparison,
  }
}

export type SubmissionsRepo = ReturnType<typeof createSubmissionsRepo>
