import type { Database } from "bun:sqlite";
import {
  mailDb as defaultMailDb,
  messagesRepo as defaultMessages,
  sendLogRepo as defaultSendLog,
  threadSummariesRepo as defaultThreadSummaries,
} from "../db/mail-index";
import type {
  Classification,
  ListMessagesResult,
  MessageEnvelope,
  MessageLocation,
  MessagesRepo,
} from "../db/messages";
import type { JobQueue, JobRecord } from "../db/jobs";
import type { SendLogRepo } from "../db/send-log";
import type { ThreadSummariesRepo } from "../db/thread-summaries";
import { jobQueue as defaultJobQueue } from "../jobs/queue";
import { providerForAccountId as defaultProviderFor } from "../providers/from-env";
import type { MailProvider, MessageRef } from "../providers/port";
import {
  summarizeThread as defaultSummarizeThread,
  type ThreadMessageForSummary,
} from "../llm/thread-summary";
import { draftReply as defaultDraftReply } from "../llm/draft-reply";
import { getLlmConfig } from "../llm/model";
import { findTemplateEntry } from "../emails/registry";
import { enqueueTemplateSend } from "./template-send";

// The one service layer both doors call (docs/architecture.md §Agent API: "Both
// doors share one service layer; neither talks to SQLite or a provider
// directly") — the REST routes in src/api/plugin.ts now, the MCP tools in a
// later episode. Injectable deps default to the production singletons, matching
// createApiRoutes/createClassifyHandler's own DI style.
type ThreadRowForSummary = Omit<ThreadMessageForSummary, "summary"> & {
  classification: Classification | null;
};

// Every service failure the agent-facing doors can surface, mapped to a stable
// public status + code. Anything not listed here is an upstream LLM or
// provider error whose raw text must never reach a client, so it collapses to
// a generic 502 internal_error. `no_location`/`provider_not_found` (a
// draftable message with no resolvable provider location) share one public
// code rather than echoing the service's internal literal. Both the REST
// routes and the MCP tools route their error strings through this, so the two
// doors never disagree on what a caller sees for the same failure.
const AGENT_ERROR_STATUS: Record<string, { status: number; code: string }> = {
  not_found: { status: 404, code: "not_found" },
  llm_not_configured: { status: 503, code: "llm_not_configured" },
  invalid_cursor: { status: 400, code: "invalid_cursor" },
  no_location: { status: 502, code: "message_unavailable" },
  provider_not_found: { status: 502, code: "message_unavailable" },
  read_failed: { status: 502, code: "read_failed" },
};

export function agentErrorStatus(error: string): {
  status: number;
  code: string;
} {
  return AGENT_ERROR_STATUS[error] ?? { status: 502, code: "internal_error" };
}

// src/db/messages.ts, src/db/mail-submissions.ts and src/db/send-log.ts's
// cursor decoders all throw this same message on a malformed cursor. The
// cursor arrives straight from a `?cursor=` query param (or an MCP argument)
// validated only as an opaque string, so a garbage value would otherwise
// surface as an unhandled 500 instead of a clean 400.
export function isInvalidCursorError(error: unknown): boolean {
  return error instanceof Error && error.message === "Invalid cursor";
}

export function createAgentApi({
  db = defaultMailDb,
  messages = defaultMessages,
  jobs = defaultJobQueue,
  sendLog = defaultSendLog,
  threadSummaries = defaultThreadSummaries,
  providerFor = defaultProviderFor,
  summarizeThread = defaultSummarizeThread,
  draftReply = defaultDraftReply,
  isLlmConfigured = () => getLlmConfig() !== null,
}: {
  db?: Database;
  messages?: MessagesRepo;
  jobs?: JobQueue;
  sendLog?: SendLogRepo;
  threadSummaries?: ThreadSummariesRepo;
  providerFor?: (accountId: string) => MailProvider | null;
  summarizeThread?: typeof defaultSummarizeThread;
  draftReply?: typeof defaultDraftReply;
  isLlmConfigured?: () => boolean;
} = {}) {
  function searchMail({
    q,
    accountIds,
    limit,
  }: {
    q: string;
    accountIds?: string[];
    limit?: number;
  }) {
    const keys = messages.searchMessages(q, { accountIds, limit });

    return {
      via: "fts" as const,
      keys: keys
        .map((key) => {
          const message = messages.getMessage(key);
          if (!message) return null;
          return {
            ...message,
            classification: messages.getClassification(key),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    };
  }

  function readMessage({
    key,
    includeBody,
  }: {
    key: string;
    includeBody?: boolean;
  }):
    | {
        ok: true;
        message: MessageEnvelope & {
          locations: MessageLocation[];
          classification: Classification | null;
          body?: {
            html: string | null;
            text: string | null;
            fetchedAt: string;
          } | null;
        };
      }
    | { ok: false; error: "not_found" } {
    const message = messages.getMessage(key);
    if (!message) return { ok: false as const, error: "not_found" as const };

    const classification = messages.getClassification(key);
    const base = { ...message, classification };
    if (!includeBody) return { ok: true as const, message: base };

    return {
      ok: true as const,
      message: { ...base, body: messages.getBody(key) },
    };
  }

  function getThread({ key }: { key: string }) {
    const message = messages.getMessage(key);
    if (!message) return { ok: false as const, error: "not_found" as const };

    if (!message.threadKey) {
      const classification = messages.getClassification(key);
      return {
        ok: true as const,
        thread: { rows: [{ ...message, classification }], nextCursor: null },
      };
    }

    return {
      ok: true as const,
      thread: messages.listMessages({ threadKey: message.threadKey }),
    };
  }

  // One row, so a cache hit never fetches the whole thread. Falls back to the
  // message's own key when there is no threadKey (its cache key) or the
  // thread lookup comes back empty.
  function latestThreadMessageKey(
    threadKey: string | null,
    fallbackKey: string,
  ): string {
    if (!threadKey) return fallbackKey;
    return (
      messages.listMessages({ threadKey, limit: 1 }).rows[0]?.key ?? fallbackKey
    );
  }

  async function getThreadSummary({ key }: { key: string }) {
    const message = messages.getMessage(key);
    if (!message) return { ok: false as const, error: "not_found" as const };
    if (!isLlmConfigured()) {
      return { ok: false as const, error: "llm_not_configured" as const };
    }

    // A message with no threadKey is summarized and cached on its own key.
    const cacheKey = message.threadKey ?? message.key;

    // The newest message's key is the cache-invalidation key: a thread longer
    // than one 100-row page always reports the same page length, so a row
    // count can never notice an arrival past the cap. One row is cheap on a
    // cache hit; the full page is only fetched on a miss.
    const latestKey = latestThreadMessageKey(message.threadKey, message.key);

    const cachedRow = threadSummaries.getSummary(cacheKey);
    if (cachedRow && cachedRow.latestKey === latestKey) {
      return {
        ok: true as const,
        summary: cachedRow.summary,
        model: cachedRow.model,
        messageCount: cachedRow.messageCount,
        cached: true,
      };
    }

    let rows: ThreadRowForSummary[];
    if (message.threadKey) {
      // 100 = src/db/messages.ts's MAX_LIST_LIMIT: fetch as much of the
      // thread as the store will return in one page. A longer thread is
      // summarized from its newest 100 and never re-caps past that
      // (docs/architecture.md's known gaps).
      rows = messages.listMessages({
        threadKey: message.threadKey,
        limit: 100,
      }).rows;
    } else {
      rows = [
        {
          fromAddress: message.fromAddress,
          subject: message.subject,
          date: message.date,
          direction: message.direction,
          classification: messages.getClassification(key),
        },
      ];
    }

    const outcome = await summarizeThread({
      messages: [...rows]
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
        .map((row) => ({
          fromAddress: row.fromAddress,
          subject: row.subject,
          date: row.date,
          direction: row.direction,
          summary: row.classification?.summary ?? null,
        })),
    });
    if (!outcome.ok) return { ok: false as const, error: outcome.error };

    threadSummaries.saveSummary(cacheKey, {
      summary: outcome.summary,
      model: outcome.model,
      messageCount: rows.length,
      latestKey,
    });
    return {
      ok: true as const,
      summary: outcome.summary,
      model: outcome.model,
      messageCount: rows.length,
      cached: false,
    };
  }

  function listNeedsAction({
    accountIds,
    since,
    until,
    limit,
    cursor,
  }: {
    accountIds?: string[];
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  }): ListMessagesResult {
    return messages.listMessages({
      accountIds,
      actionRequired: true,
      since,
      until,
      limit,
      cursor,
    });
  }

  async function draftReplyForMessage({
    key,
    instructions,
  }: {
    key: string;
    instructions?: string;
  }) {
    const message = messages.getMessage(key);
    if (!message) return { ok: false as const, error: "not_found" as const };
    if (!isLlmConfigured()) {
      return { ok: false as const, error: "llm_not_configured" as const };
    }

    let body = messages.getBody(key);
    if (!body) {
      // One bounded live read for the one message being drafted — never a
      // fan-out (mirrors src/jobs/classify.ts's read).
      const location = message.locations[0];
      if (!location)
        return { ok: false as const, error: "no_location" as const };

      const provider = providerFor(message.account);
      if (!provider) {
        return { ok: false as const, error: "provider_not_found" as const };
      }

      // A thrown provider or DB error here must become a returned outcome:
      // letting it escape would bypass the routes' error mapping and surface
      // as an unmapped 500 (with raw text) instead of a stable 502 code.
      try {
        const full = await provider.read(location.providerRef as MessageRef);
        messages.saveBody(key, { html: full.html, text: full.text });
        body = {
          html: full.html,
          text: full.text,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        console.error("Draft reply body read failed", { error });
        return { ok: false as const, error: "read_failed" as const };
      }
    }

    const outcome = await draftReply({
      message: {
        fromAddress: message.fromAddress,
        subject: message.subject,
        text: body.text,
        html: body.html,
      },
      instructions,
    });
    if (!outcome.ok) return { ok: false as const, error: outcome.error };

    return { ok: true as const, draft: outcome.draft, model: outcome.model };
  }

  function sendTemplate({
    templateId,
    to,
    templateProps,
    subject,
    replyTo,
  }: {
    templateId: string;
    to: string;
    templateProps: unknown;
    subject?: string;
    replyTo?: string;
  }) {
    const entry = findTemplateEntry(templateId);
    if (!entry) return { ok: false as const, error: "not_found" as const };

    const { sendLogId, jobId } = enqueueTemplateSend(
      { db, jobs, sendLog },
      {
        templateId: entry.id,
        to,
        subject: subject ?? `Message: ${entry.name}`,
        templateProps,
        requestedBy: "agent",
        replyTo,
      },
    );

    return { ok: true as const, sendLogId, jobId };
  }

  function getJobStatus({ jobId }: { jobId: string }) {
    const job: JobRecord | null = jobs.getJob(jobId);
    if (!job) return { ok: false as const, error: "not_found" as const };
    return { ok: true as const, job };
  }

  return {
    searchMail,
    readMessage,
    getThread,
    getThreadSummary,
    listNeedsAction,
    draftReply: draftReplyForMessage,
    sendTemplate,
    getJobStatus,
  };
}

export type AgentApi = ReturnType<typeof createAgentApi>;
