import { Text } from 'react-email'
import AthenaLayout, { athenaColors as c, athenaFonts } from '../../layouts/athena.layout'

export const ATHENA_CODE_KINDS = ['sign-in'] as const

export type AthenaCodeKind = (typeof ATHENA_CODE_KINDS)[number]

export interface AthenaCodeProps {
  kind: AthenaCodeKind
  code: string
  expiresInMinutes: number
}

// "482915" -> "482 915": the form people read aloud and the subject shows.
export function athenaCodeDisplay(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

export function athenaCodeSubject(code: string): string {
  return `Your Athena code: ${athenaCodeDisplay(code)}`
}

// Everything in a rendered mail that spells the code: the stored copy must
// replace each of them (the registry's `redact`).
export function athenaCodeSecrets(code: string): string[] {
  return [code, athenaCodeDisplay(code)]
}

export default function AthenaCodeMail({ code, expiresInMinutes }: AthenaCodeProps) {
  const lineStyle = {
    fontSize: '16px',
    lineHeight: '24px',
    margin: '0 0 12px',
  }

  return (
    // The preview line leaves the code out: the code appears once in the body.
    <AthenaLayout preview="Your Athena sign-in code">
      <Text className="at-ink" style={{ ...lineStyle, color: c.ink, fontWeight: 600 }}>
        Your Athena sign-in code
      </Text>
      <Text
        className="at-code at-ink"
        style={{
          fontFamily: athenaFonts.mono,
          fontSize: '32px',
          lineHeight: '40px',
          fontWeight: 700,
          letterSpacing: '0.3em',
          color: c.ink,
          backgroundColor: c.wash,
          border: `1px solid ${c.border}`,
          borderRadius: '8px',
          padding: '16px 20px',
          margin: '0 0 20px',
          textAlign: 'center',
          userSelect: 'all',
        }}
      >
        {code}
      </Text>
      <Text className="at-body" style={{ ...lineStyle, color: c.body }}>
        {`This code is valid for ${expiresInMinutes} minutes.`}
      </Text>
      <Text className="at-muted" style={{ ...lineStyle, fontSize: '14px', color: c.muted }}>
        If you did not ask for this, ignore this mail.
      </Text>
    </AthenaLayout>
  )
}

AthenaCodeMail.PreviewProps = {
  kind: 'sign-in',
  code: '482915',
  expiresInMinutes: 10,
} satisfies AthenaCodeProps
