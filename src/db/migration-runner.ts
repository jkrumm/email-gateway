import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  up: string;
}

// Generic runner shared by every migrated schema (src/db/migrations.ts today,
// src/db/mail-migrations.ts for the lean store): reads PRAGMA user_version,
// runs every pending migration in one transaction, and bumps user_version per
// applied migration. Callers own their own ordered, idempotent migrations
// array — never edit a migration that has already shipped.
export function applyMigrations(
  db: Database,
  migrations: Migration[],
  { targetVersion = Infinity }: { targetVersion?: number } = {},
): void {
  const { user_version: currentVersion } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;

  const pending = migrations
    .filter(
      (migration) =>
        migration.version > currentVersion &&
        migration.version <= targetVersion,
    )
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  const applyPending = db.transaction(() => {
    for (const migration of pending) {
      db.run(migration.up);
      // PRAGMA doesn't accept bound parameters; the version is our own
      // integer literal, never user input.
      db.run(`PRAGMA user_version = ${migration.version}`);
    }
  });

  applyPending();
}
