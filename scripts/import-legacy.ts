/**
 * One-shot copy of the old `email-gateway.sqlite`'s `submissions` table into
 * the new `mail.sqlite` (D4 — docs/architecture.md §Decisions): `submissions`
 * is the one table the lean-store cutover cannot rebuild from the providers,
 * so it gets imported once instead of dropped. Never touches or deletes the
 * old file — the owner deletes it manually once satisfied (D4) — and never
 * runs automatically; invoke it explicitly during the cutover.
 *
 * Safe to re-run: rows are matched by their original id, so a second run is
 * a no-op for anything already imported.
 *
 * Usage: bun run import-legacy
 *        bun run scripts/import-legacy.ts [oldPath] [newPath]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { env } from "../src/env";
import {
  createSubmissionsRepo,
  type SubmissionRecord,
} from "../src/db/submissions";
import { openMailDatabase } from "../src/db/mail-index";
import { createMailSubmissionsRepo } from "../src/db/mail-submissions";
import { createJobQueue, type JobQueue } from "../src/db/jobs";

export interface ImportLegacyResult {
  imported: number;
  alreadyPresent: number;
  // INSERT OR IGNORE suppresses ANY constraint violation, not just the id
  // conflict this script expects — a row counted here means IGNORE silently
  // swallowed something else (a CHECK failure), not that it was already
  // imported. Should stay 0 in practice: the new table's CHECK constraints
  // mirror the old one's.
  rejected: number;
}

type ImportOutcome = "imported" | "alreadyPresent" | "rejected";

// A direct parameterized INSERT rather than mail-submissions.ts's
// insertSubmission(), which always mints a fresh id/receivedAt — the whole
// point of this import is preserving the legacy row's own id and receivedAt
// exactly. INSERT OR IGNORE on the primary key makes a re-run of this script
// a safe no-op for rows already imported — but IGNORE also swallows any other
// constraint violation, so a `changes === 0` result is disambiguated by a
// follow-up existence check rather than assumed to mean "already present".
function importSubmissionRow(
  newDb: Database,
  record: SubmissionRecord,
): ImportOutcome {
  const jev = record.jev;
  const hasJev = jev !== null && (jev.verdict !== null || jev.error !== null);

  const { changes } = newDb.run(
    `INSERT OR IGNORE INTO submissions (
       id, received_at, source, verdict, confidence, reason, model, delivered,
       submission, llm_latency_ms,
       jev_verdict, jev_confidence, jev_probabilities, jev_latency_ms,
       jev_model, jev_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      hasJev ? jev.verdict : null,
      hasJev ? jev.confidence : null,
      hasJev && jev.probabilities ? JSON.stringify(jev.probabilities) : null,
      hasJev ? jev.latencyMs : null,
      hasJev ? jev.model : null,
      hasJev ? jev.error : null,
    ],
  );

  if (changes > 0) return "imported";

  const exists = newDb
    .query<{ found: number }, [string]>(
      "SELECT 1 AS found FROM submissions WHERE id = ?",
    )
    .get(record.id);
  return exists ? "alreadyPresent" : "rejected";
}

// Paginates through every row the old store has via the same repo the app
// used to read it with (createSubmissionsRepo), rather than hand-writing SQL
// against a schema this script doesn't own.
export function importLegacySubmissions({
  oldDb,
  newDb,
  jobs = createJobQueue({
    db: newDb,
    claimedBy: `import-legacy:${process.pid}`,
  }),
}: {
  oldDb: Database;
  newDb: Database;
  jobs?: JobQueue;
}): ImportLegacyResult {
  const oldSubmissions = createSubmissionsRepo(oldDb);
  const newSubmissions = createMailSubmissionsRepo(newDb);

  let imported = 0;
  let alreadyPresent = 0;
  let rejected = 0;
  let cursor: string | undefined;

  do {
    const page = oldSubmissions.listSubmissions({ limit: 100, cursor });
    for (const record of page.data) {
      const outcome = importSubmissionRow(newDb, record);
      if (outcome === "imported") {
        imported++;
      } else if (outcome === "alreadyPresent") {
        alreadyPresent++;
      } else {
        rejected++;
        console.warn(
          `[import-legacy] submission ${record.id} was rejected by a constraint check — not counted as imported or already present`,
        );
        continue;
      }

      // A submission still awaiting Jev's verdict in the old store has no
      // job behind it yet (unlike src/spam/gate.ts's live-insert path, which
      // always enqueues when Jev is enabled) — without this it permanently
      // loses that judgment at cutover. Derived from DURABLE state (still
      // unjudged in the NEW store) rather than "was this row freshly
      // imported this run": if the process crashed after a submission's
      // INSERT committed but before this enqueue call landed, a re-run sees
      // the row as alreadyPresent — checking the new store's own jev state
      // (not "did I just insert this") is what lets that re-run retry the
      // enqueue instead of stranding the row forever. This can enqueue a
      // second jev_submission job for a row whose first job hasn't run yet
      // on an ordinary (non-crash) re-run too — an accepted minor
      // inefficiency for a one-shot migration script, not a correctness
      // bug: a duplicate job for an already-judged submission is a no-op
      // (shadow mode only), and the queue is durable either way.
      //
      // Gated on the VERDICT being absent, not on the whole `jev` object
      // being null: importSubmissionRow's hasJev logic (and the new store's
      // mail-submissions repo) treats a row as having a non-null `jev` the
      // moment EITHER a verdict OR an error is recorded — so a legacy row
      // that is still `status: "pending"` but already carries a `jev_error`
      // from a failed attempt (e.g. the 2026-09-28 429 burst) would import
      // with a non-null `jev` object and silently skip re-enqueue under a
      // `newJev === null` check, stranding it exactly like the crash case
      // above. `newJev.verdict === null` catches that: still pending in the
      // old store, still no real verdict in the new one either.
      const newJev = newSubmissions.getSubmission(record.id)?.jev ?? null;
      if (
        record.jev?.status === "pending" &&
        (newJev === null || newJev.verdict === null)
      ) {
        jobs.enqueue({
          kind: "jev_submission",
          payload: { id: record.id },
          subjectKey: record.id,
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return { imported, alreadyPresent, rejected };
}

if (import.meta.main) {
  const oldPath = process.argv[2] ?? join(env.DATA_DIR, "email-gateway.sqlite");
  const newPath = process.argv[3] ?? join(env.DATA_DIR, "mail.sqlite");

  if (!existsSync(oldPath)) {
    throw new Error(
      `[import-legacy] old database not found at ${oldPath} — refusing to create an empty one`,
    );
  }

  // Read-only: this script's docblock promises to never touch the old file.
  // No migrations run against it — its schema is already whatever it is,
  // and this script only ever reads from it (listSubmissions).
  const oldDb = new Database(oldPath, { readonly: true });
  const newDb = openMailDatabase(newPath);

  const { imported, alreadyPresent, rejected } = importLegacySubmissions({
    oldDb,
    newDb,
  });

  console.log(
    `[import-legacy] submissions: imported ${imported}, already present ${alreadyPresent}, rejected ${rejected}`,
  );

  // `submissions` cannot be rebuilt from the providers (D4) — a partial
  // import silently looking like a complete one is a real data-loss risk.
  // Fail loudly in addition to (not instead of) the summary above.
  if (rejected > 0) {
    throw new Error(
      `[import-legacy] ${rejected} submission(s) were rejected by a constraint check — see the warnings above`,
    );
  }
}
