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

// Athena's tokens (chat/ui/src/tokens.css there: canvas, panel, ink ramp, rule,
// brand), ported as literal hex: mail clients cannot load the app's stylesheet.
// Dark mode follows prefers-color-scheme (Apple Mail); Gmail inverts on its own.
export const athenaColors = {
  bg: "#F2F2F5",
  card: "#FFFFFF",
  wash: "#F4F4F7",
  border: "#DEDEE2",
  ink: "#232327",
  body: "#4E4E53",
  muted: "#66666B",
  brand: "#16324F",
};

const dark = {
  bg: "#18181B",
  card: "#2B2B2F",
  wash: "#2F2F33",
  border: "#46464A",
  ink: "#E7E7EA",
  body: "#C2C2C8",
  muted: "#A0A0A6",
  brand: "#E7E7EA",
};

export const athenaFonts = {
  sans: "'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
};

const darkCss = `@media (prefers-color-scheme: dark){
.at-bg{background-color:${dark.bg} !important}
.at-card{background-color:${dark.card} !important;border-color:${dark.border} !important}
.at-brand{color:${dark.brand} !important}
.at-ink{color:${dark.ink} !important}
.at-body{color:${dark.body} !important}
.at-muted{color:${dark.muted} !important}
.at-code{background-color:${dark.wash} !important;border-color:${dark.border} !important}
}`;

export default function AthenaLayout({
  children,
  preview,
}: {
  children: ReactNode;
  preview?: string;
}) {
  const c = athenaColors;
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{darkCss}</style>
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        className="at-bg"
        style={{
          backgroundColor: c.bg,
          fontFamily: athenaFonts.sans,
          margin: 0,
          padding: "32px 16px",
        }}
      >
        <Container style={{ maxWidth: "480px", width: "100%" }}>
          <Section style={{ padding: "0 0 16px 4px" }}>
            <Text
              className="at-brand"
              style={{
                fontSize: "18px",
                lineHeight: "28px",
                fontWeight: 600,
                color: c.brand,
                margin: 0,
              }}
            >
              Athena
            </Text>
          </Section>
          <Section
            className="at-card"
            style={{
              backgroundColor: c.card,
              border: `1px solid ${c.border}`,
              borderRadius: "10px",
              padding: "32px",
            }}
          >
            {children}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
