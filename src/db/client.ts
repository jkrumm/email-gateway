import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { runMigrations } from './migrations'

/**
 * Opens (and migrates) a SQLite database at the given path. Tests pass
 * ":memory:" for an isolated, ephemeral database.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const database = new Database(path, { create: true })
  database.run('PRAGMA journal_mode = WAL')
  database.run('PRAGMA busy_timeout = 5000')
  database.run('PRAGMA foreign_keys = ON')
  runMigrations(database)

  return database
}
