import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { render } from "react-email";
import {
  emailRegistry,
  TEMPLATE_IDS,
  type EmailTemplateEntry,
} from "./registry";

function testEntryRendersToHtml<Props>(entry: EmailTemplateEntry<Props>) {
  test(`${entry.id} renders to non-empty html`, async () => {
    // Templates are plain synchronous function components; cast away the
    // (async-component-shaped) FunctionComponent return-type union.
    const element = entry.component(entry.previewProps) as ReactElement;
    const html = await render(element);
    expect(html.length).toBeGreaterThan(0);
  });
}

describe("email registry", () => {
  testEntryRendersToHtml(emailRegistry[0]);
  testEntryRendersToHtml(emailRegistry[1]);
  testEntryRendersToHtml(emailRegistry[2]);
  testEntryRendersToHtml(emailRegistry[3]);

  test("every registry entry id comes from TEMPLATE_IDS, and nothing is missing", () => {
    expect(emailRegistry.map((entry) => entry.id).sort()).toEqual(
      Object.values(TEMPLATE_IDS).sort(),
    );
  });
});
