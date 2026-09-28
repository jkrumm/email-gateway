import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createTemplatesRepo } from "../db/templates";
import { emailRegistry } from "./registry";
import { syncTemplateRegistry } from "./sync-registry";

describe("syncTemplateRegistry", () => {
  test("upserts every registry entry with its current name and previewProps", () => {
    const templates = createTemplatesRepo(openMailDatabase(":memory:"));

    syncTemplateRegistry(templates);

    for (const entry of emailRegistry) {
      expect(templates.getTemplate(entry.id)).toMatchObject({
        id: entry.id,
        name: entry.name,
        previewProps: entry.previewProps,
      });
    }
  });

  test("a re-run refreshes an existing row's name in place", () => {
    const templates = createTemplatesRepo(openMailDatabase(":memory:"));
    const first = emailRegistry[0];
    templates.upsertTemplate({ id: first.id, name: "stale name" });

    syncTemplateRegistry(templates);

    expect(templates.getTemplate(first.id)?.name).toBe(first.name);
  });
});
