import { describe, expect, test } from "bun:test";

// src/db/jobs.ts is deliberately schema-neutral (Wave 3): its DDL must never
// run against the production email-gateway.sqlite. That holds only as long
// as nothing on the production boot path imports it — this is a static
// tripwire so an accidental future import fails loudly instead of silently
// creating the jobs table in prod on the next deploy. Matches any import
// specifier ending in `jobs` or `jobs/runner` (word-boundaried, so `jev` and
// similar names don't false-positive) — deliberately including the
// same-directory form (`from "./jobs"`) a developer would naturally write
// inside migrations.ts, which a path-only `db/jobs` pattern would miss.
const IMPORTS_JOBS_MODULE = /\bjobs(?:\/runner)?["']/;

describe("jobs module schema isolation", () => {
  test("src/db/migrations.ts never references the jobs module", async () => {
    const source = await Bun.file(
      new URL("./migrations.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(IMPORTS_JOBS_MODULE);
  });

  test("src/index.ts never boots the jobs module", async () => {
    const source = await Bun.file(
      new URL("../index.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(IMPORTS_JOBS_MODULE);
  });
});
