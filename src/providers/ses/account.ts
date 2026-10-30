import type { GetAccountResponse, SESv2Client } from '@aws-sdk/client-sesv2'

// What the dashboard shows about the SES account: whether it may send, how it
// is judged, and how much of its quota is used. Stored as one JSON row
// (src/db/ses-account.ts).
export interface SesAccountSnapshot {
  sendingEnabled: boolean
  // HEALTHY / PROBATION / SHUTDOWN, as SES reports it.
  enforcementStatus: string | null
  // False while the account is still in the SES sandbox.
  productionAccess: boolean
  max24HourSend: number | null
  maxSendRate: number | null
  sentLast24Hours: number | null
  // ISO UTC.
  fetchedAt: string
}

// Only what the fetch calls — narrower than the full SDK client so a test
// fake can be injected.
export type SesAccountClient = Pick<SESv2Client, 'send'>

// Pure: GetAccount's response to the snapshot we keep.
export function toSesAccountSnapshot(
  response: GetAccountResponse,
  fetchedAt: Date,
): SesAccountSnapshot {
  return {
    sendingEnabled: response.SendingEnabled ?? false,
    enforcementStatus: response.EnforcementStatus ?? null,
    productionAccess: response.ProductionAccessEnabled ?? false,
    max24HourSend: response.SendQuota?.Max24HourSend ?? null,
    maxSendRate: response.SendQuota?.MaxSendRate ?? null,
    sentLast24Hours: response.SendQuota?.SentLast24Hours ?? null,
    fetchedAt: fetchedAt.toISOString(),
  }
}

// A failed call throws from the SDK.
export async function fetchSesAccount({
  client,
  now = () => new Date(),
}: {
  client: SesAccountClient
  now?: () => Date
}): Promise<SesAccountSnapshot> {
  // Loaded on first use, like src/providers/ses/send.ts: the SDK is not
  // loaded at boot.
  const { GetAccountCommand } = await import('@aws-sdk/client-sesv2')
  const response = await client.send(new GetAccountCommand({}))
  return toSesAccountSnapshot(response, now())
}
