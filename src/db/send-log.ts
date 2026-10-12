import type { Database } from "bun:sqlite";
import { JOB_STALE_CLAIM_MS } from "./jobs";

// Status of a row whose send a worker has claimed (claimSend) but not yet
// recorded. Never a provider-reported status; ranks 0 like "sent".
export const SENDING_STATUS = "sending";

// How long a 'sending' claim is honoured before another worker may take it
// over as a crashed worker's. Its own knob, tied to the job-claim window only
// for now.
export const SEND_CLAIM_STALE_MS = JOB_STALE_CLAIM_MS;

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
  // Set when the row is written after the provider already accepted the
  // message (the synchronous route sends); the send job records them later
  // via recordProviderResult instead.
  providerMessageId?: string | null;
  status?: string | null;
  requestedBy: string;
}

export interface RecordProviderResultInput {
  providerMessageId?: string | null;
  status?: string | null;
  lastEvent?: string | null;
}

export interface RecordEventInput {
  status: string;
  lastEvent: string;
}

export interface ListSendLogFilters {
  templateId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListReconcilableInput {
  provider: string;
  limit: number;
}

export interface ListSendLogResult {
  data: SendLogEntry[];
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

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
  ELSE 0 END`;

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
  // (a random UUID for the route sends, a caller-generated id for the send
  // job's enqueue) and this whole pipeline is built around at-least-once retry
  // under the documented two-container deploy overlap — a retried insert of
  // the same row must be a safe no-op, not a UNIQUE constraint error.
  function insertSendLog(input: InsertSendLogInput): void {
    const now = new Date().toISOString();
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

  // A provider event (the SES webhook) for the row it belongs to. The status
  // never regresses: the event applies only when its rank is >= the row's
  // current one, so a late "delivery_delayed" cannot undo "delivered", while
  // an equal-rank event may overwrite (bounce detail after a bounce).
  // Returns rows changed: 0 means no such row or a stale event.
  function recordEventByProviderMessageId(
    provider: string,
    providerMessageId: string,
    event: RecordEventInput,
  ): number {
    return db.run(
      `UPDATE send_log SET status = ?, last_event = ?, updated_at = ?
       WHERE provider = ? AND provider_message_id = ?
         AND ${STATUS_RANK_SQL("?")} >= ${STATUS_RANK_SQL("status")}`,
      [
        event.status,
        event.lastEvent,
        new Date().toISOString(),
        provider,
        providerMessageId,
        event.status,
      ],
    ).changes;
  }

  // Atomic claim of a send before calling the provider: marks the row
  // 'sending' unless it already has a provider message id or another worker
  // holds a fresh claim. A claim older than `staleBefore` (ISO timestamp) is a
  // crashed worker's and may be taken over. One UPDATE, so two containers
  // sharing the SQLite file cannot both win. Returns the `updated_at` stamp it
  // wrote — the claim holder's token for releaseSend — or null when not claimed.
  function claimSend(id: string, staleBefore: string): string | null {
    const stamp = new Date().toISOString();
    const changed = db.run(
      `UPDATE send_log SET status = '${SENDING_STATUS}', updated_at = ?
       WHERE id = ? AND provider_message_id IS NULL
         AND (status IS NULL OR status != '${SENDING_STATUS}' OR updated_at < ?)`,
      [stamp, id, staleBefore],
    ).changes;
    return changed === 1 ? stamp : null;
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

  // Rows a reconciliation pass still has to refresh: a known provider message
  // id whose status has not yet reached a terminal value. Terminal statuses
  // are never rechecked again, so a delivered/bounced/… row leaves this list
  // for good. Oldest-updated first, so successive runs make forward progress
  // instead of repeatedly reading the same head of the queue. A 'sending' row
  // is deliberately excluded: it has no provider message id yet, and once it
  // does, the send result replaces the status.
  function listReconcilable({
    provider,
    limit,
  }: ListReconcilableInput): SendLogEntry[] {
    const capped = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
    return db
      .query<SendLogRow, [string, number]>(
        `SELECT * FROM send_log
         WHERE provider = ?
           AND provider_message_id IS NOT NULL
           AND (status IS NULL OR status IN ('sent', 'queued', 'scheduled', 'delivery_delayed'))
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(provider, capped)
      .map(toSendLogEntry);
  }

  return {
    insertSendLog,
    recordProviderResult,
    recordEventByProviderMessageId,
    claimSend,
    releaseSend,
    listSendLog,
    getSendLog,
    listReconcilable,
  };
}

export type SendLogRepo = ReturnType<typeof createSendLogRepo>;
