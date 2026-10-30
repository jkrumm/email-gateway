import { Heading, Link, Section, Text } from 'react-email'
import SySerendipityLayout from '../../layouts/sy-serendipity.layout'
import { colors, eyebrowStyle, fonts } from './theme'

export interface SySerendipityConfirmationProps {
  firstName: string | null
}

const bodyStyle = {
  fontFamily: fonts.body,
  fontSize: '16px',
  lineHeight: '1.65',
  color: colors.ink,
  margin: '0 0 16px',
}

// The requester's receipt for POST /sy-serendipity. Copy follows the site's
// request page (success state): Barbara Mueller and the charter team follow up.
export default function SySerendipityConfirmationMail({
  firstName,
}: SySerendipityConfirmationProps) {
  const name = firstName?.trim()
  return (
    <SySerendipityLayout preview="Your charter request has been received">
      <Section style={{ padding: '8px 0 24px' }}>
        <Text style={eyebrowStyle}>Charter request</Text>
        <Heading
          as="h1"
          style={{
            fontFamily: fonts.serif,
            fontWeight: 400,
            fontSize: '34px',
            lineHeight: '1.15',
            letterSpacing: '-0.025em',
            color: colors.ink,
            margin: '0 0 24px',
          }}
        >
          Request received
        </Heading>
        <Text style={bodyStyle}>{name ? `Dear ${name},` : 'Hello,'}</Text>
        <Text style={bodyStyle}>
          Thank you for your interest in Serendipity I. Barbara Mueller and the charter team at
          Ocean Independence will contact you about your request.
        </Text>
        <Text style={bodyStyle}>
          Serendipity I is sailing the Pacific, including French Polynesia, the Cook Islands and
          Fiji.
        </Text>
        <Link
          href="https://sy-serendipity.org/?source=email"
          style={{
            display: 'inline-block',
            backgroundColor: colors.ink,
            color: colors.paper,
            fontFamily: fonts.body,
            fontSize: '14px',
            textDecoration: 'none',
            padding: '17px 24px',
            marginTop: '8px',
          }}
        >
          Visit Serendipity I ↗
        </Link>
      </Section>
    </SySerendipityLayout>
  )
}

SySerendipityConfirmationMail.PreviewProps = {
  firstName: 'Jane',
} satisfies SySerendipityConfirmationProps
