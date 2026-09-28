import { templatesRepo as defaultTemplates } from "../db/mail-index";
import type { TemplatesRepo } from "../db/templates";
import { emailRegistry } from "./registry";

// Pushes the code registry (src/emails/registry.ts) into the `templates`
// table on every boot, so the DB can never drift from the components that
// actually render. A plain importable function — not gated on NODE_ENV — so
// it is independently testable against an in-memory repo.
export function syncTemplateRegistry(
  repo: Pick<TemplatesRepo, "upsertTemplate"> = defaultTemplates,
): void {
  for (const entry of emailRegistry) {
    repo.upsertTemplate({
      id: entry.id,
      name: entry.name,
      previewProps: entry.previewProps as unknown as Record<string, unknown>,
    });
  }
}
