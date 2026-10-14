import type { Database } from "bun:sqlite";

// How long a dispatched send's rendered mail is kept for review. The
// prune_send_bodies job (src/jobs/prune-send-bodies.ts) enforces it.
export const SEND_BODY_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface SendBody {
  sendId: string;
  html: string;
  text: string;
  createdAt: string;
}

export interface SaveSendBodyInput {
  sendId: string;
  html: string;
  text: string;
}

interface SendBodyRow {
  send_id: string;
  html: string;
  text: string;
  created_at: string;
}

// The rendered mail of one dispatched send (migration 8), keyed by the
// send_log row id. Callers store it already redacted
// (src/utils/send-body.ts) — this repo keeps whatever it is given. Never
// logged anywhere.
export function createSendBodiesRepo(db: Database) {
  // Upsert, not ignore: a retried save of the same send keeps one copy and
  // the first created_at, the retention anchor.
  function save({ sendId, html, text }: SaveSendBodyInput): void {
    db.run(
      `INSERT INTO send_bodies (send_id, html, text, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(send_id) DO UPDATE SET html = excluded.html, text = excluded.text`,
      [sendId, html, text, new Date().toISOString()],
    );
  }

  function get(sendId: string): SendBody | null {
    const row = db
      .query<SendBodyRow, [string]>(
        "SELECT * FROM send_bodies WHERE send_id = ?",
      )
      .get(sendId);
    if (!row) return null;
    return {
      sendId: row.send_id,
      html: row.html,
      text: row.text,
      createdAt: row.created_at,
    };
  }

  // Deletes every body stored before `iso`. Returns how many.
  function pruneOlderThan(iso: string): number {
    return db.run("DELETE FROM send_bodies WHERE created_at < ?", [iso])
      .changes;
  }

  return { save, get, pruneOlderThan };
}

export type SendBodiesRepo = ReturnType<typeof createSendBodiesRepo>;
