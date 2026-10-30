import { Heading, Text, Section, Row, Column } from 'react-email'
import type { CSSProperties } from 'react'
import FppLayout from '../../layouts/fpp.layout'

export interface FppDailyAnalyticsProps {
  votes: number
  estimations: number
  rooms: number
  unique_users: number
  page_views: number
}

const columnStyle33: CSSProperties = {
  width: '33%',
  border: '1px solid #2E2E2E',
  padding: '10px',
}

const columnStyle50: CSSProperties = {
  ...columnStyle33,
  width: '50%',
}

export default function FppDailyAnalytics({
  votes,
  estimations,
  rooms,
  unique_users,
  page_views,
}: FppDailyAnalyticsProps) {
  return (
    <FppLayout>
      <Section>
        <Heading as="h2">New votes! 🎉</Heading>
        <Text>In the last 24 hours we have received new votes!</Text>
        <Text>
          Today is {new Date().toLocaleDateString('en-US', { weekday: 'long' })} the{' '}
          {new Date().toLocaleDateString('de-DE')}.
        </Text>
      </Section>
      <Section
        style={{
          marginTop: 20,
        }}
      >
        <Row>
          <Column style={columnStyle33}>Votes</Column>
          <Column style={columnStyle33}>Estimations</Column>
          <Column style={columnStyle33}>Rooms</Column>
        </Row>
        <Row>
          <Column style={columnStyle33}>{votes}</Column>
          <Column style={columnStyle33}>{estimations}</Column>
          <Column style={columnStyle33}>{rooms}</Column>
        </Row>
      </Section>
      <Section
        style={{
          marginTop: 40,
        }}
      >
        <Row>
          <Column style={columnStyle50}>Unique Users</Column>
          <Column style={columnStyle50}>Page Views</Column>
        </Row>
        <Row>
          <Column style={columnStyle50}>{unique_users}</Column>
          <Column style={columnStyle50}>{page_views}</Column>
        </Row>
      </Section>
    </FppLayout>
  )
}

FppDailyAnalytics.PreviewProps = {
  votes: 3,
  estimations: 10,
  rooms: 2,
  unique_users: 10,
  page_views: 30,
} satisfies FppDailyAnalyticsProps
