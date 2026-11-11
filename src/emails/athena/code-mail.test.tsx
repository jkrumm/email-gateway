import { describe, expect, test } from 'bun:test'
import { render } from 'react-email'
import AthenaCodeMail, { athenaCodeDisplay, athenaCodeSubject } from './code-mail'
import { athenaDark, athenaLight } from '../../layouts/athena.layout'
import { redactRendered } from '../../utils/send-body'
import { findTemplateEntry, templateSecrets } from '../registry'

const props = {
  kind: 'sign-in',
  code: '482915',
  expiresInMinutes: 10,
} as const

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('AthenaCodeMail', () => {
  test('subject keeps the spaced code, the body spells it once as one token', async () => {
    expect(athenaCodeSubject('482915')).toBe('Your Athena code: 482 915')
    expect(athenaCodeDisplay('000123')).toBe('000 123')
    const html = await render(AthenaCodeMail(props))
    const text = await render(AthenaCodeMail(props), { plainText: true })
    expect(count(html, '482915')).toBe(1)
    expect(count(text, '482915')).toBe(1)
    expect(html).not.toContain('482 915')
    expect(text).not.toContain('482 915')
    expect(html).toContain('valid for 10 minutes')
    expect(text).toContain('valid for 10 minutes')
    expect(html).toContain('ignore this mail')
    expect(html).toMatch(/font-family:ui-monospace/)
    expect(html).toMatch(/letter-spacing:/)
  })

  test('no images, no links, no URLs', async () => {
    const html = await render(AthenaCodeMail(props))
    expect(html).not.toMatch(/<img[\s>]/i)
    expect(html).not.toMatch(/<a[\s>]/i)
    expect(html).not.toMatch(/href=/i)
    expect(html).not.toMatch(/url\(/i)
    // The XHTML doctype is the only URL a render holds.
    expect(html.replace(/<!DOCTYPE[^>]*>/i, '')).not.toMatch(/https?:\/\//i)
  })

  test('declares both colour schemes', async () => {
    const html = await render(AthenaCodeMail(props))
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>')
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark"/>')
    expect(html).toContain('color-scheme:light dark')
    expect(html).toContain('prefers-color-scheme: dark')
    for (const hex of [...Object.values(athenaLight), ...Object.values(athenaDark)]) {
      expect(html.toUpperCase()).toContain(hex.toUpperCase())
    }
  })

  test.each([
    ['light', athenaLight],
    ['dark', athenaDark],
  ])('%s text holds 4.5:1 on its background', (_scheme, p) => {
    for (const fg of [p.ink, p.body, p.muted]) {
      expect(contrast(fg, p.bg)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(p.ink, p.wash)).toBeGreaterThanOrEqual(4.5)
  })

  test('the stored copy has no spelling of the code left', async () => {
    const secrets = templateSecrets(findTemplateEntry('athena-code')!, props)
    const html = await render(AthenaCodeMail(props))
    const text = await render(AthenaCodeMail(props), { plainText: true })
    const stored = redactRendered({ html, text }, secrets)
    for (const copy of [stored.html, stored.text]) {
      expect(copy).not.toContain('482915')
      expect(copy).not.toContain('482 915')
    }
    expect(stored.html).toContain('[redacted]')
  })
})
