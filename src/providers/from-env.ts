import { gmailImapConfigFromEnv, imapConfigFromEnv } from './imap/config'
import { createImapProvider } from './imap/provider'
import type { MailProvider } from './port'

let cachedProviders: MailProvider[] | null = null

// Builds (once per process) every MailProvider the env configures — IMAP
// (Proton, via Bridge; Gmail, via app password) only when the matching env
// vars are set. Shared by the sync tick and every job handler
// that re-fetches a message body, so a provider (and the IMAP session pool it
// owns) is constructed once, not once per job.
export function configuredProviders(): MailProvider[] {
  if (cachedProviders) return cachedProviders

  const providers: MailProvider[] = []

  const imapConfig = imapConfigFromEnv()
  if (imapConfig) {
    providers.push(
      createImapProvider(imapConfig, {
        id: 'proton',
        account: imapConfig.user,
      }),
    )
  }

  const gmailConfig = gmailImapConfigFromEnv()
  if (gmailConfig) {
    providers.push(
      createImapProvider(gmailConfig, {
        id: 'gmail',
        account: gmailConfig.user,
      }),
    )
  }

  return (cachedProviders = providers)
}

// Resolves the provider a stored account id ("<providerId>:<account>") names.
// Message locations and account rows only ever carry ids this same accountId
// scheme produced (src/sync/ingest.ts), so a miss here means the env changed
// since that row was written, not a bug in the lookup.
export function providerForAccountId(accountId: string): MailProvider | null {
  return (
    configuredProviders().find((provider) => `${provider.id}:${provider.account}` === accountId) ??
    null
  )
}
