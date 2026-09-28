import type { Database } from "bun:sqlite";

export interface SendLogEntry {
  id: string;
  templateId: string | null;
  recipients: string[];
  provider: string;
  providerMessageId: string | null;
  status: string | null;
  lastEvent: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface InsertSendLogInput {
  id: string;
  templateId?: string | null;
  recipients: string[];
  provider: string;
  requestedBy: string;
}

export interface RecordProviderResultInput {
  providerMessageId?: string | null;
  status?: string | null;
  lastEvent?: string | null;
}

export interface ListSendLogFilters {
  templateId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListSendLogResult {
  data: SendLogEntry[];
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

interface SendLogRow {
  id: string;
  template_id: string | null;
  recipients: string;
  provider: string;
  provider_message_id: string | null;
  status: string | null;
  last_event: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
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
  };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex === -1) {
    throw new Error("Invalid cursor");
  }
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}

export function createSendLogRepo(db: Database) {
  // INSERT OR IGNORE rather than a plain INSERT: `id` is caller-supplied
  // (the Resend message id, or a caller-generated id for a future send job)
  // and this whole pipeline is built around at-least-once retry under the
  // documented two-container deploy overlap — a retried insert of the same
  // row must be a safe no-op, not a UNIQUE constraint error.
  function insertSendLog(input: InsertSendLogInput): void {
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO send_log (id, template_id, recipients, provider, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.templateId ?? null,
        JSON.stringify(input.recipients),
        input.provider,
        input.requestedBy,
        now,
        now,
      ],
    );
  }

  function recordProviderResult(
    id: string,
    patch: RecordProviderResultInput,
  ): void {
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
    );
  }

  // Point lookup by id — used by src/jobs/send.ts's idempotency guard so a
  // retried send job (e.g. after this row's own UPDATE failed with
  // SQLITE_BUSY, per the two-container deploy overlap) can detect an
  // already-sent row and skip calling the provider a second time.
  function getSendLog(id: string): SendLogEntry | null {
    const row = db
      .query<SendLogRow, [string]>("SELECT * FROM send_log WHERE id = ?")
      .get(id);
    return row ? toSendLogEntry(row) : null;
  }

  function listSendLog(filters: ListSendLogFilters = {}): ListSendLogResult {
    const limit = Math.min(
      Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.templateId) {
      conditions.push("template_id = ?");
      params.push(filters.templateId);
    }
    if (filters.cursor) {
      const { createdAt, id } = decodeCursor(filters.cursor);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(createdAt, createdAt, id);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .query<SendLogRow, (string | number)[]>(
        `SELECT * FROM send_log
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data = page.map(toSendLogEntry);

    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return { data, nextCursor };
  }

  return { insertSendLog, recordProviderResult, listSendLog, getSendLog };
}

export type SendLogRepo = ReturnType<typeof createSendLogRepo>;
