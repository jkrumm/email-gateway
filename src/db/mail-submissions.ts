import type { Database } from "bun:sqlite";

// Repo for the new `submissions` table in mail.sqlite (docs/architecture.md
// §Lean store) — distinct from the old src/db/submissions.ts, which stays
// targeting email-gateway.sqlite untouched. Named `mail-submissions.ts` so
// nothing accidentally imports the wrong one. Unlike the old table, this one
// carries no jev_status/jev_attempts/queue columns — that state lives in
// `jobs` (kind `jev_submission`, subject_key = submission id), owned by a
// later brief.

export type SubmissionSource = "fpp" | "sy-serendipity";
export type Verdict = "legit" | "spam" | "marketing";

// The Jev columns as stored; null when Jev hasn't recorded anything yet for
// this submission (no verdict and no error).
export interface MailSubmissionJevResult {
  verdict: Verdict | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  latencyMs: number | null;
  model: string | null;
  error: string | null;
}

export interface SubmissionRecord {
  id: string;
  receivedAt: string;
  source: SubmissionSource;
  verdict: Verdict;
  confidence: number;
  reason: string;
  model: string | null;
  delivered: boolean;
  submission: Record<string, string | number | null>;
  llmLatencyMs: number | null;
  jev: MailSubmissionJevResult | null;
}

export interface InsertSubmissionInput {
  source: SubmissionSource;
  verdict: Verdict;
  confidence: number;
  reason: string;
  model: string | null;
  delivered: boolean;
  submission: Record<string, string | number | null>;
  llmLatencyMs?: number | null;
}

export type SaveJevResultInput =
  | {
      verdict: Verdict;
      confidence: number;
      probabilities: Record<string, number> | null;
      latencyMs: number;
      model: string;
    }
  | { error: string; model?: string };

export interface ListSubmissionsFilters {
  verdict?: Verdict;
  source?: SubmissionSource;
  delivered?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ListSubmissionsResult {
  data: SubmissionRecord[];
  nextCursor: string | null;
}

export interface JevComparison {
  compared: number;
  agreed: number;
  agreementRate: number | null;
  llmMedianLatencyMs: number | null;
  jevMedianLatencyMs: number | null;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

interface SubmissionRow {
  id: string;
  received_at: string;
  source: SubmissionSource;
  verdict: Verdict;
  confidence: number;
  reason: string;
  model: string | null;
  delivered: number;
  submission: string;
  llm_latency_ms: number | null;
  jev_verdict: Verdict | null;
  jev_confidence: number | null;
  jev_probabilities: string | null;
  jev_latency_ms: number | null;
  jev_model: string | null;
  jev_error: string | null;
}

function toSubmissionRecord(row: SubmissionRow): SubmissionRecord {
  const hasJev = row.jev_verdict !== null || row.jev_error !== null;
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
    jev: hasJev
      ? {
          verdict: row.jev_verdict,
          confidence: row.jev_confidence,
          probabilities: row.jev_probabilities
            ? JSON.parse(row.jev_probabilities)
            : null,
          latencyMs: row.jev_latency_ms,
          model: row.jev_model,
          error: row.jev_error,
        }
      : null,
  };
}

function encodeCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}|${id}`, "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex === -1) {
    throw new Error("Invalid cursor");
  }
  return {
    receivedAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function createMailSubmissionsRepo(db: Database) {
  function insertSubmission(input: InsertSubmissionInput): SubmissionRecord {
    const id = crypto.randomUUID();
    const receivedAt = new Date().toISOString();

    db.run(
      `INSERT INTO submissions (
         id, received_at, source, verdict, confidence, reason, model, delivered,
         submission, llm_latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        receivedAt,
        input.source,
        input.verdict,
        input.confidence,
        input.reason,
        input.model,
        input.delivered ? 1 : 0,
        JSON.stringify(input.submission),
        input.llmLatencyMs ?? null,
      ],
    );

    return {
      id,
      receivedAt,
      source: input.source,
      verdict: input.verdict,
      confidence: input.confidence,
      reason: input.reason,
      model: input.model,
      delivered: input.delivered,
      submission: input.submission,
      llmLatencyMs: input.llmLatencyMs ?? null,
      jev: null,
    };
  }

  function getSubmission(id: string): SubmissionRecord | null {
    const row = db
      .query<SubmissionRow, [string]>("SELECT * FROM submissions WHERE id = ?")
      .get(id);
    return row ? toSubmissionRecord(row) : null;
  }

  // Plain column write — no claim/token logic, the job (kind `jev_submission`)
  // owns the retry/backoff state. Called by the job handler once Jev decides,
  // or on terminal failure.
  function saveJevResult(id: string, result: SaveJevResultInput): void {
    if ("error" in result) {
      db.run(
        `UPDATE submissions SET
           jev_verdict = NULL,
           jev_confidence = NULL,
           jev_probabilities = NULL,
           jev_latency_ms = NULL,
           jev_model = ?,
           jev_error = ?
         WHERE id = ?`,
        [result.model ?? null, result.error, id],
      );
      return;
    }

    db.run(
      `UPDATE submissions SET
         jev_verdict = ?,
         jev_confidence = ?,
         jev_probabilities = ?,
         jev_latency_ms = ?,
         jev_model = ?,
         jev_error = NULL
       WHERE id = ?`,
      [
        result.verdict,
        result.confidence,
        result.probabilities ? JSON.stringify(result.probabilities) : null,
        result.latencyMs,
        result.model,
        id,
      ],
    );
  }

  function listSubmissions(
    filters: ListSubmissionsFilters = {},
  ): ListSubmissionsResult {
    const limit = Math.min(
      Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.verdict) {
      conditions.push("verdict = ?");
      params.push(filters.verdict);
    }
    if (filters.source) {
      conditions.push("source = ?");
      params.push(filters.source);
    }
    if (filters.delivered !== undefined) {
      conditions.push("delivered = ?");
      params.push(filters.delivered ? 1 : 0);
    }
    if (filters.cursor) {
      const { receivedAt, id } = decodeCursor(filters.cursor);
      conditions.push("(received_at < ? OR (received_at = ? AND id < ?))");
      params.push(receivedAt, receivedAt, id);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .query<SubmissionRow, (string | number)[]>(
        `SELECT * FROM submissions
         ${where}
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data = page.map(toSubmissionRecord);

    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.receivedAt, last.id) : null;

    return { data, nextCursor };
  }

  // LLM<->Jev agreement plus median latencies over submissions Jev has
  // recorded a verdict for since `since`.
  function getJevComparison({ since }: { since: string }): JevComparison {
    const { compared, agreed } = db
      .query<{ compared: number; agreed: number | null }, [string]>(
        `SELECT COUNT(jev_verdict) AS compared,
                SUM(jev_verdict = verdict) AS agreed
         FROM submissions
         WHERE received_at >= ? AND jev_verdict IS NOT NULL`,
      )
      .get(since)!;

    const latencies = db
      .query<
        { llm_latency_ms: number | null; jev_latency_ms: number },
        [string]
      >(
        `SELECT llm_latency_ms, jev_latency_ms
         FROM submissions
         WHERE received_at >= ? AND jev_latency_ms IS NOT NULL`,
      )
      .all(since);

    return {
      compared,
      agreed: agreed ?? 0,
      agreementRate: compared > 0 ? (agreed ?? 0) / compared : null,
      llmMedianLatencyMs: median(
        latencies.flatMap((row) =>
          row.llm_latency_ms === null ? [] : [row.llm_latency_ms],
        ),
      ),
      jevMedianLatencyMs: median(latencies.map((row) => row.jev_latency_ms)),
    };
  }

  return {
    insertSubmission,
    getSubmission,
    saveJevResult,
    listSubmissions,
    getJevComparison,
  };
}

export type MailSubmissionsRepo = ReturnType<typeof createMailSubmissionsRepo>;
