import { describe, expect, test } from 'bun:test'
import { mapSesEvent } from './events'

const mail = { messageId: 'ses-msg-1', timestamp: '2026-10-14T08:00:00.000Z' }
const receivedAt = new Date('2026-10-14T09:00:00.000Z')

describe('mapSesEvent', () => {
  test.each([
    ['Delivery', 'delivered', 'delivery'],
    ['Complaint', 'complained', 'complaint'],
    ['DeliveryDelay', 'delivery_delayed', 'deliveryDelay'],
  ])('%s -> %s, timestamped by its own object', (eventType, status, key) => {
    expect(
      mapSesEvent({
        eventType,
        mail,
        [key]: { timestamp: '2026-10-14T08:00:05.123Z' },
      }),
    ).toEqual({
      providerMessageId: 'ses-msg-1',
      eventType,
      status,
      lastEvent: status,
      occurredAt: '2026-10-14T08:00:05.123Z',
    })
  })

  test.each([
    ['Reject', 'rejected'],
    ['Rendering Failure', 'failed'],
  ])('%s -> %s, timestamped by the mail (no own timestamp)', (eventType, status) => {
    expect(mapSesEvent({ eventType, mail })).toEqual({
      providerMessageId: 'ses-msg-1',
      eventType,
      status,
      lastEvent: status,
      occurredAt: '2026-10-14T08:00:00.000Z',
    })
  })

  test('Send is a timeline-only event: no status', () => {
    expect(mapSesEvent({ eventType: 'Send', mail })).toEqual({
      providerMessageId: 'ses-msg-1',
      eventType: 'Send',
      status: null,
      lastEvent: 'send',
      occurredAt: '2026-10-14T08:00:00.000Z',
    })
  })

  test('falls back to the receive time without a usable timestamp', () => {
    expect(
      mapSesEvent(
        {
          eventType: 'Delivery',
          mail: { messageId: 'm' },
          delivery: { timestamp: 'not a date' },
        },
        receivedAt,
      )?.occurredAt,
    ).toBe('2026-10-14T09:00:00.000Z')
  })

  test('Bounce -> bounced, with type, subtype and a diagnostic code', () => {
    for (const bounceType of ['Permanent', 'Transient', 'Undetermined']) {
      expect(
        mapSesEvent({
          eventType: 'Bounce',
          mail,
          bounce: {
            bounceType,
            bounceSubtype: 'General',
            timestamp: '2026-10-14T08:00:03.000Z',
            bouncedRecipients: [
              {
                emailAddress: 'guest@example.com',
                diagnosticCode: 'smtp; 550 5.1.1 user unknown',
              },
            ],
          },
        }),
      ).toEqual({
        providerMessageId: 'ses-msg-1',
        eventType: 'Bounce',
        status: 'bounced',
        lastEvent: `bounced:${bounceType}`,
        occurredAt: '2026-10-14T08:00:03.000Z',
        bounceType,
        bounceSubtype: 'General',
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
      })
    }
  })

  test('a diagnostic code never keeps the recipient address', () => {
    const event = mapSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bouncedRecipients: [
          {
            diagnosticCode: 'smtp; 550 5.1.1 <guest@example.com>: unknown',
          },
        ],
      },
    })
    expect(event?.diagnosticCode).toBe('smtp; 550 5.1.1 <[address]>: unknown')
    expect(JSON.stringify(event)).not.toContain('guest@')
  })

  test('every address in one diagnostic code is scrubbed', () => {
    const event = mapSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bouncedRecipients: [
          {
            diagnosticCode: 'smtp; 550 <a@example.com> forwarded to b@example.org, refused',
          },
        ],
      },
    })
    expect(event?.diagnosticCode).toBe('smtp; 550 <[address]> forwarded to [address], refused')
  })

  test('a diagnostic code without an address is unchanged', () => {
    const event = mapSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bouncedRecipients: [{ diagnosticCode: 'smtp; 552 mailbox full' }],
      },
    })
    expect(event?.diagnosticCode).toBe('smtp; 552 mailbox full')
  })

  test('a Bounce without a type is still bounced', () => {
    expect(mapSesEvent({ eventType: 'Bounce', mail })).toEqual({
      providerMessageId: 'ses-msg-1',
      eventType: 'Bounce',
      status: 'bounced',
      lastEvent: 'bounced',
      occurredAt: '2026-10-14T08:00:00.000Z',
    })
  })

  test('Open, Click, Subscription and unknown types are ignored', () => {
    for (const eventType of ['Open', 'Click', 'Subscription', 'Something New', 'toString']) {
      expect(mapSesEvent({ eventType, mail })).toBeNull()
    }
  })

  test('malformed payloads are ignored', () => {
    for (const payload of [
      null,
      'Delivery',
      [],
      {},
      { eventType: 'Delivery' },
      { eventType: 'Delivery', mail: {} },
      { eventType: 'Delivery', mail: { messageId: '' } },
      { eventType: 7, mail },
    ]) {
      expect(mapSesEvent(payload)).toBeNull()
    }
  })
})
