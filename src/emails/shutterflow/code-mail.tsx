import { Heading, Section, Text } from 'react-email'
import ShutterflowLayout, {
  shutterflowColors as c,
  shutterflowFonts,
} from '../../layouts/shutterflow.layout'

export const SHUTTERFLOW_CODE_KINDS = ['sign-in', 'email-verification', 'forget-password'] as const

export type ShutterflowCodeKind = (typeof SHUTTERFLOW_CODE_KINDS)[number]

export interface ShutterflowCodeProps {
  kind: ShutterflowCodeKind
  code: string
  expiresInMinutes: number
}

// The sign-in code also creates the account for a new address, so its text has
// to fit both cases: the sender never knows which one it is.
const COPY: Record<
  ShutterflowCodeKind,
  { what: string; heading: string; lead: string; ignore: string }
> = {
  'sign-in': {
    what: 'sign-in code',
    heading: 'Sign in to Shutterflow',
    lead: 'Enter this code in Shutterflow to sign in. New to Shutterflow? The same code creates your account.',
    ignore: "If you didn't try to sign in to Shutterflow, you can ignore this email.",
  },
  'email-verification': {
    what: 'verification code',
    heading: 'Verify your email',
    lead: 'Enter this code in Shutterflow to verify your email address.',
    ignore: "If you didn't create a Shutterflow account, you can ignore this email.",
  },
  'forget-password': {
    what: 'password reset code',
    heading: 'Reset your password',
    lead: 'Enter this code in Shutterflow to choose a new password.',
    ignore: "If you didn't ask to reset your password, you can ignore this email.",
  },
}

// The subject leads with the code so it shows in the notification.
export function shutterflowCodeSubject(kind: ShutterflowCodeKind, code: string): string {
  return `${code} is your Shutterflow ${COPY[kind].what}`
}

export default function ShutterflowCodeMail({
  kind,
  code,
  expiresInMinutes,
}: ShutterflowCodeProps) {
  const { heading, lead, ignore } = COPY[kind]
  const noteStyle = {
    fontSize: '14px',
    lineHeight: '22px',
    color: c.muted,
    margin: '0 0 4px',
  }

  return (
    <ShutterflowLayout preview={shutterflowCodeSubject(kind, code)}>
      <Heading
        as="h1"
        className="sf-ink"
        style={{
          fontSize: '20px',
          lineHeight: '28px',
          fontWeight: 600,
          color: c.ink,
          margin: '0 0 12px',
        }}
      >
        {heading}
      </Heading>
      <Text
        className="sf-body"
        style={{
          fontSize: '16px',
          lineHeight: '24px',
          color: c.body,
          margin: '0 0 16px',
        }}
      >
        {lead}
      </Text>
      <Section style={{ padding: '8px 0 24px' }}>
        <Text
          className="sf-code sf-ink"
          style={{
            display: 'inline-block',
            fontFamily: shutterflowFonts.mono,
            fontSize: '28px',
            lineHeight: '36px',
            fontWeight: 600,
            letterSpacing: '6px',
            color: c.ink,
            backgroundColor: c.bg,
            border: `1px solid ${c.border}`,
            borderRadius: '8px',
            padding: '12px 20px',
            margin: 0,
          }}
        >
          {code}
        </Text>
      </Section>
      <Text className="sf-muted" style={noteStyle}>
        {`The code expires in ${expiresInMinutes} minutes.`}
      </Text>
      <Text className="sf-muted" style={noteStyle}>
        {ignore}
      </Text>
    </ShutterflowLayout>
  )
}

ShutterflowCodeMail.PreviewProps = {
  kind: 'sign-in',
  code: '482913',
  expiresInMinutes: 10,
} satisfies ShutterflowCodeProps
