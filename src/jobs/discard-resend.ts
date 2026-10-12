import type { Database } from "bun:sqlite";

// Resend is no longer a provider (Wave 15). Migration 5 marks its in-flight
// send_log rows 'failed'; this drops the jobs still pointing at them — pending
// `send` jobs for a provider='resend' row and every `reconcile_send_log` job.
// It lives at boot, not in the migration, because the jobs table is created by
// ensureJobsSchema *after* migrations run and may not exist yet. Run it once
// after both and before the runner claims anything; idempotent, and a no-op
// once no resend row can have a pending job.
export function discardResendJobs(db: Database): number {
  const sends = db.run(
    `DELETE FROM jobs
      WHERE kind = 'send' AND status = 'pending'
        AND json_extract(payload_json, '$.id') IN (
          SELECT id FROM send_log WHERE provider = 'resend'
        )`,
  ).changes;
  const reconciles = db.run(
    `DELETE FROM jobs WHERE kind = 'reconcile_send_log'`,
  ).changes;
  return sends + reconciles;
}
