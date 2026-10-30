import { describe, expect, test } from 'bun:test'
import { openMailDatabase } from './mail-client'
import { createSendBodiesRepo } from './send-bodies'

function setup() {
  const db = openMailDatabase(':memory:')
  return { db, bodies: createSendBodiesRepo(db) }
}

describe('send bodies repo', () => {
  test('saves a body and reads it back, null when unknown', () => {
    const { bodies } = setup()
    expect(bodies.get('missing')).toBeNull()

    bodies.save({ sendId: 's1', html: '<p>hi</p>', text: 'hi' })

    expect(bodies.get('s1')).toEqual({
      sendId: 's1',
      html: '<p>hi</p>',
      text: 'hi',
      createdAt: expect.any(String),
    })
  })

  test('a second save of the same send replaces the first', () => {
    const { bodies } = setup()
    bodies.save({ sendId: 's1', html: 'a', text: 'a' })
    bodies.save({ sendId: 's1', html: 'b', text: 'b' })

    expect(bodies.get('s1')).toMatchObject({ html: 'b', text: 'b' })
  })

  test('a second save keeps the first created_at (the retention anchor)', () => {
    const { db, bodies } = setup()
    bodies.save({ sendId: 's1', html: 'a', text: 'a' })
    db.run("UPDATE send_bodies SET created_at = ? WHERE send_id = 's1'", [
      '2026-09-01T00:00:00.000Z',
    ])

    bodies.save({ sendId: 's1', html: 'b', text: 'b' })

    expect(bodies.get('s1')).toEqual({
      sendId: 's1',
      html: 'b',
      text: 'b',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
  })

  test('pruneOlderThan deletes only bodies stored before the cutoff', () => {
    const { db, bodies } = setup()
    bodies.save({ sendId: 'old', html: 'o', text: 'o' })
    bodies.save({ sendId: 'new', html: 'n', text: 'n' })
    db.run("UPDATE send_bodies SET created_at = ? WHERE send_id = 'old'", [
      '2026-09-01T00:00:00.000Z',
    ])

    expect(bodies.pruneOlderThan('2026-09-14T00:00:00.000Z')).toBe(1)

    expect(bodies.get('old')).toBeNull()
    expect(bodies.get('new')).not.toBeNull()
    expect(bodies.pruneOlderThan('2026-09-14T00:00:00.000Z')).toBe(0)
  })
})
