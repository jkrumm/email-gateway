import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";
import type { ReactNode } from "react";

// Shutterflow's brand shell (apps/share/src/lib/brand/palette.ts there), ported
// as literal hex: mail clients cannot load the app's stylesheet. Dark mode
// follows prefers-color-scheme (Apple Mail); Gmail inverts on its own.
export const shutterflowColors = {
  bg: "#f2f2f5",
  card: "#ffffff",
  border: "#e2e2e5",
  ink: "#262629",
  body: "#404043",
  muted: "#525255",
};

const dark = {
  bg: "#27272a",
  card: "#2b2b2e",
  border: "#444447",
  ink: "#e5e5e9",
  body: "#dddde1",
  muted: "#a1a1aa",
};

export const shutterflowFonts = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
};

const darkCss = `@media (prefers-color-scheme: dark){
.sf-bg{background-color:${dark.bg} !important}
.sf-card{background-color:${dark.card} !important;border-color:${dark.border} !important}
.sf-ink{color:${dark.ink} !important}
.sf-body{color:${dark.body} !important}
.sf-muted{color:${dark.muted} !important}
.sf-code{background-color:${dark.bg} !important;border-color:${dark.border} !important}
}`;

export default function ShutterflowLayout({
  children,
  preview,
}: {
  children: ReactNode;
  preview?: string;
}) {
  const c = shutterflowColors;
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{darkCss}</style>
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        className="sf-bg"
        style={{
          backgroundColor: c.bg,
          fontFamily: shutterflowFonts.sans,
          margin: 0,
          padding: "32px 16px",
        }}
      >
        <Container style={{ maxWidth: "480px", width: "100%" }}>
          <Section style={{ padding: "0 0 16px 4px" }}>
            <Text
              className="sf-ink"
              style={{
                fontSize: "18px",
                lineHeight: "28px",
                fontWeight: 600,
                color: c.ink,
                margin: 0,
              }}
            >
              Shutterflow
            </Text>
          </Section>
          <Section
            className="sf-card"
            style={{
              backgroundColor: c.card,
              border: `1px solid ${c.border}`,
              borderRadius: "12px",
              padding: "32px",
            }}
          >
            {children}
          </Section>
          <Text
            className="sf-muted"
            style={{
              fontSize: "12px",
              lineHeight: "18px",
              color: c.muted,
              margin: "16px 4px 0",
            }}
          >
            Shutterflow · shutterflow.app
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
