import { describe, expect, test } from 'bun:test'
import { openMailDatabase } from '../db/mail-client'
import { createJobQueue } from '../db/jobs'
import { createSendLogRepo } from '../db/send-log'
import { discardResendJobs } from './discard-resend'

describe('discardResendJobs', () => {
  test('drops pending send jobs for resend rows and every reconcile job, keeps the rest', () => {
    const db = openMailDatabase(':memory:')
    const sendLog = createSendLogRepo(db)
    const queue = createJobQueue({ db, claimedBy: 'test:1' })
    for (const [id, provider] of [
      ['resend-row', 'resend'],
      ['ses-row', 'ses'],
    ] as const) {
      sendLog.insertSendLog({
        id,
        recipients: ['a@example.com'],
        provider,
        requestedBy: 'api',
      })
      queue.enqueue({ kind: 'send', payload: { id }, subjectKey: id })
    }
    queue.enqueue({
      kind: 'reconcile_send_log',
      payload: {},
      subjectKey: 'reconcile_send_log',
    })
    queue.enqueue({ kind: 'sync_tick', payload: {}, subjectKey: 'tick' })

    expect(discardResendJobs(db)).toBe(2)

    const remaining = db
      .query<{ kind: string; subject_key: string }, []>(
        'SELECT kind, subject_key FROM jobs ORDER BY kind',
      )
      .all()
    expect(remaining).toEqual([
      { kind: 'send', subject_key: 'ses-row' },
      { kind: 'sync_tick', subject_key: 'tick' },
    ])
  })
})
