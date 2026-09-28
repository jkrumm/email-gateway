import { render } from "@react-email/render";
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { extractBearerToken, timingSafeEqualStrings } from "../auth";
import { splitCsv as splitList } from "../utils/csv";
import { env } from "../env";
import {
  handleCookieSignatureError,
  isSameOrigin,
  isSessionValue,
  sessionCookieOptions,
  sessionSecret,
} from "../session";
import {
  accountsRepo as defaultAccounts,
  mailDb as defaultMailDb,
  messagesRepo as defaultMessages,
  mailSubmissionsRepo as defaultMailSubmissions,
  sendLogRepo as defaultSendLog,
  templatesRepo as defaultTemplates,
  threadSummariesRepo as defaultThreadSummaries,
} from "../db/mail-index";
import type { AccountsRepo } from "../db/accounts";
import type {
  ListMessagesFilters,
  MessageLocation,
  MessagesRepo,
} from "../db/messages";
import type {
  MailSubmissionsRepo,
  SubmissionSource,
  Verdict,
} from "../db/mail-submissions";
import type { SendLogRepo } from "../db/send-log";
import type { TemplatesRepo } from "../db/templates";
import type { ThreadSummariesRepo } from "../db/thread-summaries";
import { findTemplateEntry, renderTemplateElement } from "../emails/registry";
import { enqueueSyncTick, jobQueue as defaultJobQueue } from "../jobs/queue";
import type { JobQueue } from "../db/jobs";
import { accountIdFor } from "../sync/ingest";
import {
  configuredProviders as defaultConfiguredProviders,
  providerForAccountId as defaultProviderFor,
} from "../providers/from-env";
import type { MailProvider, MessageRef } from "../providers/port";
import {
  agentErrorStatus,
  createAgentApi,
  isInvalidCursorError,
  type AgentApi,
} from "../services/agent-api";
import { enqueueTemplateSend } from "../services/template-send";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

function defaultSince(): string {
  return new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
}

// Accepts "1" (the architecture doc's `needs_me=1`) or "true" as true, "0" or
// "false" as false — a plain t.BooleanString() only accepts "true"/"false",
// which would silently reject the exact query shape the brief asks for.
// Anything else (a typo like "tru", an empty string) is treated as "no
// filter" rather than coerced to false: a truthy-vs-falsy fallback here would
// silently turn `?needs_me=tru` into a real `actionRequired: false` filter,
// returning the wrong, non-empty result set instead of the unfiltered one.
function parseFlag(value: string | undefined): boolean | undefined {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function messagesFilters(query: {
  account?: string;
  direction?: "inbound" | "outbound";
  category?: string;
  action_required?: string;
  needs_me?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}): ListMessagesFilters {
  return {
    accountIds: splitList(query.account),
    direction: query.direction,
    category: query.category,
    actionRequired:
      parseFlag(query.needs_me) ?? parseFlag(query.action_required),
    since: query.since,
    until: query.until,
    limit: query.limit,
    cursor: query.cursor,
  };
}

function findLocation(
  locations: MessageLocation[],
  mailbox: string,
): MessageLocation | undefined {
  return locations.find((location) => location.mailbox === mailbox);
}

const messagesListQuery = t.Object({
  account: t.Optional(t.String()),
  direction: t.Optional(t.Union([t.Literal("inbound"), t.Literal("outbound")])),
  category: t.Optional(t.String()),
  action_required: t.Optional(t.String()),
  needs_me: t.Optional(t.String()),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

// GET /api/needs-action's own query: messagesListQuery minus the filters that
// are meaningless here (direction/category/needs_me/action_required — this
// endpoint IS the actionRequired: true filter).
const needsActionQuery = t.Object({
  account: t.Optional(t.String()),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

const draftBody = t.Object({
  key: t.String(),
  instructions: t.Optional(t.String()),
});

const sendBody = t.Object({
  templateId: t.String(),
  to: t.String({ format: "email" }),
  // Required: a bare t.Unknown() would accept an omitted field, and
  // src/jobs/send.ts's renderTemplateElement then defaults to the template's
  // previewProps — silently mailing demo content to a real recipient.
  templateProps: t.Record(t.String(), t.Unknown()),
  subject: t.Optional(t.String()),
  replyTo: t.Optional(t.String({ format: "email" })),
});

const messageByKeyQuery = t.Object({
  include: t.Optional(t.String()),
});

const statsQuery = t.Object({
  since: t.Optional(t.String()),
});

const submissionsListQuery = t.Object({
  verdict: t.Optional(
    t.Union([t.Literal("legit"), t.Literal("spam"), t.Literal("marketing")]),
  ),
  source: t.Optional(t.Union([t.Literal("fpp"), t.Literal("sy-serendipity")])),
  delivered: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

const sendLogListQuery = t.Object({
  templateId: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

// `width` is advisory only: the client uses it to frame its own preview, so
// the server validates it as a number and otherwise ignores it.
const templatePreviewQuery = t.Object({
  width: t.Optional(t.Numeric()),
});

const searchQuery = t.Object({
  q: t.String(),
  account: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const flagsBody = t.Object({
  mailbox: t.String(),
  add: t.Optional(t.Array(t.String())),
  remove: t.Optional(t.Array(t.String())),
  set: t.Optional(t.Array(t.String())),
});

const moveBody = t.Object({
  mailbox: t.String(),
  toMailbox: t.String(),
});

export function createApiRoutes({
  apiKey,
  session,
  db = defaultMailDb,
  messages = defaultMessages,
  mailSubmissions = defaultMailSubmissions,
  accounts = defaultAccounts,
  jobs = defaultJobQueue,
  templates = defaultTemplates,
  sendLog = defaultSendLog,
  threadSummaries = defaultThreadSummaries,
  providerFor = defaultProviderFor,
  configuredProviders = defaultConfiguredProviders,
  agentApi,
}: {
  apiKey: string | undefined;
  // When set, a same-origin request carrying the /app session cookie is
  // accepted as an alternative to the bearer — that is how the browser client
  // reads data. The bearer contract for agents is unchanged.
  session?: { secret: string; now?: () => number };
  // The write connection the send/test-send transaction helper wraps; defaults
  // to the production mail.sqlite singleton and matches the repos above.
  db?: Database;
  messages?: MessagesRepo;
  mailSubmissions?: MailSubmissionsRepo;
  accounts?: AccountsRepo;
  jobs?: JobQueue;
  templates?: TemplatesRepo;
  sendLog?: SendLogRepo;
  threadSummaries?: ThreadSummariesRepo;
  providerFor?: (accountId: string) => MailProvider | null;
  configuredProviders?: () => MailProvider[];
  // Injectable for tests; defaulted from the repos above so the routes and
  // (later) the MCP tools share one implementation.
  agentApi?: AgentApi;
}) {
  const configured = apiKey !== undefined || session !== undefined;

  const service =
    agentApi ??
    createAgentApi({
      db,
      messages,
      jobs,
      sendLog,
      threadSummaries,
      providerFor,
    });

  // Shared by /messages/:key/flags and /messages/:key/move: both need the
  // same message → location → provider chain before doing anything specific.
  function resolveMessageLocation(
    key: string,
    mailbox: string,
  ):
    | { ok: true; location: MessageLocation; provider: MailProvider }
    | { ok: false; status: number; error: string } {
    const message = messages.getMessage(key);
    if (!message) return { ok: false, status: 404, error: "not_found" };

    const location = findLocation(message.locations, mailbox);
    if (!location) {
      return { ok: false, status: 404, error: "location_not_found" };
    }

    const provider = providerFor(message.account);
    if (!provider) {
      return { ok: false, status: 404, error: "provider_not_found" };
    }

    return { ok: true, location, provider };
  }

  return new Elysia(
    session
      ? {
          prefix: "/api",
          cookie: sessionCookieOptions(session.secret),
        }
      : { prefix: "/api" },
  )
    .onBeforeHandle(({ headers, request, cookie, set }) => {
      if (!configured) {
        set.status = 404;
        return { error: "not_found" };
      }

      const token = extractBearerToken(headers.authorization);

      if (
        token &&
        apiKey !== undefined &&
        timingSafeEqualStrings(token, apiKey)
      )
        return;

      // Browser door: the signed /app session cookie, same-origin only. A
      // tampered cookie is rejected by Elysia before this runs (see onError).
      if (
        session &&
        isSameOrigin(request) &&
        isSessionValue(cookie?.session?.value, (session.now ?? Date.now)())
      ) {
        return;
      }

      set.status = 401;
      set.headers["WWW-Authenticate"] =
        `Bearer realm='api', error="invalid_token"`;
      return { error: "unauthorized" };
    })
    .onError(({ error, set }) => handleCookieSignatureError(error, set))
    .get("/accounts", () =>
      configuredProviders().map((provider) => ({
        id: accountIdFor(provider),
        provider: provider.id,
        address: provider.account,
      })),
    )
    .get(
      "/messages",
      ({ query, set }) => {
        try {
          return messages.listMessages(messagesFilters(query));
        } catch (error) {
          if (!isInvalidCursorError(error)) throw error;
          set.status = 400;
          return { error: "invalid_cursor" };
        }
      },
      { query: messagesListQuery },
    )
    .get(
      "/messages/:key",
      ({ params, query, set }) => {
        const outcome = service.readMessage({
          key: params.key,
          includeBody: query.include === "body",
        });
        if (!outcome.ok) {
          set.status = 404;
          return { error: outcome.error };
        }

        return outcome.message;
      },
      { params: t.Object({ key: t.String() }), query: messageByKeyQuery },
    )
    .get(
      "/threads/:key",
      ({ params, set }) => {
        const outcome = service.getThread({ key: params.key });
        if (!outcome.ok) {
          set.status = 404;
          return { error: outcome.error };
        }

        return outcome.thread;
      },
      { params: t.Object({ key: t.String() }) },
    )
    .get(
      "/threads/:key/summary",
      async ({ params, set }) => {
        const outcome = await service.getThreadSummary({ key: params.key });
        if (!outcome.ok) {
          const { status, code } = agentErrorStatus(outcome.error);
          set.status = status;
          return { error: code };
        }

        return {
          summary: outcome.summary,
          model: outcome.model,
          messageCount: outcome.messageCount,
          cached: outcome.cached,
        };
      },
      { params: t.Object({ key: t.String() }) },
    )
    .get(
      "/search",
      ({ query }) =>
        service.searchMail({
          q: query.q,
          accountIds: splitList(query.account),
          limit: query.limit,
        }),
      { query: searchQuery },
    )
    .post(
      "/drafts",
      async ({ body, set }) => {
        const outcome = await service.draftReply({
          key: body.key,
          instructions: body.instructions,
        });
        if (!outcome.ok) {
          const { status, code } = agentErrorStatus(outcome.error);
          set.status = status;
          return { error: code };
        }

        return { draft: outcome.draft, model: outcome.model };
      },
      { body: draftBody },
    )
    .post(
      "/sends",
      ({ body, set }) => {
        const outcome = service.sendTemplate({
          templateId: body.templateId,
          to: body.to,
          templateProps: body.templateProps,
          subject: body.subject,
          replyTo: body.replyTo,
        });
        if (!outcome.ok) {
          set.status = 404;
          return { error: "not_found" };
        }

        return {
          enqueued: true,
          sendLogId: outcome.sendLogId,
          jobId: outcome.jobId,
        };
      },
      { body: sendBody },
    )
    .get(
      "/needs-action",
      ({ query, set }) => {
        try {
          return service.listNeedsAction({
            accountIds: splitList(query.account),
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
          });
        } catch (error) {
          if (!isInvalidCursorError(error)) throw error;
          set.status = 400;
          return { error: "invalid_cursor" };
        }
      },
      { query: needsActionQuery },
    )
    .post(
      "/messages/:key/flags",
      async ({ params, body, set }) => {
        const resolved = resolveMessageLocation(params.key, body.mailbox);
        if (!resolved.ok) {
          set.status = resolved.status;
          return { error: resolved.error };
        }
        const { location, provider } = resolved;

        const capabilities = await provider.capabilities();
        if (!capabilities.flag) {
          set.status = 501;
          return { error: "flag_not_supported" };
        }

        await provider.setFlags(location.providerRef as MessageRef, {
          add: body.add,
          remove: body.remove,
          set: body.set,
        });
        return { ok: true };
      },
      { params: t.Object({ key: t.String() }), body: flagsBody },
    )
    .post(
      "/messages/:key/move",
      async ({ params, body, set }) => {
        const resolved = resolveMessageLocation(params.key, body.mailbox);
        if (!resolved.ok) {
          set.status = resolved.status;
          return { error: resolved.error };
        }
        const { location, provider } = resolved;

        const capabilities = await provider.capabilities();
        if (!capabilities.move) {
          set.status = 501;
          return { error: "move_not_supported" };
        }

        const newRef = await provider.move(
          location.providerRef as MessageRef,
          body.toMailbox,
        );
        // Records the new location under the fresh ref so a subsequent
        // flags/move call finds it immediately, then removes the OLD
        // mailbox's location row so it can't resolve a now-stale providerRef
        // (the uid no longer exists there) on a later /flags or /move call.
        // Skipped when toMailbox === mailbox (a same-mailbox relabel): the
        // upsert above already wrote the new location under that exact
        // (key, mailbox) row, so removing "the old location for `mailbox`"
        // would delete the row just written, leaving the message with zero
        // locations and 404-ing every later /flags or /move call.
        // This does not fully solve message-identity-across-a-move: the NEXT
        // sync tick's envelope-only ingest has no way to recognize "this is
        // the same message, just moved" (that needs the body's real
        // Message-ID, which sync never fetches) — it may still create a
        // second message row (and a second classifications row) for this
        // mail under its new mailbox+uid identity. Accepted gap for this
        // wave (docs/architecture.md's known gaps), tracked, not pretended
        // away.
        messages.upsertLocation(params.key, {
          mailbox: body.toMailbox,
          uidValidity: "uidValidity" in newRef ? newRef.uidValidity : null,
          uid: "uid" in newRef ? newRef.uid : null,
          providerRef: newRef,
          lastSeenAt: new Date().toISOString(),
        });
        if (body.toMailbox !== body.mailbox) {
          messages.removeLocation(params.key, body.mailbox);
        }
        return { ok: true };
      },
      { params: t.Object({ key: t.String() }), body: moveBody },
    )
    .get(
      "/submissions",
      ({ query, set }) => {
        try {
          return mailSubmissions.listSubmissions({
            verdict: query.verdict as Verdict | undefined,
            source: query.source as SubmissionSource | undefined,
            delivered: parseFlag(query.delivered),
            limit: query.limit,
            cursor: query.cursor,
          });
        } catch (error) {
          if (!isInvalidCursorError(error)) throw error;
          set.status = 400;
          return { error: "invalid_cursor" };
        }
      },
      { query: submissionsListQuery },
    )
    .get("/templates", () => templates.listTemplates())
    .get(
      "/templates/:id/preview",
      async ({ params, set }) => {
        const entry = findTemplateEntry(params.id);
        if (!entry) {
          set.status = 404;
          return { error: "not_found" };
        }

        const html = await render(renderTemplateElement(entry));
        set.headers["content-type"] = "text/html; charset=utf-8";
        // Belt-and-suspenders against the client's own iframe sandboxing:
        // this response is safe to load directly (a bookmark, a middle-click
        // "open in new tab" on the raw-HTML link) regardless of how it's
        // reached, not just when embedded through the sandboxed iframe.
        set.headers["content-security-policy"] = "sandbox";
        return html;
      },
      { params: t.Object({ id: t.String() }), query: templatePreviewQuery },
    )
    .post(
      "/templates/:id/test-send",
      ({ params, set }) => {
        const entry = findTemplateEntry(params.id);
        if (!entry) {
          set.status = 404;
          return { error: "not_found" };
        }

        const { sendLogId, jobId } = enqueueTemplateSend(
          { db, jobs, sendLog },
          {
            templateId: entry.id,
            to: env.RECEIVER_EMAIL,
            subject: `Test send: ${entry.name}`,
            templateProps: entry.previewProps,
            requestedBy: "test-send",
          },
        );
        templates.recordTestSend(entry.id);

        return { enqueued: true, sendLogId, jobId };
      },
      { params: t.Object({ id: t.String() }) },
    )
    .get(
      "/send-log",
      ({ query, set }) => {
        try {
          return sendLog.listSendLog({
            templateId: query.templateId,
            limit: query.limit,
            cursor: query.cursor,
          });
        } catch (error) {
          if (!isInvalidCursorError(error)) throw error;
          set.status = 400;
          return { error: "invalid_cursor" };
        }
      },
      { query: sendLogListQuery },
    )
    .get(
      "/stats",
      ({ query }) => {
        const since = query.since ?? defaultSince();
        return {
          messages: messages.getStats({ since }),
          jevComparison: mailSubmissions.getJevComparison({ since }),
          // Every job kind combined — src/db/jobs.ts's counts() has no
          // per-kind breakdown yet, unlike the old Jev-specific jevQueue
          // counts it replaces.
          jobs: jobs.counts(),
          accounts: accounts.listAccounts(),
        };
      },
      { query: statsQuery },
    )
    .post("/sync", () => {
      // Async now: jobs don't run inline, so there is no tick result to
      // return synchronously and no in-memory "busy" flag to 409 on. A
      // duplicate enqueue is harmless (the sync_tick handler re-lists from
      // its saved cursor, per src/jobs/register.ts).
      enqueueSyncTick(jobs);
      return { enqueued: true };
    })
    .get(
      "/jobs/:id",
      ({ params, set }) => {
        const job = jobs.getJob(params.id);
        if (!job) {
          set.status = 404;
          return { error: "not_found" };
        }
        return job;
      },
      { params: t.Object({ id: t.String() }) },
    );
}

const apiSessionSecret = sessionSecret(env.ADMIN_PASSWORD, env.COOKIE_SECRET);

export const apiRoutes = createApiRoutes({
  apiKey: env.API_KEY,
  session: apiSessionSecret ? { secret: apiSessionSecret } : undefined,
});
