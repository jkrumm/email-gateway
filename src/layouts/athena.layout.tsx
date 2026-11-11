import { Body, Container, Head, Html, Preview } from 'react-email'
import type { ReactNode } from 'react'

// Text-first on purpose: no images, no links, no card chrome. Mail clients cannot
// load the app's stylesheet, so the palette is literal hex. Every foreground sits
// at 4.5:1 or better on its background in both schemes (the template test checks
// the pairs). The inline values are the light scheme and the safe default; the
// prefers-color-scheme block restates every colour for dark, so a client that
// honours `color-scheme` (Apple Mail, Outlook.com, Dark Reader) gets a designed
// dark mail and one that inverts on its own (Gmail) starts from sane values.
export const athenaLight = {
  bg: '#FFFFFF',
  wash: '#F1F1F4',
  border: '#C9C9D0',
  ink: '#16161A',
  body: '#33333A',
  muted: '#55555C',
}

export const athenaDark = {
  bg: '#16161A',
  wash: '#26262B',
  border: '#4A4A52',
  ink: '#F2F2F5',
  body: '#D6D6DC',
  muted: '#A9A9B2',
}

export const athenaColors = athenaLight

export const athenaFonts = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
}

const d = athenaDark
const schemeCss = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme: dark){
body,td,.at-bg{background-color:${d.bg} !important}
.at-ink{color:${d.ink} !important}
.at-body{color:${d.body} !important}
.at-muted{color:${d.muted} !important}
.at-code{background-color:${d.wash} !important;border-color:${d.border} !important}
}`

export default function AthenaLayout({
  children,
  preview,
}: {
  children: ReactNode
  preview?: string
}) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{schemeCss}</style>
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        className="at-bg"
        style={{
          backgroundColor: athenaLight.bg,
          color: athenaLight.body,
          fontFamily: athenaFonts.sans,
          margin: 0,
          padding: '32px 16px',
        }}
      >
        <Container style={{ maxWidth: '30rem', width: '100%' }}>{children}</Container>
      </Body>
    </Html>
  )
}
