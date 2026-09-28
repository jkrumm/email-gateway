import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runBackup, snapshotDatabase } from "./backup";

function seedDb(path: string) {
  const db = new Database(path);
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  db.close();
}

describe("snapshotDatabase", () => {
  test("skips a database that doesn't exist", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    expect(
      snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" }),
    ).toBeNull();
  });

  test("writes a restorable, transactionally consistent snapshot", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));

    const out = snapshotDatabase({
      dataDir,
      name: "mail",
      stamp: "2026-01-01",
    });
    expect(out).toBe(join(dataDir, "backups", "mail-2026-01-01.db"));

    const restored = new Database(out!, { readonly: true });
    expect(restored.query("SELECT * FROM t").all()).toEqual([{ x: 1 }]);
  });

  test("refuses to overwrite an existing stamp", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));
    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" });

    expect(() =>
      snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" }),
    ).toThrow();
  });

  test("prunes to the newest KEEP snapshots, per database name", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));
    seedDb(join(dataDir, "email-gateway.sqlite"));

    for (let day = 1; day <= 5; day++) {
      const stamp = `2026-01-0${day}`;
      snapshotDatabase({ dataDir, name: "mail", stamp, keep: 3 });
      snapshotDatabase({ dataDir, name: "email-gateway", stamp, keep: 3 });
    }

    const files = readdirSync(join(dataDir, "backups")).sort();
    expect(files).toEqual([
      "email-gateway-2026-01-03.db",
      "email-gateway-2026-01-04.db",
      "email-gateway-2026-01-05.db",
      "mail-2026-01-03.db",
      "mail-2026-01-04.db",
      "mail-2026-01-05.db",
    ]);
  });

  test("prunes nothing when the snapshot count is under KEEP", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));

    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01", keep: 3 });
    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-02", keep: 3 });

    const files = readdirSync(join(dataDir, "backups")).sort();
    expect(files).toEqual(["mail-2026-01-01.db", "mail-2026-01-02.db"]);
  });

  test("keep: 0 prunes every snapshot, including the one just written", () => {
    // Regression: `.slice(0, -keep)` with keep === 0 collapses to
    // `.slice(0, -0)` === `.slice(0, 0)`, which prunes nothing — the
    // opposite of what "keep 0" means.
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));

    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01", keep: 0 });

    const files = readdirSync(join(dataDir, "backups")).sort();
    expect(files).toEqual([]);
  });

  test("sweeps a stale .tmp left by a killed run before snapshotting", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));
    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" });
    writeFileSync(
      join(dataDir, "backups", "mail-2026-01-01.db.tmp"),
      "truncated",
    );

    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-02" });

    const files = readdirSync(join(dataDir, "backups")).sort();
    expect(files).toEqual(["mail-2026-01-01.db", "mail-2026-01-02.db"]);
  });

  test("leaves no .tmp file behind after a successful snapshot", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));

    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" });

    const files = readdirSync(join(dataDir, "backups"));
    expect(files.every((file) => !file.endsWith(".tmp"))).toBe(true);
  });
});

describe("runBackup", () => {
  test("snapshots every database present and returns the count", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));
    seedDb(join(dataDir, "email-gateway.sqlite"));

    expect(runBackup({ dataDir, stamp: "2026-01-01" })).toBe(2);
    expect(readdirSync(join(dataDir, "backups")).sort()).toEqual([
      "email-gateway-2026-01-01.db",
      "mail-2026-01-01.db",
    ]);
  });

  test("throws when no database is found in dataDir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    expect(() => runBackup({ dataDir, stamp: "2026-01-01" })).toThrow();
  });

  test("a failure on one database doesn't skip the rest", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "backup-test-"));
    seedDb(join(dataDir, "mail.sqlite"));
    seedDb(join(dataDir, "email-gateway.sqlite"));
    // Force "mail" (the first entry DATABASES iterates) to collide and throw.
    snapshotDatabase({ dataDir, name: "mail", stamp: "2026-01-01" });

    expect(runBackup({ dataDir, stamp: "2026-01-01" })).toBe(1);
    expect(readdirSync(join(dataDir, "backups")).sort()).toEqual([
      "email-gateway-2026-01-01.db",
      "mail-2026-01-01.db",
    ]);
  });
});
