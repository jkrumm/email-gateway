import { describe, expect, test } from 'bun:test'
import type { SesAccountSnapshot } from '../providers/ses/account'
import { openMailDatabase } from './mail-client'
import { createSesAccountRepo } from './ses-account'

const snapshot: SesAccountSnapshot = {
  sendingEnabled: true,
  enforcementStatus: 'HEALTHY',
  productionAccess: true,
  max24HourSend: 50000,
  maxSendRate: 14,
  sentLast24Hours: 3,
  fetchedAt: '2026-10-14T08:00:00.000Z',
}

describe('ses account repo', () => {
  test('round-trips the snapshot, null before the first save', () => {
    const repo = createSesAccountRepo(openMailDatabase(':memory:'))
    expect(repo.get()).toBeNull()

    repo.save(snapshot)

    expect(repo.get()).toEqual(snapshot)
  })

  test('unreadable or wrongly shaped stored JSON reads as null', () => {
    const db = openMailDatabase(':memory:')
    const repo = createSesAccountRepo(db)
    repo.save(snapshot)

    db.run("UPDATE ses_account SET data = 'not json' WHERE id = 1")
    expect(repo.get()).toBeNull()

    db.run(`UPDATE ses_account SET data = '{"sendingEnabled":"yes"}' WHERE id = 1`)
    expect(repo.get()).toBeNull()
  })
})
