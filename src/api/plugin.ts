import { Elysia, t } from "elysia";
import { timingSafeEqualStrings } from "../auth";
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
  messagesRepo as defaultMessages,
  mailSubmissionsRepo as defaultMailSubmissions,
} from "../db/mail-index";
import type { AccountsRepo } from "../db/accounts";
import type {
  Classification,
  ListMessagesFilters,
  MessageEnvelope,
  MessageLocation,
  MessagesRepo,
} from "../db/messages";
import type {
  MailSubmissionsRepo,
  SubmissionSource,
  Verdict,
} from "../db/mail-submissions";
import { enqueueSyncTick, jobQueue as defaultJobQueue } from "../jobs/queue";
import type { JobQueue } from "../db/jobs";
import { accountIdFor } from "../sync/ingest";
import {
  configuredProviders as defaultConfiguredProviders,
  providerForAccountId as defaultProviderFor,
} from "../providers/from-env";
import type { MailProvider, MessageRef } from "../providers/port";

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

// src/db/messages.ts, src/db/mail-submissions.ts and src/db/send-log.ts's
// cursor decoders all throw this same message on a malformed cursor. The
// cursor arrives straight from a `?cursor=` query param validated only as an
// opaque string, so a garbage value would otherwise surface as an unhandled
// 500 instead of a clean 400.
function isInvalidCursorError(error: unknown): boolean {
  return error instanceof Error && error.message === "Invalid cursor";
}

function splitList(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

type MessageSummary = MessageEnvelope & {
  classification: Classification | null;
};

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

// Reshapes a new-schema message into a subset of the old `/api/emails*`
// field names — NOT a byte-compatible replay of the pre-Wave-4 shape.
// Confirmed 2026-09-28: Hermes has no live caller of `/api/emails*` today
// (it reads Gmail through argo's own proxy; Wave 8 is what repoints it to
// this API), so nothing currently depends on exact compatibility. Dropped
// vs. the old shape: text/html (use `?include=body` on the new
// `/api/messages/:key` instead), attachments, cc/bcc/replyTo, source,
// provider, mailbox, messageId; `source`/`provider`/`mailbox`/`from`/`to`/`q`
// query filters are gone and `category` no longer accepts a comma-separated
// list; `POST /api/emails/:id/enrich` now returns `{ enqueued: true }`
// instead of a synchronous enrichment result. Whoever wires a real caller
// onto this alias (or onto `/api/messages` directly, the intended
// replacement) needs to account for all of that — this function exists so
// the alias doesn't 404, not so it round-trips the old contract.
function toLegacyEmail(row: MessageSummary) {
  const classification = row.classification;
  return {
    id: row.key,
    direction: row.direction,
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    subject: row.subject,
    createdAt: row.date,
    enrichment: classification
      ? {
          category: classification.category,
          priority: classification.priority,
          actionRequired: classification.actionRequired,
          summary: classification.summary,
          suggestedAction: classification.suggestedAction,
          language: classification.language,
          facts: classification.facts,
          model: classification.model,
          error: classification.error,
          jev: {
            spamProbability: classification.jevSpamProbability,
            category: classification.jevCategory,
            categoryConfidence: classification.jevCategoryConfidence,
            latencyMs: classification.jevLatencyMs,
            model: classification.jevModel,
            error: classification.jevError,
          },
        }
      : null,
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

// Same shape as messagesListQuery — kept as a distinct schema (rather than a
// shared reference) so the two endpoints can diverge later without a
// coupled edit, matching this file's existing style (emailsListQuery already
// duplicated most of these fields before this rewrite).
const emailsListQuery = t.Object({
  account: t.Optional(t.String()),
  direction: t.Optional(t.Union([t.Literal("inbound"), t.Literal("outbound")])),
  category: t.Optional(t.String()),
  action_required: t.Optional(t.String()),
  needs_me: t.Optional(t.String()),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
  // Retired: the old enrichment-queue `status` (pending/done/failed) has no
  // equivalent on the new `classifications` table — that state now lives on
  // `jobs`, not joinable here without real complexity. Accepted but ignored.
  status: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

const emailByIdQuery = t.Object({
  include: t.Optional(t.String()),
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
  messages = defaultMessages,
  mailSubmissions = defaultMailSubmissions,
  accounts = defaultAccounts,
  jobs = defaultJobQueue,
  providerFor = defaultProviderFor,
  configuredProviders = defaultConfiguredProviders,
}: {
  apiKey: string | undefined;
  // When set, a same-origin request carrying the /app session cookie is
  // accepted as an alternative to the bearer — that is how the browser client
  // reads data. The bearer contract for agents is unchanged.
  session?: { secret: string; now?: () => number };
  messages?: MessagesRepo;
  mailSubmissions?: MailSubmissionsRepo;
  accounts?: AccountsRepo;
  jobs?: JobQueue;
  providerFor?: (accountId: string) => MailProvider | null;
  configuredProviders?: () => MailProvider[];
}) {
  const configured = apiKey !== undefined || session !== undefined;

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

      const authorization = headers.authorization;
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;

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
        const message = messages.getMessage(params.key);
        if (!message) {
          set.status = 404;
          return { error: "not_found" };
        }

        const classification = messages.getClassification(params.key);
        const base = { ...message, classification };
        if (query.include !== "body") return base;

        return { ...base, body: messages.getBody(params.key) };
      },
      { params: t.Object({ key: t.String() }), query: messageByKeyQuery },
    )
    .get(
      "/threads/:key",
      ({ params, set }) => {
        const message = messages.getMessage(params.key);
        if (!message) {
          set.status = 404;
          return { error: "not_found" };
        }

        if (!message.threadKey) {
          const classification = messages.getClassification(params.key);
          return { rows: [{ ...message, classification }], nextCursor: null };
        }

        return messages.listMessages({ threadKey: message.threadKey });
      },
      { params: t.Object({ key: t.String() }) },
    )
    .get(
      "/search",
      ({ query }) => {
        const keys = messages.searchMessages(query.q, {
          accountIds: splitList(query.account),
          limit: query.limit,
        });

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
      },
      { query: searchQuery },
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
    )
    .get(
      "/emails",
      ({ query, set }) => {
        try {
          const result = messages.listMessages(messagesFilters(query));
          return {
            data: result.rows.map(toLegacyEmail),
            nextCursor: result.nextCursor,
          };
        } catch (error) {
          if (!isInvalidCursorError(error)) throw error;
          set.status = 400;
          return { error: "invalid_cursor" };
        }
      },
      { query: emailsListQuery },
    )
    .get(
      "/emails/:id",
      ({ params, query, set }) => {
        const message = messages.getMessage(params.id);
        if (!message) {
          set.status = 404;
          return { error: "not_found" };
        }

        const classification = messages.getClassification(params.id);
        const base = toLegacyEmail({ ...message, classification });
        if (query.include !== "html") return base;

        // Never triggers a live provider read — only the message/threads
        // routes and the classify job populate body_cache.
        const body = messages.getBody(params.id);
        return { ...base, html: body?.html ?? null, text: body?.text ?? null };
      },
      { params: t.Object({ id: t.String() }), query: emailByIdQuery },
    )
    .post(
      "/emails/:id/enrich",
      ({ params, set }) => {
        const existing = messages.getMessage(params.id);
        if (!existing) {
          set.status = 404;
          return { error: "not_found" };
        }

        jobs.enqueue({
          kind: "classify",
          payload: { key: params.id },
          subjectKey: params.id,
        });
        return { enqueued: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
}

const apiSessionSecret = sessionSecret(env.ADMIN_PASSWORD, env.COOKIE_SECRET);

export const apiRoutes = createApiRoutes({
  apiKey: env.API_KEY,
  session: apiSessionSecret ? { secret: apiSessionSecret } : undefined,
});
