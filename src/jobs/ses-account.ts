import type { JobQueue } from '../db/jobs'
import { sesAccountRepo as defaultRepo } from '../db/mail-index'
import type { SesAccountRepo } from '../db/ses-account'
import { fetchSesAccount, type SesAccountClient } from '../providers/ses/account'
import { sesClient } from '../providers/send-registry'
import { isRateLimitError } from './rate-limit'
import type { JobHandler } from './runner'
import { log } from '../telemetry/log'

// The `ses_account` job kind: snapshots SES's GetAccount (sending state,
// enforcement, quota) into the single ses_account row for the dashboard.
// Hourly, from src/jobs/register.ts. It is a nicety, so it fails quietly: a
// non-rate-limit error logs one line and the job completes (the next hourly
// tick retries); a throttle is rethrown so the runner parks it on the shared
// rate-limit ladder.
export function createSesAccountHandler({
  client = sesClient(),
  repo = defaultRepo,
  now,
}: {
  client?: SesAccountClient
  repo?: Pick<SesAccountRepo, 'save'>
  now?: () => Date
} = {}): JobHandler {
  return async () => {
    try {
      const snapshot = await fetchSesAccount({ client, now })
      repo.save(snapshot)
      const { max24HourSend, sentLast24Hours } = snapshot
      log.event('ses.account', {
        sending_enabled: snapshot.sendingEnabled,
        sent_24h: sentLast24Hours,
        max_24h_send: max24HourSend,
        headroom_pct:
          max24HourSend && sentLast24Hours !== null
            ? Math.round((1 - sentLast24Hours / max24HourSend) * 100)
            : null,
      })
    } catch (error) {
      if (isRateLimitError(error)) throw error
      log.warn('[jobs] ses_account fetch failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}

export function enqueueSesAccount(queue: JobQueue): void {
  queue.enqueue({ kind: 'ses_account', payload: {}, subjectKey: 'account' })
}
