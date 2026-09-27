import { Elysia, t } from "elysia";
import { timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import { enrichEmail } from "../enrich/enrich-email";
import { reEnrichEmail } from "../enrich/re-enrich";
import { emailsRepo, imapStateRepo, submissionsRepo } from "../db";
import { runSyncNow } from "../sync";
import type {
  EmailDirection,
  EmailsRepo,
  EnrichmentStatus,
} from "../db/emails";
import type { ImapStateRepo } from "../db/imap-state";
import { sumJevQueue } from "../db/jev-queue";
import type {
  SubmissionsRepo,
  SubmissionSource,
  Verdict,
} from "../db/submissions";
import type { SyncSummary } from "../sync/types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

function defaultSince(): string {
  return new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
}

const emailsListQuery = t.Object({
  direction: t.Optional(t.Union([t.Literal("inbound"), t.Literal("outbound")])),
  // Comma-separated, e.g. ?category=inquiry,customer
  category: t.Optional(t.String()),
  source: t.Optional(t.String()),
  provider: t.Optional(t.Union([t.Literal("resend"), t.Literal("imap")])),
  mailbox: t.Optional(t.String()),
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  q: t.Optional(t.String()),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
  action_required: t.Optional(t.BooleanString()),
  status: t.Optional(
    t.Union([t.Literal("pending"), t.Literal("done"), t.Literal("failed")]),
  ),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

const emailByIdQuery = t.Object({
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
  delivered: t.Optional(t.BooleanString()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

export function createApiRoutes({
  apiKey,
  emails,
  submissions,
  imapState,
  runSync,
}: {
  apiKey: string | undefined;
  emails: EmailsRepo;
  submissions: SubmissionsRepo;
  imapState: ImapStateRepo;
  runSync: () => Promise<SyncSummary | { busy: true }>;
}) {
  const configured = apiKey !== undefined;

  return new Elysia({ prefix: "/api" })
    .onBeforeHandle(({ headers, set }) => {
      if (!configured) {
        set.status = 404;
        return { error: "not_found" };
      }

      const authorization = headers.authorization;
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;

      if (!token || !timingSafeEqualStrings(token, apiKey)) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          `Bearer realm='api', error="invalid_token"`;
        return { error: "unauthorized" };
      }
    })
    .get(
      "/emails",
      ({ query }) =>
        emails.listEmails({
          direction: query.direction as EmailDirection | undefined,
          category: query.category
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          source: query.source,
          provider: query.provider,
          mailbox: query.mailbox,
          from: query.from,
          to: query.to,
          q: query.q,
          since: query.since,
          until: query.until,
          actionRequired: query.action_required,
          status: query.status as EnrichmentStatus | undefined,
          limit: query.limit,
          cursor: query.cursor,
        }),
      { query: emailsListQuery },
    )
    .get(
      "/emails/:id",
      ({ params, query, set }) => {
        const email = emails.getEmail(params.id);
        if (!email) {
          set.status = 404;
          return { error: "not_found" };
        }

        if (query.include === "html") return email;

        const { html: _html, ...withoutHtml } = email;
        return withoutHtml;
      },
      { params: t.Object({ id: t.String() }), query: emailByIdQuery },
    )
    .post(
      "/emails/:id/enrich",
      async ({ params, set }) => {
        const existing = emails.getEmail(params.id);
        if (!existing) {
          set.status = 404;
          return { error: "not_found" };
        }

        const result = await reEnrichEmail({
          emails,
          id: params.id,
          enrich: (email) => enrichEmail({ email }),
        });

        if (result.status === "busy") {
          set.status = 409;
          return { error: "enrichment_in_progress" };
        }

        return emails.getEmail(params.id)!.enrichment;
      },
      { params: t.Object({ id: t.String() }) },
    )
    .get(
      "/stats",
      ({ query }) => {
        const since = query.since ?? defaultSince();
        return {
          ...emails.emailStats({ since }),
          jevComparison: submissions.getJevComparison({ since }),
          jevQueue: sumJevQueue(
            emails.jevQueueCounts(),
            submissions.jevQueueCounts(),
          ),
          // Per-mailbox IMAP health, so a dead Bridge is visible.
          imap: imapState.listHealth(),
        };
      },
      { query: statsQuery },
    )
    .get(
      "/submissions",
      ({ query }) =>
        submissions.listSubmissions({
          verdict: query.verdict as Verdict | undefined,
          source: query.source as SubmissionSource | undefined,
          delivered: query.delivered,
          limit: query.limit,
          cursor: query.cursor,
        }),
      { query: submissionsListQuery },
    )
    .post("/sync", async ({ set }) => {
      const result = await runSync();
      if ("busy" in result) {
        set.status = 409;
        return { error: "sync_in_progress" };
      }
      return result;
    });
}

export const apiRoutes = createApiRoutes({
  apiKey: env.API_KEY,
  emails: emailsRepo,
  submissions: submissionsRepo,
  imapState: imapStateRepo,
  runSync: runSyncNow,
});
