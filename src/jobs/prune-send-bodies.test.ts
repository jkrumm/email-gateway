import { describe, expect, test } from 'bun:test'
import { createJobQueue } from '../db/jobs'
import { openMailDatabase } from '../db/mail-client'
import { createSendLogRepo } from '../db/send-log'
import { createSendBodiesRepo, SEND_BODY_RETENTION_MS } from '../db/send-bodies'
import { createPruneSendBodiesHandler, enqueuePruneSendBodies } from './prune-send-bodies'

describe('createPruneSendBodiesHandler', () => {
  test('deletes bodies older than 30 days and keeps the rest', async () => {
    const db = openMailDatabase(':memory:')
    const sendBodies = createSendBodiesRepo(db)
    const now = new Date('2026-10-14T12:00:00.000Z')
    for (const id of ['old', 'edge-in', 'new']) {
      sendBodies.save({ sendId: id, html: id, text: id })
    }
    const at = (ageMs: number) => new Date(now.getTime() - ageMs).toISOString()
    db.run("UPDATE send_bodies SET created_at = ? WHERE send_id = 'old'", [
      at(SEND_BODY_RETENTION_MS + 60_000),
    ])
    db.run("UPDATE send_bodies SET created_at = ? WHERE send_id = 'edge-in'", [
      at(SEND_BODY_RETENTION_MS - 60_000),
    ])
    db.run("UPDATE send_bodies SET created_at = ? WHERE send_id = 'new'", [at(0)])

    const sendLog = createSendLogRepo(db)

    await createPruneSendBodiesHandler({
      sendBodies,
      sendLog,
      now: () => now,
    })({})

    expect(sendBodies.get('old')).toBeNull()
    expect(sendBodies.get('edge-in')).not.toBeNull()
    expect(sendBodies.get('new')).not.toBeNull()
  })

  test('also deletes send_events older than 30 days', async () => {
    const db = openMailDatabase(':memory:')
    const sendLog = createSendLogRepo(db)
    const sendBodies = createSendBodiesRepo(db)
    const now = new Date('2026-10-14T12:00:00.000Z')
    sendLog.insertSendLog({
      id: 'row',
      recipients: ['jane@example.com'],
      provider: 'ses',
      requestedBy: 'route',
    })
    sendLog.recordProviderResult('row', {
      providerMessageId: 'm1',
      status: 'sent',
    })
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      status: null,
      lastEvent: eventType.toLowerCase(),
      occurredAt,
    })
    sendLog.recordProviderEvent('ses', 'm1', event('Send', '2026-08-01T00:00:00.000Z'))
    sendLog.recordProviderEvent('ses', 'm1', event('Delivery', now.toISOString()))
    db.run("UPDATE send_events SET received_at = ? WHERE event_type = 'Send'", [
      new Date(now.getTime() - SEND_BODY_RETENTION_MS - 60_000).toISOString(),
    ])
    db.run("UPDATE send_events SET received_at = ? WHERE event_type = 'Delivery'", [
      new Date(now.getTime() - SEND_BODY_RETENTION_MS + 60_000).toISOString(),
    ])

    await createPruneSendBodiesHandler({
      sendBodies,
      sendLog,
      now: () => now,
    })({})

    expect(sendLog.listSendEvents('row').map((e) => e.eventType)).toEqual(['Delivery'])
  })

  test('running twice is harmless', async () => {
    const db = openMailDatabase(':memory:')
    const handler = createPruneSendBodiesHandler({
      sendBodies: createSendBodiesRepo(db),
      sendLog: createSendLogRepo(db),
    })

    await handler({})
    await expect(handler({})).resolves.toBeUndefined()
  })
})

describe('enqueuePruneSendBodies', () => {
  test('enqueues a prune_send_bodies job', () => {
    const db = openMailDatabase(':memory:')
    const queue = createJobQueue({ db, claimedBy: 'test:1' })

    enqueuePruneSendBodies(queue)

    expect(db.query('SELECT kind, subject_key FROM jobs').all()).toEqual([
      { kind: 'prune_send_bodies', subject_key: 'prune' },
    ])
  })
})
