import {
  accountsRepo as defaultAccounts,
  messagesRepo as defaultMessages,
} from "../db/mail-index";
import type { AccountsRepo } from "../db/accounts";
import type { MessagesRepo } from "../db/messages";
import { configuredProviders as defaultConfiguredProviders } from "../providers/from-env";
import {
  gmailImapConfigFromEnv,
  imapConfigFromEnv,
} from "../providers/imap/config";
import { accountIdFor, ingestMailbox } from "./ingest";
import type { ImapConfig } from "../providers/imap/adapter";
import type { MailProvider } from "../providers/port";
import type { JobHandler } from "../jobs/runner";

// The mailboxes each configured provider ingests, keyed by provider — one
// account's mailbox list must never be applied to the other. Resend has no
// folders — its "sent"/"received" history lists stand in
// (src/providers/resend/adapter.ts); Proton ingests whatever IMAP_MAILBOXES
// names (env.ts default "INBOX,Spam"), Gmail whatever GMAIL_IMAP_MAILBOXES
// names. Exported as an injectable default (rather than called directly) so
// tests can supply a fixed mailbox list per provider without depending on
// real IMAP env.
export function defaultMailboxesFor(
  provider: MailProvider,
  configs: { proton?: ImapConfig; gmail?: ImapConfig } = {
    proton: imapConfigFromEnv(),
    gmail: gmailImapConfigFromEnv(),
  },
): string[] {
  if (provider.id === "resend") return ["sent", "received"];
  if (provider.id === "proton") return configs.proton?.mailboxes ?? [];
  if (provider.id === "gmail") return configs.gmail?.mailboxes ?? [];
  return [];
}

export interface SyncTickResult {
  new: number;
  errors: string[];
}

// Composition root for one sync tick, replacing src/sync/index.ts's
// createSyncRunner: envelope-only ingest of every configured provider's
// mailboxes through the port (docs/architecture.md §Provider port). One
// provider's or mailbox's failure never aborts another's — ingestMailbox
// already isolates per-mailbox failures; the loop here isolates per-provider.
export async function runSyncTick({
  accounts = defaultAccounts,
  messages = defaultMessages,
  providers = defaultConfiguredProviders(),
  mailboxesFor = defaultMailboxesFor,
  enqueueClassify = () => {},
}: {
  accounts?: AccountsRepo;
  messages?: MessagesRepo;
  providers?: MailProvider[];
  mailboxesFor?: (provider: MailProvider) => string[];
  enqueueClassify?: (key: string) => void;
} = {}): Promise<SyncTickResult> {
  let newCount = 0;
  const errors: string[] = [];

  for (const provider of providers) {
    // Own try/catch per provider: ingestMailbox only isolates failures
    // INSIDE its own try block, which starts after accountIdFor/
    // accounts.upsertAccount already ran. A throw from mailboxesFor(provider)
    // (this loop's own header) or from ingestMailbox's pre-try setup would
    // otherwise escape both loops and abort the whole tick, silently
    // skipping every remaining provider/mailbox — the opposite of this
    // function's documented per-provider/per-mailbox isolation guarantee.
    try {
      for (const mailbox of mailboxesFor(provider)) {
        const result = await ingestMailbox({
          provider,
          mailbox,
          accounts,
          messages,
          enqueueClassify,
        });
        newCount += result.new;
        errors.push(...result.errors);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${accountIdFor(provider)}: ${message}`);
    }
  }

  return { new: newCount, errors };
}

// The `sync_tick` job handler (docs/architecture.md §Jobs): the job's own
// claim is the "two containers never sync at once" lease, replacing
// src/sync/index.ts's in-memory `syncing` flag. A fixed subjectKey ("tick")
// at the enqueue site (src/jobs/register.ts) is the intended one-at-a-time
// marker; nothing here enforces it beyond that the runner only ever claims
// (and thus runs) one pending job at a time.
export function createSyncTickHandler({
  enqueueClassify,
}: {
  enqueueClassify?: (key: string) => void;
} = {}): JobHandler {
  return async () => {
    const result = await runSyncTick({ enqueueClassify });
    if (result.errors.length > 0) {
      console.error(
        `sync_tick completed with ${result.errors.length} error(s)`,
        result.errors,
      );
    }
  };
}
