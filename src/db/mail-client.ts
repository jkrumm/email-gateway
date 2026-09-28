import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { env } from "../env";
import { ensureJobsSchema } from "./jobs";
import { runMailMigrations } from "./mail-migrations";

/**
 * Opens (and migrates) the lean `mail.sqlite` database at the given path —
 * the new store from Wave 4 (docs/architecture.md §Lean store), kept
 * alongside the untouched `email-gateway.sqlite` (D4: the old file is
 * abandoned in place, never modified, never deleted by code). Tests pass
 * ":memory:" for an isolated, ephemeral database.
 */
export function openMailDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA foreign_keys = ON");
  runMailMigrations(database);
  ensureJobsSchema(database);

  return database;
}

let defaultMailDatabase: Database | null = null;

function getDefaultMailDatabase(): Database {
  if (!defaultMailDatabase) {
    // Tests set DATA_DIR=":memory:" so the default singleton never
    // touches disk; every other value is a directory to store the file in.
    const path =
      env.DATA_DIR === ":memory:"
        ? ":memory:"
        : join(env.DATA_DIR, "mail.sqlite");
    defaultMailDatabase = openMailDatabase(path);
  }
  return defaultMailDatabase;
}

// Lazily opened so importing this module (e.g. for types) never touches the
// filesystem — only the first real query does. Named `mailDb` (not `db`) so
// both singletons can be imported side by side while the cutover is in flight.
export const mailDb: Database = new Proxy({} as Database, {
  get(_target, prop, _receiver) {
    const instance = getDefaultMailDatabase();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
