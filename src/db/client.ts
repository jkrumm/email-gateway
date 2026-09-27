import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { env } from "../env";
import { runMigrations } from "./migrations";

/**
 * Opens (and migrates) a SQLite database at the given path. Tests pass
 * ":memory:" for an isolated, ephemeral database.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA foreign_keys = ON");
  runMigrations(database);

  return database;
}

let defaultDatabase: Database | null = null;

function getDefaultDatabase(): Database {
  if (!defaultDatabase) {
    // Tests set BEA_DATA_DIR=":memory:" so the default singleton never
    // touches disk; every other value is a directory to store the file in.
    const path =
      env.BEA_DATA_DIR === ":memory:"
        ? ":memory:"
        : join(env.BEA_DATA_DIR, "email-gateway.sqlite");
    defaultDatabase = openDatabase(path);
  }
  return defaultDatabase;
}

// Lazily opened so importing this module (e.g. for types) never touches the
// filesystem — only the first real query does.
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, _receiver) {
    const instance = getDefaultDatabase();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
