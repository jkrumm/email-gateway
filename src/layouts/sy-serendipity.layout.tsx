import {
  Body,
  Column,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from 'react-email'
import type { ReactNode } from 'react'
import { colors, eyebrowStyle, fonts } from '../emails/sy-serendipity/theme'

export default function SySerendipityLayout({
  children,
  preview,
}: {
  children: ReactNode
  preview: string
}) {
  const currentYear = new Date().getFullYear()

  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: colors.paper,
          fontFamily: fonts.body,
          fontSize: '16px',
          lineHeight: '1.65',
          color: colors.ink,
          padding: '48px 16px',
          margin: 0,
        }}
      >
        <Container style={{ maxWidth: '600px', width: '100%' }}>
          <Section style={{ padding: '0 0 24px' }}>
            <Link
              href="https://sy-serendipity.org/?source=email"
              target="_blank"
              style={{ textDecoration: 'none' }}
            >
              <Row>
                <Column style={{ width: '37px' }}>
                  <Img
                    src="https://img.jkrumm.com/rs:fit:74/f:png/sy-serendipity/all/logo-blue-icon.png"
                    width="37"
                    height="60"
                    alt="Serendipity I"
                    style={{ display: 'block' }}
                  />
                </Column>
                <Column style={{ paddingLeft: '12px' }}>
                  <Text
                    style={{
                      fontFamily: fonts.serif,
                      fontWeight: 400,
                      fontSize: '26px',
                      lineHeight: '1.1',
                      letterSpacing: '-0.025em',
                      color: colors.ink,
                      margin: 0,
                    }}
                  >
                    Serendipity I
                  </Text>
                </Column>
              </Row>
            </Link>
          </Section>

          <Hr
            style={{
              borderColor: colors.rule,
              borderWidth: '1px 0 0',
              margin: '0 0 32px',
            }}
          />

          {children}

          <Section style={{ backgroundColor: colors.ink, padding: '32px' }}>
            <Text style={{ ...eyebrowStyle, color: colors.secondaryOnInk }}>
              Charter destinations
            </Text>
            <Text
              style={{
                fontFamily: fonts.serif,
                fontWeight: 400,
                fontSize: '20px',
                lineHeight: '1.15',
                letterSpacing: '-0.025em',
                color: colors.paper,
                margin: '0 0 20px',
              }}
            >
              The South Pacific. Until summer 2028.
            </Text>
            <Hr
              style={{
                borderColor: colors.dividerOnInk,
                borderWidth: '1px 0 0',
                margin: '0 0 16px',
              }}
            />
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: '12px',
                lineHeight: '1.5',
                color: colors.secondaryOnInk,
                margin: 0,
              }}
            >
              © {currentYear} Serendipity I · Sent from the request form on sy-serendipity.org
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
