import type { Database } from "bun:sqlite";

export interface ThreadSummary {
  threadKey: string;
  summary: string;
  model: string | null;
  // Display metadata only — never the cache-invalidation source (see
  // latestKey). message_count cannot notice an arrival in a thread longer
  // than one page, since the page length stops changing at the cap.
  messageCount: number;
  latestKey: string | null;
  updatedAt: string;
}

export interface SaveThreadSummaryInput {
  summary: string;
  model?: string | null;
  messageCount: number;
  latestKey: string | null;
}

interface ThreadSummaryRow {
  thread_key: string;
  summary: string;
  model: string | null;
  message_count: number;
  latest_key: string | null;
  updated_at: string;
}

function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  return {
    threadKey: row.thread_key,
    summary: row.summary,
    model: row.model,
    messageCount: row.message_count,
    latestKey: row.latest_key,
    updatedAt: row.updated_at,
  };
}

// Cache of LLM thread summaries (Wave 8) — src/services/agent-api.ts's
// getThreadSummary stores one per thread key (a message's own key when it has
// no threadKey) and only re-runs the LLM once the thread's newest message key
// (latest_key) differs from the cached row.
export function createThreadSummariesRepo(db: Database) {
  function getSummary(threadKey: string): ThreadSummary | null {
    const row = db
      .query<ThreadSummaryRow, [string]>(
        "SELECT * FROM thread_summaries WHERE thread_key = ?",
      )
      .get(threadKey);
    return row ? toThreadSummary(row) : null;
  }

  function saveSummary(threadKey: string, input: SaveThreadSummaryInput): void {
    db.run(
      `INSERT INTO thread_summaries (thread_key, summary, model, message_count, latest_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET
         summary = excluded.summary,
         model = excluded.model,
         message_count = excluded.message_count,
         latest_key = excluded.latest_key,
         updated_at = excluded.updated_at`,
      [
        threadKey,
        input.summary,
        input.model ?? null,
        input.messageCount,
        input.latestKey,
        new Date().toISOString(),
      ],
    );
  }

  return { getSummary, saveSummary };
}

export type ThreadSummariesRepo = ReturnType<typeof createThreadSummariesRepo>;
