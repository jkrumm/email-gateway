import { adminResend as defaultResendClient } from "../utils/resend";
import { sendLogRepo as defaultSendLog } from "../db/mail-index";
import type { SendLogRepo } from "../db/send-log";
import { errorMessage } from "../utils/error";
import type { JobHandler } from "./runner";

// Rows per pass. The job re-runs on the same 5-minute timer as sync_tick, so
// a large backlog drains across successive passes rather than blowing up one
// Resend history read.
const RECONCILE_BATCH_LIMIT = 25;

// rules/agent-limits.md's no-timeout policy is for agent-style LLM work; a
// plain non-LLM HTTP call is explicitly carved out (its own "not covered"
// list), and this one runs inside runner.ts's single serial drain() loop —
// an unbounded hang here would stall sync_tick/classify/jev/send behind it.
const RESEND_GET_TIMEOUT_MS = 10_000;

// resend@6.28.1's emails.get(id) takes no options at all — no AbortSignal,
// no fetch override — so there is no way to cancel the underlying HTTP
// request once started. This only stops *awaiting* it: a hung call keeps its
// socket open in the background past the timeout. The batch is capped at
// RECONCILE_BATCH_LIMIT, so the worst case is bounded (at most that many
// dangling requests added per 5-minute pass, not unbounded growth) rather
// than a real fix — a real fix needs bypassing the SDK with a raw,
// abortable `fetch()` against Resend's REST API, which is more surface than
// one reconciliation job's read path warrants today.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

// Reads back the provider's own delivery state for send_log rows that never
// advanced past a non-terminal status, and writes it onto the row. Never
// throws for a single row: one stale/unknown id must not abort the whole
// batch. A row whose read fails still gets recordProviderResult({}) — a
// no-op patch that only bumps updated_at — so listReconcilable's
// oldest-updated-first ordering rotates it to the back of the queue instead
// of the same failing rows filling every batch forever (this is exactly what
// happens whenever RESEND_ADMIN_API_KEY is unset and adminResend falls back
// to the restricted send-only key, per src/utils/resend.ts).
export function createReconcileSendLogHandler({
  resendClient = defaultResendClient,
  sendLog = defaultSendLog,
  timeoutMs = RESEND_GET_TIMEOUT_MS,
}: {
  resendClient?: Pick<typeof defaultResendClient, "emails">;
  sendLog?: Pick<SendLogRepo, "listReconcilable" | "recordProviderResult">;
  timeoutMs?: number;
} = {}): JobHandler {
  return async () => {
    const rows = sendLog.listReconcilable({
      provider: "resend",
      limit: RECONCILE_BATCH_LIMIT,
    });

    for (const row of rows) {
      const providerMessageId = row.providerMessageId;
      if (!providerMessageId) continue;

      try {
        const response = await withTimeout(
          resendClient.emails.get(providerMessageId),
          timeoutMs,
        );
        if (response.error) throw new Error(response.error.message);

        sendLog.recordProviderResult(row.id, {
          status: response.data.last_event,
          lastEvent: response.data.last_event,
        });
      } catch (error) {
        console.error("[reconcile_send_log] failed to refresh a send_log row", {
          error: errorMessage(error),
          id: row.id,
          providerMessageId,
        });
        // Bump updated_at even on failure (a no-op status/lastEvent patch)
        // so this row rotates to the back of the oldest-first queue instead
        // of clogging every future batch. Guarded on its own: a DB error
        // here must not abort the rest of the batch either.
        try {
          sendLog.recordProviderResult(row.id, {});
        } catch (touchError) {
          console.error(
            "[reconcile_send_log] failed to rotate a stuck send_log row",
            { error: errorMessage(touchError), id: row.id },
          );
        }
      }
    }
  };
}
