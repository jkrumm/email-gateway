import { describe, expect, test } from 'bun:test'
import { render } from 'react-email'
import ShutterflowCodeMail, {
  SHUTTERFLOW_CODE_KINDS,
  type ShutterflowCodeKind,
  shutterflowCodeSubject,
} from './code-mail'

describe('ShutterflowCodeMail', () => {
  test.each([...SHUTTERFLOW_CODE_KINDS])(
    '%s carries the code, the expiry and a code-led subject',
    async (kind) => {
      const html = await render(ShutterflowCodeMail({ kind, code: '482913', expiresInMinutes: 7 }))
      expect(html).toContain('482913')
      expect(html).toContain('expires in 7 minutes')
      expect(shutterflowCodeSubject(kind, '482913')).toStartWith('482913 is')
    },
  )

  test('each kind has its own copy', async () => {
    const heading = async (kind: ShutterflowCodeKind) =>
      render(ShutterflowCodeMail({ kind, code: '1234', expiresInMinutes: 5 }))
    expect(await heading('sign-in')).toContain('Sign in to Shutterflow')
    expect(await heading('email-verification')).toContain('Verify your email')
    expect(await heading('forget-password')).toContain('Reset your password')
  })
})
