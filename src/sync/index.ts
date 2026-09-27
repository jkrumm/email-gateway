import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db/client";
import { errorMessage } from "../utils/error";
import { runEnrichmentBatch } from "../enrich/worker";
import { kickJevWorker } from "../jev/worker";
import { adminResend } from "../utils/resend";
import { imapConfigFromEnv } from "../providers/imap/config";
import { createImapflowPort, type ImapPort } from "../providers/imap/adapter";
import { syncImap } from "./imap-sync";
import { syncEmails } from "./resend-sync";
import type { SyncSummary } from "./types";
import type { ResendClient } from "../providers/resend/client";

const SYNC_INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 5_000;

// Composition root for every ingest source: owns the "one sync at a time"
// lock, isolates each source's failure from the others, and decides whether
// the enrichment and Jev workers need a kick.
export function createSyncRunner({
  db,
  resend,
  imap,
  enrich,
  kickJev = kickJevWorker,
}: {
  db: Database;
  resend: ResendClient;
  imap?: { port: ImapPort; mailboxes: string[] };
  enrich: () => Promise<void>;
  kickJev?: () => void;
}) {
  let syncing = false;

  async function runAllSources(): Promise<SyncSummary | { busy: true }> {
    if (syncing) return { busy: true };

    syncing = true;
    const summary: SyncSummary = {
      outbound: { new: 0, updated: 0 },
      inbound: { new: 0 },
      errors: [],
    };

    try {
      try {
        Object.assign(summary, await syncEmails({ db, resend }));
      } catch (error) {
        summary.errors.push(`resend: ${errorMessage(error)}`);
      }

      if (imap) {
        try {
          const result = await syncImap({
            db,
            port: imap.port,
            mailboxes: imap.mailboxes,
          });
          summary.imap = result.summary;
          summary.errors.push(...result.errors);
        } catch (error) {
          summary.errors.push(`imap: ${errorMessage(error)}`);
        }
      }

      if (summary.errors.length > 0) {
        console.error(
          `sync completed with ${summary.errors.length} error(s)`,
          summary.errors,
        );
      }

      if (
        summary.outbound.new > 0 ||
        summary.inbound.new > 0 ||
        (summary.imap?.new ?? 0) > 0
      ) {
        kickJev();
        void Promise.resolve()
          .then(enrich)
          .catch((error) => {
            console.error("Post-sync enrichment batch failed", { error });
          });
      }
      return summary;
    } finally {
      syncing = false;
    }
  }

  return { runAllSources };
}

let defaultRunner: ReturnType<typeof createSyncRunner> | null = null;

function getDefaultRunner() {
  if (defaultRunner) return defaultRunner;

  const config = imapConfigFromEnv();
  if (config?.tlsInsecure && !config.tlsCert) {
    console.warn(
      "[imap] IMAP_TLS_INSECURE=true — the IMAP server certificate is not verified. Only acceptable over a WireGuard/Tailscale path; prefer IMAP_TLS_CERT.",
    );
  }

  defaultRunner = createSyncRunner({
    db: defaultDb,
    resend: adminResend,
    imap: config && {
      port: createImapflowPort(config),
      mailboxes: config.mailboxes,
    },
    enrich: runEnrichmentBatch,
  });
  return defaultRunner;
}

export function runSyncNow(): Promise<SyncSummary | { busy: true }> {
  return getDefaultRunner().runAllSources();
}

export function startSync(): void {
  if (process.env.NODE_ENV === "test") return;

  const runAndLog = () =>
    void runSyncNow().catch((error) => {
      console.error("Scheduled sync failed", { error });
    });

  const timer = setTimeout(() => {
    runAndLog();
    const interval = setInterval(runAndLog, SYNC_INTERVAL_MS);
    interval.unref();
  }, FIRST_RUN_DELAY_MS);
  timer.unref();
}
