import { Fragment } from 'react'
import { Column, Heading, Hr, Img, Link, Row, Section, Text } from 'react-email'
import SySerendipityLayout from '../../layouts/sy-serendipity.layout'
import { validDate } from '../../utils/date'
import { parseCalendarDate } from './request-subject'
import { colors, eyebrowStyle, fonts } from './theme'

export interface SySerendipityRequestProps {
  firstName: string | null
  lastName: string | null
  email: string
  numberOfPeople: string | null
  destination: string | null
  duration: string | null
  arrivalDate: string | null
  departureDate: string | null
  phone: string | null
  message: string | null
  // Request time; a Date, or an ISO string once the props went through JSON.
  receivedAt?: Date | string
}

// The form sends Date.toDateString() ("Sat Jun 12 2027"); ISO works too.
function toUtcDate(value: string): Date | null {
  const parsed = parseCalendarDate(value)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.year, parsed.month, parsed.day))
}

function formatDate(value: string | null): string {
  if (!value || value.trim().length === 0) return '—'
  const trimmed = value.trim()
  const date = toUtcDate(trimmed)
  if (!date) return trimmed
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatShortDate(value: string): { day: string; month: string; year: string } | null {
  const date = toUtcDate(value)
  if (!date) return null
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
  const month = new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  }).format(date)
  const year = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
  return { day, month, year }
}

function buildPreviewDateRange(
  arrivalDate: string | null,
  departureDate: string | null,
): string | null {
  const arrival = arrivalDate ? formatShortDate(arrivalDate) : null
  const departure = departureDate ? formatShortDate(departureDate) : null

  if (arrival && departure) {
    if (arrival.month === departure.month && arrival.year === departure.year) {
      return `${arrival.day}–${departure.day} ${arrival.month} ${arrival.year}`
    }
    return `${arrival.day} ${arrival.month} ${arrival.year} – ${departure.day} ${departure.month} ${departure.year}`
  }

  if (arrival) return `${arrival.day} ${arrival.month} ${arrival.year}`
  if (departure) return `${departure.day} ${departure.month} ${departure.year}`
  return null
}

function formatReceivedAt(value: Date | string | undefined): string | null {
  const date = validDate(value)
  if (!date) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/Madrid',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`
}

function buildPreview(props: SySerendipityRequestProps): string {
  const fullName = [props.firstName, props.lastName].filter(Boolean).join(' ').trim()
  const parts: string[] = [
    fullName.length > 0 ? `Charter request from ${fullName}` : 'New charter request',
  ]

  if (props.destination && props.destination.trim().length > 0) {
    parts.push(props.destination.trim())
  }

  const dateRange = buildPreviewDateRange(props.arrivalDate, props.departureDate)
  if (dateRange) parts.push(dateRange)

  return parts.join(' · ')
}

function displayValue(value: string | null) {
  return value && value.trim().length > 0 ? value : '—'
}

function TripField({ label, value }: { label: string; value: string }) {
  return (
    <Column style={{ width: '50%', paddingBottom: '24px', verticalAlign: 'top' }}>
      <Text style={eyebrowStyle}>{label}</Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: '16px',
          lineHeight: '1.4',
          color: colors.ink,
          margin: 0,
        }}
      >
        {value}
      </Text>
    </Column>
  )
}

function GuestRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        <Column style={{ width: '35%', verticalAlign: 'top' }}>
          <Text style={eyebrowStyle}>{label}</Text>
        </Column>
        <Column style={{ width: '65%', verticalAlign: 'top' }}>
          {href ? (
            <Link
              href={href}
              style={{
                fontFamily: fonts.body,
                fontSize: '16px',
                lineHeight: '1.4',
                color: colors.ink,
                textDecoration: 'underline',
              }}
            >
              {value}
            </Link>
          ) : (
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: '16px',
                lineHeight: '1.4',
                color: colors.ink,
                margin: 0,
              }}
            >
              {value}
            </Text>
          )}
        </Column>
      </Row>
      <Hr
        style={{
          borderColor: colors.rule,
          borderWidth: '1px 0 0',
          margin: '16px 0 0',
        }}
      />
    </Section>
  )
}

export default function SySerendipityRequestMail(props: SySerendipityRequestProps) {
  const {
    firstName,
    lastName,
    email,
    numberOfPeople,
    destination,
    duration,
    arrivalDate,
    departureDate,
    phone,
    message,
    receivedAt,
  } = props

  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
  const headline =
    fullName.length > 0 ? `${fullName} would like to charter Serendipity I` : 'New charter request'
  const replyToLabel = firstName && firstName.trim().length > 0 ? firstName.trim() : 'guest'
  const mailtoHref = `mailto:${email}?subject=${encodeURIComponent(
    'Your Serendipity I charter request',
  )}`
  const telHref = phone && phone.trim().length > 0 ? `tel:${phone.replace(/\s+/g, '')}` : null
  const receivedLabel = formatReceivedAt(receivedAt)
  const messageLines = message && message.trim().length > 0 ? message.trim().split('\n') : null

  return (
    <SySerendipityLayout preview={buildPreview(props)}>
      <Section style={{ padding: '0 0 32px' }}>
        <Img
          src="https://img.jkrumm.com/rs:fill:1200:320/f:jpg/sy-serendipity/polynesia/polynesia-03.jpg"
          width="600"
          height="160"
          alt="Serendipity I anchored in a deep blue Marquesas bay below volcanic cliffs"
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
      </Section>

      <Section style={{ padding: '0 0 40px' }}>
        <Text style={eyebrowStyle}>Charter request</Text>
        <Heading
          as="h1"
          style={{
            fontFamily: fonts.serif,
            fontWeight: 400,
            fontSize: '28px',
            lineHeight: '1.15',
            letterSpacing: '-0.025em',
            color: colors.ink,
            margin: '0 0 16px',
          }}
        >
          {headline}
        </Heading>
        <Text
          style={{
            fontFamily: fonts.body,
            fontSize: '16px',
            lineHeight: '1.65',
            color: colors.muted,
            margin: 0,
          }}
        >
          A guest inquired about chartering Serendipity I through the request form on
          sy-serendipity.org. The details of their request are below.
        </Text>
        {receivedLabel ? (
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: '13px',
              lineHeight: '1.5',
              color: colors.muted,
              margin: '12px 0 0',
            }}
          >
            {`Received ${receivedLabel} (Madrid time)`}
          </Text>
        ) : null}
      </Section>

      <Section style={{ padding: '0 0 16px' }}>
        <Text
          style={{
            ...eyebrowStyle,
            margin: '0 0 16px',
            paddingBottom: '8px',
            borderBottom: `1px solid ${colors.rule}`,
          }}
        >
          Trip
        </Text>
        <Row>
          <TripField label="Preferred destination" value={displayValue(destination)} />
          <TripField label="Guests" value={displayValue(numberOfPeople)} />
        </Row>
        <Row>
          <TripField label="Arrival" value={formatDate(arrivalDate)} />
          <TripField label="Departure" value={formatDate(departureDate)} />
        </Row>
        <Row>
          <TripField label="Duration" value={displayValue(duration)} />
          <Column style={{ width: '50%' }} />
        </Row>
      </Section>

      <Section style={{ padding: '8px 0 16px' }}>
        <Text
          style={{
            ...eyebrowStyle,
            margin: '0 0 0',
            paddingBottom: '8px',
            borderBottom: `1px solid ${colors.rule}`,
          }}
        >
          Guest
        </Text>
        <GuestRow label="Name" value={fullName.length > 0 ? fullName : '—'} />
        <GuestRow label="Email" value={email} href={`mailto:${email}`} />
        <GuestRow label="Telephone" value={displayValue(phone)} href={telHref ?? undefined} />
      </Section>

      {messageLines ? (
        <Section style={{ padding: '8px 0 40px' }}>
          <Text style={eyebrowStyle}>Message</Text>
          <Section
            style={{
              backgroundColor: colors.light,
              padding: '24px',
              marginTop: '8px',
            }}
          >
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: '16px',
                lineHeight: '1.65',
                color: colors.ink,
                margin: 0,
              }}
            >
              {messageLines.map((line, index) => (
                <Fragment key={index}>
                  {index > 0 ? <br /> : null}
                  {line}
                </Fragment>
              ))}
            </Text>
          </Section>
        </Section>
      ) : null}

      <Section style={{ padding: '8px 0 48px', textAlign: 'center' }}>
        <Link
          href={mailtoHref}
          style={{
            display: 'inline-block',
            backgroundColor: colors.ink,
            border: `1px solid ${colors.ink}`,
            color: colors.paper,
            fontFamily: fonts.body,
            fontSize: '14px',
            textDecoration: 'none',
            padding: '17px 24px',
          }}
        >
          {`Reply to ${replyToLabel} ↗`}
        </Link>
      </Section>
    </SySerendipityLayout>
  )
}

SySerendipityRequestMail.PreviewProps = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane.doe@example.com',
  numberOfPeople: '6',
  destination: 'Marquesas Islands',
  duration: '7 days',
  arrivalDate: 'Sat Jun 12 2027',
  departureDate: 'Sat Jun 19 2027',
  phone: '+1 415 555 0173',
  message:
    "We're a group of long-time sailors celebrating a milestone birthday and would love to explore the more remote anchorages if the itinerary allows.\n\nHappy to be flexible on the exact dates if that helps with planning.",
  receivedAt: '2027-03-04T14:32:00Z',
} satisfies SySerendipityRequestProps
