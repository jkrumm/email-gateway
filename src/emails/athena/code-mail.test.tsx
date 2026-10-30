import { describe, expect, test } from 'bun:test'
import { render } from 'react-email'
import AthenaCodeMail, { athenaCodeDisplay, athenaCodeSubject } from './code-mail'
import { redactRendered } from '../../utils/send-body'
import { findTemplateEntry, templateSecrets } from '../registry'

const props = {
  kind: 'sign-in',
  code: '482915',
  expiresInMinutes: 10,
} as const

describe('AthenaCodeMail', () => {
  test('subject and body show the code with a space after three digits', async () => {
    expect(athenaCodeSubject('482915')).toBe('Your Athena code: 482 915')
    expect(athenaCodeDisplay('000123')).toBe('000 123')
    const html = await render(AthenaCodeMail(props))
    expect(html).toContain('482 915')
    expect(html).toContain('expires in 10 minutes')
    expect(html).toContain('If you did not ask for this, ignore it.')
    expect(html).toContain('Johannes Krumm')
  })

  test('themed for light and dark, and carries no link', async () => {
    const html = await render(AthenaCodeMail(props))
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).not.toMatch(/<a[\s>]/i)
    expect(html).not.toMatch(/href=/i)
    // The XHTML doctype is the only URL a render holds.
    expect(html.replace(/<!DOCTYPE[^>]*>/i, '')).not.toMatch(/https?:\/\//i)
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
