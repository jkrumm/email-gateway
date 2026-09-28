import type { Database } from "bun:sqlite";

export interface Template {
  id: string;
  name: string;
  previewProps: Record<string, unknown> | null;
  lastTestSendAt: string | null;
  createdAt: string;
}

export interface UpsertTemplateInput {
  id: string;
  name: string;
  previewProps?: Record<string, unknown> | null;
}

interface TemplateRow {
  id: string;
  name: string;
  preview_props: string | null;
  last_test_send_at: string | null;
  created_at: string;
}

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    previewProps: row.preview_props ? JSON.parse(row.preview_props) : null,
    lastTestSendAt: row.last_test_send_at,
    createdAt: row.created_at,
  };
}

// Registry-driven: src/emails/registry.ts re-runs upsertTemplate on boot to
// stay in sync (that wiring is a later Wave 4 brief, not this one).
export function createTemplatesRepo(db: Database) {
  function upsertTemplate(input: UpsertTemplateInput): void {
    db.run(
      `INSERT INTO templates (id, name, preview_props, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         -- previewProps is optional: an upsert call that omits it (e.g. the
         -- registry re-sync on every boot) must not wipe a previously
         -- recorded value back to NULL.
         preview_props = COALESCE(excluded.preview_props, templates.preview_props)`,
      [
        input.id,
        input.name,
        input.previewProps ? JSON.stringify(input.previewProps) : null,
        new Date().toISOString(),
      ],
    );
  }

  function getTemplate(id: string): Template | null {
    const row = db
      .query<TemplateRow, [string]>("SELECT * FROM templates WHERE id = ?")
      .get(id);
    return row ? toTemplate(row) : null;
  }

  function listTemplates(): Template[] {
    return db
      .query<TemplateRow, []>("SELECT * FROM templates ORDER BY name")
      .all()
      .map(toTemplate);
  }

  function recordTestSend(
    id: string,
    now: string = new Date().toISOString(),
  ): void {
    db.run("UPDATE templates SET last_test_send_at = ? WHERE id = ?", [
      now,
      id,
    ]);
  }

  return { upsertTemplate, getTemplate, listTemplates, recordTestSend };
}

export type TemplatesRepo = ReturnType<typeof createTemplatesRepo>;
