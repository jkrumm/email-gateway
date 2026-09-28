/**
 * Daily backup — VACUUM INTO a transactionally consistent snapshot of every
 * SQLite file in DATA_DIR (both `mail.sqlite` and, while it still exists,
 * the frozen legacy `email-gateway.sqlite`), then prune each file's own
 * snapshot history to the newest KEEP. `scripts/backup.sh` runs this inside
 * the production container (`docker exec … bun run scripts/backup.ts`) and
 * owns the off-box rsync half — see docs/vps-cutover.md for the cron entry
 * and the tailnet ACL grant it still needs.
 *
 * WHY A SNAPSHOT AND NOT JUST rsync-ing DATA_DIR directly: both databases run
 * WAL-mode SQLite with a live writer (the job runner, IMAP sync) touching
 * them continuously — an rsync of an open database can copy the main file
 * and its `-wal` at different instants, restoring as stale or corrupt with
 * nothing announcing which. VACUUM INTO takes a consistent copy through
 * SQLite itself (readonly source connection, no lock contention with the
 * live writer — matches warden's `scripts/warden-backup.sh`, the pattern
 * this mirrors), so what ships is restorable.
 *
 * Usage: bun run scripts/backup.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { env } from "../src/env";

const KEEP = 7;
// Sortable and filename-safe (no ":" — Windows-hostile, but also just noise
// on the Linux host this actually runs on).
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

// The databases live at DATA_DIR/<name>.sqlite today (src/db/mail-client.ts,
// src/db/client.ts); the legacy one won't exist once the owner deletes it
// per the Wave 9 cutover checklist, so it's skipped rather than required.
const DATABASES = ["mail", "email-gateway"] as const;

// A `.tmp` suffix so a leftover from a killed run (OOM, a RollHook deploy
// tearing the container down mid-cron) never matches the `*.db` glob below —
// it would otherwise occupy a rotation slot and rsync to the homelab target
// looking like a good snapshot. Swept at the start of the next run instead.
function sweepStaleTmp(snapDir: string, prefix: string): void {
  if (!existsSync(snapDir)) return;
  for (const file of readdirSync(snapDir)) {
    if (file.startsWith(prefix) && file.endsWith(".db.tmp")) {
      unlinkSync(join(snapDir, file));
    }
  }
}

export function snapshotDatabase({
  dataDir,
  name,
  stamp,
  keep = KEEP,
}: {
  dataDir: string;
  name: string;
  stamp: string;
  keep?: number;
}): string | null {
  const src = join(dataDir, `${name}.sqlite`);
  if (!existsSync(src)) return null;

  const snapDir = join(dataDir, "backups");
  mkdirSync(snapDir, { recursive: true });
  const prefix = `${name}-`;
  sweepStaleTmp(snapDir, prefix);

  const out = join(snapDir, `${name}-${stamp}.db`);
  const tmpOut = `${out}.tmp`;

  // A colliding stamp must stay a loud error, not a silent clobber — checked
  // explicitly because the rename below (not VACUUM INTO, which only ever
  // targets the fresh .tmp path) is what would otherwise overwrite it.
  if (existsSync(out)) {
    throw new Error(`[backup] snapshot already exists: ${out}`);
  }

  // Readonly: VACUUM INTO needs no write lock on the source, and opening it
  // that way makes the "no lock contention with the live writer" claim above
  // enforced, not just believed.
  const db = new Database(src, { readonly: true });
  try {
    // Written to a .tmp path first and validated before the rename below —
    // a process killed mid-VACUUM (OOM, a deploy tearing the container down)
    // must never leave a truncated file at `out`, filename-indistinguishable
    // from a good snapshot and silently rsynced offsite as one.
    db.query("VACUUM INTO ?").run(tmpOut);
  } finally {
    db.close();
  }

  const check = new Database(tmpOut, { readonly: true });
  let integrityResult: string | undefined;
  try {
    integrityResult = check
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
  } finally {
    check.close();
  }
  if (integrityResult !== "ok") {
    // Never leave a known-bad .tmp on disk waiting for the next run's sweep —
    // a failed check should fail loud, not linger silently until tomorrow.
    unlinkSync(tmpOut);
    throw new Error(
      `[backup] integrity check failed for ${tmpOut}: ${integrityResult ?? "no result"}`,
    );
  }

  renameSync(tmpOut, out);

  // `files.length - keep` rather than `.slice(0, -keep)`: with keep === 0,
  // JS's negative-zero-collapses-to-zero makes `-keep` plain `0`, silently
  // pruning nothing instead of everything.
  const files = readdirSync(snapDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".db"))
    .sort();
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    unlinkSync(join(snapDir, file));
  }

  return out;
}

export function runBackup({
  dataDir,
  stamp,
}: {
  dataDir: string;
  stamp: string;
}): number {
  let snapshotted = 0;
  for (const name of DATABASES) {
    // Isolated per database: a stamp collision or integrity-check failure on
    // one DB must not abort the loop and silently skip every database listed
    // after it — that ordering (today, "mail" happens to run first) is not a
    // guarantee worth depending on.
    try {
      const out = snapshotDatabase({ dataDir, name, stamp });
      if (out) {
        console.log(`[backup] snapshot ${out}`);
        snapshotted++;
      } else {
        console.log(`[backup] no ${name}.sqlite at ${dataDir} — skipped`);
      }
    } catch (error) {
      console.error(`[backup] ${name} snapshot failed:`, error);
    }
  }
  if (snapshotted === 0) {
    throw new Error(
      `[backup] no databases were successfully snapshotted under ${dataDir}`,
    );
  }
  return snapshotted;
}

if (import.meta.main) {
  runBackup({ dataDir: env.DATA_DIR, stamp: STAMP });
}
