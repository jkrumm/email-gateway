import type { Database } from "bun:sqlite";
import type { GetEmailResponseSuccess } from "resend";
import type { ResendClient } from "../providers/resend/client";
import {
  createEmailsRepo,
  type EmailAttachment,
  type UpsertEmailInput,
} from "../db/emails";
import { createSyncStateRepo } from "../db/sync-state";
import { toIsoTimestamp } from "../utils/date";
import type {
  SyncDirectionSummary,
  SyncInboundSummary,
  SyncSummary,
} from "./types";

const PAGE_LIMIT = 100;
const RATE_LIMIT_RETRY_MS = 1_500;
const RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T extends { error: { name?: string } | null }>(
  fn: () => Promise<T>,
): Promise<T> {
  let result = await fn();
  for (
    let attempt = 1;
    result.error?.name === "rate_limit_exceeded" &&
    attempt < RATE_LIMIT_RETRIES;
    attempt++
  ) {
    await sleep(RATE_LIMIT_RETRY_MS);
    result = await fn();
  }
  return result;
}

function toOutboundUpsert(
  full: GetEmailResponseSuccess,
  { withBody }: { withBody: boolean },
): UpsertEmailInput {
  return {
    id: full.id,
    direction: "outbound",
    fromAddress: full.from,
    toAddresses: full.to,
    cc: full.cc,
    bcc: full.bcc,
    replyTo: full.reply_to,
    subject: full.subject,
    createdAt: toIsoTimestamp(full.created_at),
    lastEvent: full.last_event,
    html: withBody ? full.html : undefined,
    text: withBody ? full.text : undefined,
  };
}

async function syncOutbound(
  emails: ReturnType<typeof createEmailsRepo>,
  resend: ResendClient,
  errors: string[],
  // Only trust the "known id → stop" pagination shortcut when the previous
  // run for this direction completed without errors — otherwise a prior
  // partial failure could leave older emails permanently un-synced.
  trustKnownIdShortcut: boolean,
): Promise<SyncDirectionSummary> {
  let newCount = 0;
  let updatedCount = 0;
  let after: string | undefined;

  while (true) {
    const page = await withRetry(() =>
      resend.emails.list({
        limit: PAGE_LIMIT,
        after,
      }),
    );

    if (page.error) {
      errors.push(`outbound list: ${page.error.message}`);
      break;
    }

    const { data, has_more } = page.data;
    if (data.length === 0) break;

    const knownIds = emails.knownEmailIds(data.map((item) => item.id));
    let sawKnown = false;

    for (const item of data) {
      if (knownIds.has(item.id)) {
        const existing = emails.getEmail(item.id);
        sawKnown = true;
        if (existing?.html === null) {
          const full = await withRetry(() => resend.emails.get(item.id));
          if (full.error) {
            errors.push(`outbound get ${item.id}: ${full.error.message}`);
            continue;
          }
          emails.upsertEmail(toOutboundUpsert(full.data, { withBody: true }));
        } else {
          emails.upsertEmail({
            id: item.id,
            direction: "outbound",
            fromAddress: item.from,
            toAddresses: item.to,
            cc: item.cc,
            bcc: item.bcc,
            replyTo: item.reply_to,
            subject: item.subject,
            createdAt: toIsoTimestamp(item.created_at),
            lastEvent: item.last_event,
          });
        }
        updatedCount++;
        continue;
      }

      const full = await withRetry(() => resend.emails.get(item.id));
      if (full.error) {
        errors.push(`outbound get ${item.id}: ${full.error.message}`);
        continue;
      }

      emails.upsertEmail(toOutboundUpsert(full.data, { withBody: true }));
      newCount++;
    }

    if ((trustKnownIdShortcut && sawKnown) || !has_more) break;
    after = data[data.length - 1]?.id;
  }

  return { new: newCount, updated: updatedCount };
}

async function syncInbound(
  emails: ReturnType<typeof createEmailsRepo>,
  resend: ResendClient,
  errors: string[],
  trustKnownIdShortcut: boolean,
): Promise<SyncInboundSummary> {
  let newCount = 0;
  let after: string | undefined;

  while (true) {
    const page = await withRetry(() =>
      resend.emails.receiving.list({ limit: PAGE_LIMIT, after }),
    );

    if (page.error) {
      errors.push(`inbound list: ${page.error.message}`);
      break;
    }

    const { data, has_more } = page.data;
    if (data.length === 0) break;

    const knownIds = emails.knownEmailIds(data.map((item) => item.id));
    let sawKnown = false;

    for (const item of data) {
      if (knownIds.has(item.id)) {
        sawKnown = true;
        continue;
      }

      const full = await withRetry(() => resend.emails.receiving.get(item.id));
      if (full.error) {
        errors.push(`inbound get ${item.id}: ${full.error.message}`);
        continue;
      }

      const attachments: EmailAttachment[] = full.data.attachments.map(
        (attachment) => ({
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
        }),
      );

      emails.upsertEmail({
        id: full.data.id,
        direction: "inbound",
        fromAddress: full.data.from,
        toAddresses: full.data.to,
        cc: full.data.cc,
        bcc: full.data.bcc,
        replyTo: full.data.reply_to,
        subject: full.data.subject,
        createdAt: toIsoTimestamp(full.data.created_at),
        html: full.data.html,
        text: full.data.text,
        attachments,
      });
      newCount++;
    }

    if ((trustKnownIdShortcut && sawKnown) || !has_more) break;
    after = data[data.length - 1]?.id;
  }

  return { new: newCount };
}

export async function syncEmails({
  db,
  resend,
}: {
  db: Database;
  resend: ResendClient;
}): Promise<SyncSummary> {
  const emails = createEmailsRepo(db);
  const syncState = createSyncStateRepo(db);
  const errors: string[] = [];

  const outboundState = syncState.getState("outbound");
  const outbound = await syncOutbound(
    emails,
    resend,
    errors,
    outboundState?.lastRunComplete ?? true,
  );

  const inboundState = syncState.getState("inbound");
  const inbound = await syncInbound(
    emails,
    resend,
    errors,
    inboundState?.lastRunComplete ?? true,
  );

  syncState.recordRun("outbound", {
    complete: !errors.some((error) => error.startsWith("outbound")),
  });
  syncState.recordRun("inbound", {
    complete: !errors.some((error) => error.startsWith("inbound")),
  });

  return { outbound, inbound, errors };
}
