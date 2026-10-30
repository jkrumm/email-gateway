import { Body, Container, Head, Hr, Html, Link, Preview, Section, Text } from 'react-email'
import type { ReactNode } from 'react'

// Palette and voice taken from jkrumm.com (light theme); web-safe stacks only.
export const jkrummColors = {
  bg: '#f2f2f5',
  panel: '#fafafd',
  ink: '#262629',
  muted: '#525255',
  faint: '#737376',
  accent: '#0084d1',
  rule: '#dcdce0',
}

export const jkrummFonts = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

export default function JkrummLayout({
  children,
  preview,
}: {
  children: ReactNode
  preview?: string
}) {
  return (
    <Html lang="en">
      <Head />
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        style={{
          backgroundColor: jkrummColors.bg,
          fontFamily: jkrummFonts.sans,
          fontSize: '16px',
          lineHeight: '1.6',
          color: jkrummColors.ink,
          padding: '40px 16px',
          margin: 0,
        }}
      >
        <Container style={{ maxWidth: '600px', width: '100%' }}>
          <Section style={{ padding: '0 0 20px' }}>
            <Link
              href="https://jkrumm.com/?source=email"
              target="_blank"
              style={{ textDecoration: 'none' }}
            >
              <Text
                style={{
                  fontFamily: jkrummFonts.mono,
                  fontSize: '18px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: jkrummColors.ink,
                  margin: 0,
                }}
              >
                jkrumm<span style={{ color: jkrummColors.accent }}>.com</span>
              </Text>
            </Link>
          </Section>

          <Hr
            style={{
              borderColor: jkrummColors.rule,
              borderWidth: '1px 0 0',
              margin: '0 0 28px',
            }}
          />

          {children}

          <Hr
            style={{
              borderColor: jkrummColors.rule,
              borderWidth: '1px 0 0',
              margin: '32px 0 16px',
            }}
          />
          <Text
            style={{
              fontSize: '12px',
              lineHeight: '1.5',
              color: jkrummColors.faint,
              margin: 0,
            }}
          >
            Sent from the contact form on jkrumm.com
          </Text>
        </Container>
      </Body>
    </Html>
  )
}
