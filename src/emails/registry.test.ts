import { describe, expect, test } from 'bun:test'
import { render } from 'react-email'
import {
  emailRegistry,
  findTemplateEntry,
  renderTemplateElement,
  templateSecrets,
  TEMPLATE_IDS,
} from './registry'

function testEntryRendersToHtml(entry: NonNullable<ReturnType<typeof findTemplateEntry>>) {
  test(`${entry.id} renders to non-empty html`, async () => {
    const html = await render(renderTemplateElement(entry))
    expect(html.length).toBeGreaterThan(0)
  })
}

describe('email registry', () => {
  for (const entry of emailRegistry) testEntryRendersToHtml(entry)

  test('every registry entry id comes from TEMPLATE_IDS, and nothing is missing', () => {
    expect(emailRegistry.map((entry) => entry.id).sort()).toEqual(
      Object.values(TEMPLATE_IDS).sort(),
    )
  })

  test('only the code mails name secrets: their auth codes', () => {
    const named = emailRegistry.filter((entry) => entry.redact).map((entry) => entry.id)
    expect(named).toEqual([TEMPLATE_IDS.shutterflowCode, TEMPLATE_IDS.athenaCode])

    const entry = findTemplateEntry(TEMPLATE_IDS.shutterflowCode)!
    expect(
      templateSecrets(entry, {
        kind: 'sign-in',
        code: '482913',
        expiresInMinutes: 10,
      }),
    ).toEqual(['482913'])
    expect(
      templateSecrets(findTemplateEntry(TEMPLATE_IDS.athenaCode)!, {
        kind: 'sign-in',
        code: '482915',
        expiresInMinutes: 10,
      }),
    ).toEqual(['482915', '482 915'])
    expect(templateSecrets(findTemplateEntry(TEMPLATE_IDS.fppSender)!, {})).toEqual([])
  })

  test('templateSecrets throws on an empty or non-string secret', () => {
    const entry = findTemplateEntry(TEMPLATE_IDS.shutterflowCode)!
    expect(() => templateSecrets(entry, { code: '' })).toThrow()
    expect(() => templateSecrets(entry, { code: 482913 })).toThrow()
    expect(() => templateSecrets(entry, {})).toThrow()
    expect(() => templateSecrets(entry, undefined)).toThrow()
  })
})
