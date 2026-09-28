import { imapConfigFromEnv } from "./imap/config";
import { createImapProvider } from "./imap/provider";
import { createResendProvider } from "./resend/adapter";
import { adminResend } from "../utils/resend";
import type { MailProvider } from "./port";

// The Resend adapter's "account" is a stable identity string, not an address
// Resend itself exposes (there is no per-domain API — one key is one tenant
// for this app) — "app" names it for the accounts table and message keys.
const RESEND_ACCOUNT = "app";

let cachedProviders: MailProvider[] | null = null;

// Builds (once per process) every MailProvider the env configures — Resend
// always, IMAP (Proton, via Bridge) only when IMAP_HOST/IMAP_USER/
// IMAP_PASSWORD are set. Shared by the sync tick and every job handler that
// re-fetches a message body, so a provider (and the IMAP session pool it
// owns) is constructed once, not once per job.
export function configuredProviders(): MailProvider[] {
  if (cachedProviders) return cachedProviders;

  const providers: MailProvider[] = [
    createResendProvider({ account: RESEND_ACCOUNT, resend: adminResend }),
  ];

  const imapConfig = imapConfigFromEnv();
  if (imapConfig) {
    providers.push(
      createImapProvider(imapConfig, {
        id: "proton",
        account: imapConfig.user,
      }),
    );
  }

  return (cachedProviders = providers);
}

// Resolves the provider a stored account id ("<providerId>:<account>") names.
// Message locations and account rows only ever carry ids this same accountId
// scheme produced (src/sync/ingest.ts), so a miss here means the env changed
// since that row was written, not a bug in the lookup.
export function providerForAccountId(accountId: string): MailProvider | null {
  return (
    configuredProviders().find(
      (provider) => `${provider.id}:${provider.account}` === accountId,
    ) ?? null
  );
}

// Test-only: forces the next configuredProviders() call to rebuild.
export function resetConfiguredProvidersForTest(): void {
  cachedProviders = null;
}
