import { describe, expect, test } from "bun:test";
import { render } from "react-email";
import {
  emailRegistry,
  renderTemplateElement,
  TEMPLATE_IDS,
  type findTemplateEntry,
} from "./registry";

function testEntryRendersToHtml(
  entry: NonNullable<ReturnType<typeof findTemplateEntry>>,
) {
  test(`${entry.id} renders to non-empty html`, async () => {
    const html = await render(renderTemplateElement(entry));
    expect(html.length).toBeGreaterThan(0);
  });
}

describe("email registry", () => {
  for (const entry of emailRegistry) testEntryRendersToHtml(entry);

  test("every registry entry id comes from TEMPLATE_IDS, and nothing is missing", () => {
    expect(emailRegistry.map((entry) => entry.id).sort()).toEqual(
      Object.values(TEMPLATE_IDS).sort(),
    );
  });
});
