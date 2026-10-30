import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { SesAccountSnapshot } from '../providers/ses/account'

interface SesAccountRow {
  data: string
}

const snapshotSchema = z.object({
  sendingEnabled: z.boolean(),
  enforcementStatus: z.string().nullable(),
  productionAccess: z.boolean(),
  max24HourSend: z.number().nullable(),
  maxSendRate: z.number().nullable(),
  sentLast24Hours: z.number().nullable(),
  fetchedAt: z.string(),
}) satisfies z.ZodType<SesAccountSnapshot>

// The latest SES GetAccount snapshot (migration 9): one row, overwritten by
// the hourly ses_account job (src/jobs/ses-account.ts).
export function createSesAccountRepo(db: Database) {
  function save(snapshot: SesAccountSnapshot): void {
    db.run(
      `INSERT INTO ses_account (id, data, fetched_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      [JSON.stringify(snapshot), snapshot.fetchedAt],
    )
  }

  // Null until the job has run once, or when the stored JSON is unreadable
  // or no longer matches the snapshot shape.
  function get(): SesAccountSnapshot | null {
    const row = db.query<SesAccountRow, []>('SELECT data FROM ses_account WHERE id = 1').get()
    if (!row) return null
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(row.data))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  return { save, get }
}

export type SesAccountRepo = ReturnType<typeof createSesAccountRepo>
