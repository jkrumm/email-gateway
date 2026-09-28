import { describe, expect, test } from "bun:test";
import { createTemplatesRepo } from "./templates";
import { openMailDatabase } from "./mail-client";

function setup() {
  return createTemplatesRepo(openMailDatabase(":memory:"));
}

describe("templates repo", () => {
  test("upsertTemplate inserts, then a second call updates name/previewProps in place", () => {
    const templates = setup();
    templates.upsertTemplate({ id: "welcome", name: "Welcome" });
    const first = templates.getTemplate("welcome");

    templates.upsertTemplate({
      id: "welcome",
      name: "Welcome Email",
      previewProps: { firstName: "Jane" },
    });
    const second = templates.getTemplate("welcome");

    expect(second).toMatchObject({
      name: "Welcome Email",
      previewProps: { firstName: "Jane" },
    });
    // created_at is preserved across the re-run.
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  test("getTemplate returns null for an unknown id", () => {
    const templates = setup();
    expect(templates.getTemplate("missing")).toBeNull();
  });

  test("listTemplates returns every template ordered by name", () => {
    const templates = setup();
    templates.upsertTemplate({ id: "b", name: "Bravo" });
    templates.upsertTemplate({ id: "a", name: "Alpha" });

    expect(templates.listTemplates().map((t) => t.name)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });

  test("recordTestSend sets last_test_send_at", () => {
    const templates = setup();
    templates.upsertTemplate({ id: "welcome", name: "Welcome" });
    expect(templates.getTemplate("welcome")?.lastTestSendAt).toBeNull();

    templates.recordTestSend("welcome", "2026-09-28T08:00:00.000Z");
    expect(templates.getTemplate("welcome")?.lastTestSendAt).toBe(
      "2026-09-28T08:00:00.000Z",
    );
  });
});
