import { Elysia, redirect } from "elysia";
import { timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import { emailsRepo, imapStateRepo, submissionsRepo } from "../db";
import { runSyncNow } from "../sync";
import { enrichEmail, type EnrichEmailOutcome } from "../enrich/enrich-email";
import { reEnrichEmail } from "../enrich/re-enrich";
import { safeBackPath } from "./safe-back-path";
import type {
  EmailDirection,
  EmailsRepo,
  EmailWithEnrichment,
} from "../db/emails";
import type { ImapStateRepo } from "../db/imap-state";
import { sumJevQueue } from "../db/jev-queue";
import type {
  SubmissionsRepo,
  SubmissionSource,
  Verdict,
} from "../db/submissions";
import type { SyncSummary } from "../sync/types";
import { emailRegistry } from "../emails/registry";
import { berlinDayBoundaryToUtcIso } from "./format";
import { APP_CSS, getFontAsset } from "./assets";
import {
  assetResponse,
  rawHtmlResponse,
  renderPage,
  textResponse,
} from "./render";
import { OverviewPage } from "./pages/overview";
import { EmailsPage } from "./pages/emails";
import { EmailDetailPage, EmailNotFoundPage } from "./pages/email-detail";
import { SubmissionsPage } from "./pages/submissions";
import {
  TemplateDetailPage,
  TemplateNotFoundPage,
  TemplatesListPage,
  renderTemplateHtml,
} from "./pages/templates";

const MIN_PASSWORD_LENGTH = 12;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const PAGE_LIMIT = 25;

function isValidBasicAuth(
  authorization: string | undefined,
  password: string,
): boolean {
  if (!authorization?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf-8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);

  return (
    timingSafeEqualStrings(user, "admin") &&
    timingSafeEqualStrings(pass, password)
  );
}

// A POST is only accepted from the admin page itself: modern browsers send
// `Sec-Fetch-Site: same-origin` on same-origin form submits, and Origin is
// the fallback for clients that don't set it.
function isSameOriginPost(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function refererPathOrDefault(request: Request, fallback: string): string {
  const referer = request.headers.get("referer");
  if (!referer) return fallback;

  try {
    const refererUrl = new URL(referer);
    const requestUrl = new URL(request.url);
    if (refererUrl.host !== requestUrl.host) return fallback;
    return `${refererUrl.pathname}${refererUrl.search}`;
  } catch {
    return fallback;
  }
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, "http://internal");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

type NoticeQuery = { notice?: string; new?: string };

function noticeFor(
  query: NoticeQuery,
): { text: string; error?: boolean } | null {
  switch (query.notice) {
    case "sync-running":
      return { text: "A sync is already running.", error: true };
    case "synced":
      return { text: `Synced — ${query.new ?? "0"} new email(s).` };
    case "enriched":
      return { text: "AI enrichment re-run." };
    case "enrich-not-configured":
      return { text: "AI enrichment isn't configured.", error: true };
    case "enrich-failed":
      return {
        text: "AI enrichment failed — see the error below.",
        error: true,
      };
    case "enrich-busy":
      return {
        text: "AI enrichment is already running for this email.",
        error: true,
      };
    default:
      return null;
  }
}

function truthy(value: string | undefined): boolean {
  return value === "true";
}

export function createAdminRoutes({
  password,
  emails,
  submissions,
  imapState,
  runSync,
  enrich,
  now,
}: {
  password: string | undefined;
  emails: EmailsRepo;
  submissions: SubmissionsRepo;
  imapState: ImapStateRepo;
  runSync: () => Promise<SyncSummary | { busy: true }>;
  enrich: (email: EmailWithEnrichment) => Promise<EnrichEmailOutcome>;
  now?: () => Date;
}) {
  const passwordValid =
    password !== undefined && password.length >= MIN_PASSWORD_LENGTH;

  if (!passwordValid) {
    console.log(
      "[admin] BEA_ADMIN_PASSWORD unset or shorter than 12 chars — /admin routes disabled",
    );
  }

  const currentTime = () => now?.() ?? new Date();

  return new Elysia({ prefix: "/admin" })
    .onBeforeHandle(({ headers, request }) => {
      if (!passwordValid) {
        return textResponse("Not Found", 404);
      }

      if (!isValidBasicAuth(headers.authorization, password)) {
        return textResponse("Unauthorized", 401, {
          "www-authenticate": `Basic realm="email-gateway admin", charset="UTF-8"`,
        });
      }

      if (request.method === "POST" && !isSameOriginPost(request)) {
        return textResponse("Forbidden", 403);
      }
    })
    .get("/assets/app.css", () =>
      assetResponse(APP_CSS, "text/css; charset=utf-8"),
    )
    .get("/assets/fonts/:name", ({ params, set }) => {
      const bytes = getFontAsset(params.name);
      if (!bytes) {
        set.status = 404;
        return textResponse("Not Found", 404);
      }
      return assetResponse(bytes, "font/woff2");
    })
    .get("/", ({ query }) => {
      const time = currentTime();
      const since = new Date(time.getTime() - THIRTY_DAYS_MS).toISOString();
      const stats = emails.emailStats({ since });

      return renderPage(
        <OverviewPage
          stats={stats}
          jevComparison={submissions.getJevComparison({ since })}
          jevQueue={sumJevQueue(
            emails.jevQueueCounts(),
            submissions.jevQueueCounts(),
          )}
          needsAction={
            emails.listEmails({ actionRequired: true, limit: 8 }).data
          }
          recentlyBlocked={
            submissions.listSubmissions({ delivered: false, limit: 5 }).data
          }
          lastSyncedAt={emails.lastSyncedAt()}
          imapHealth={imapState.listHealth()}
          needsActionCount={emails.actionRequiredCount()}
          now={time}
          notice={noticeFor(query)}
        />,
      );
    })
    .get("/emails", ({ query }) => {
      const direction =
        query.direction === "inbound" || query.direction === "outbound"
          ? (query.direction as EmailDirection)
          : undefined;
      const category = query.category || undefined;
      const source = query.source || undefined;
      const provider =
        query.provider === "resend" || query.provider === "imap"
          ? query.provider
          : undefined;
      const mailbox = query.mailbox || undefined;
      const actionRequired = truthy(query.action_required) || undefined;
      const from = query.from || undefined;
      const to = query.to || undefined;
      const cursor = query.cursor || undefined;

      const result = emails.listEmails({
        direction,
        category: category ? [category] : undefined,
        source,
        provider,
        mailbox,
        q: query.q || undefined,
        since: from ? berlinDayBoundaryToUtcIso(from, "start") : undefined,
        until: to ? berlinDayBoundaryToUtcIso(to, "end") : undefined,
        actionRequired,
        cursor,
        limit: PAGE_LIMIT,
      });

      return renderPage(
        <EmailsPage
          filters={{
            q: query.q || undefined,
            direction,
            category,
            source,
            provider,
            mailbox,
            actionRequired,
            from,
            to,
          }}
          emails={result.data}
          nextCursor={result.nextCursor}
          hasCursor={Boolean(cursor)}
          needsActionCount={emails.actionRequiredCount()}
          now={currentTime()}
          notice={noticeFor(query)}
        />,
      );
    })
    .get("/emails/:id", ({ params, query }) => {
      const back = safeBackPath(query.back);
      const email = emails.getEmail(params.id);
      const needsActionCount = emails.actionRequiredCount();

      if (!email) {
        return renderPage(
          <EmailNotFoundPage
            id={params.id}
            back={back}
            needsActionCount={needsActionCount}
          />,
          { status: 404 },
        );
      }

      return renderPage(
        <EmailDetailPage
          email={email}
          view={query.view === "text" ? "text" : "html"}
          back={back}
          needsActionCount={needsActionCount}
          now={currentTime()}
          notice={noticeFor(query)}
        />,
      );
    })
    .post("/emails/:id/enrich", async ({ params, query }) => {
      const back = safeBackPath(query.back);
      const view = query.view === "text" ? "text" : "html";
      const detailPath = `/admin/emails/${params.id}?back=${encodeURIComponent(back)}&view=${view}`;

      const existing = emails.getEmail(params.id);
      if (!existing) {
        return redirect(back, 303);
      }

      const result = await reEnrichEmail({ emails, id: params.id, enrich });

      if (result.status === "busy") {
        return redirect(withParam(detailPath, "notice", "enrich-busy"), 303);
      }

      if (result.outcome.ok) {
        return redirect(withParam(detailPath, "notice", "enriched"), 303);
      }

      const notice =
        result.outcome.error === "Enrichment not configured"
          ? "enrich-not-configured"
          : "enrich-failed";
      return redirect(withParam(detailPath, "notice", notice), 303);
    })
    .get("/submissions", ({ query }) => {
      const verdict = (["legit", "marketing", "spam"] as const).includes(
        query.verdict as Verdict,
      )
        ? (query.verdict as Verdict)
        : undefined;
      const source = (["fpp", "sy-serendipity"] as const).includes(
        query.source as SubmissionSource,
      )
        ? (query.source as SubmissionSource)
        : undefined;
      const delivered =
        query.delivered === "true"
          ? true
          : query.delivered === "false"
            ? false
            : undefined;
      const cursor = query.cursor || undefined;

      const result = submissions.listSubmissions({
        verdict,
        source,
        delivered,
        cursor,
        limit: PAGE_LIMIT,
      });

      return renderPage(
        <SubmissionsPage
          filters={{ verdict, source, delivered }}
          submissions={result.data}
          nextCursor={result.nextCursor}
          hasCursor={Boolean(cursor)}
          needsActionCount={emails.actionRequiredCount()}
          now={currentTime()}
        />,
      );
    })
    .get("/sent", () => redirect("/admin/emails?direction=outbound", 302))
    .get("/received", () => redirect("/admin/emails?direction=inbound", 302))
    .get("/filtered", () => redirect("/admin/submissions", 302))
    .post("/sync", async ({ request }) => {
      const back = refererPathOrDefault(request, "/admin");
      const result = await runSync();

      if ("busy" in result) {
        return redirect(withParam(back, "notice", "sync-running"), 303);
      }

      const newCount =
        result.outbound.new + result.inbound.new + (result.imap?.new ?? 0);
      const withNotice = withParam(back, "notice", "synced");
      return redirect(withParam(withNotice, "new", String(newCount)), 303);
    })
    .get("/templates", () =>
      renderPage(
        <TemplatesListPage needsActionCount={emails.actionRequiredCount()} />,
      ),
    )
    .get("/templates/:id", async ({ params, query }) => {
      const entry = emailRegistry.find(
        (candidate) => candidate.id === params.id,
      );
      const needsActionCount = emails.actionRequiredCount();

      if (!entry) {
        return renderPage(
          <TemplateNotFoundPage
            id={params.id}
            needsActionCount={needsActionCount}
          />,
          { status: 404 },
        );
      }

      const width = query.width === "375" ? 375 : 600;
      const html = await renderTemplateHtml(entry);
      return renderPage(
        <TemplateDetailPage
          entry={entry}
          html={html}
          width={width}
          needsActionCount={needsActionCount}
        />,
      );
    })
    .get("/templates/:id/raw", async ({ params }) => {
      const entry = emailRegistry.find(
        (candidate) => candidate.id === params.id,
      );

      if (!entry) {
        return textResponse("Not Found", 404);
      }

      const html = await renderTemplateHtml(entry);
      return rawHtmlResponse(html);
    });
}

export const adminRoutes = createAdminRoutes({
  password: env.BEA_ADMIN_PASSWORD,
  emails: emailsRepo,
  submissions: submissionsRepo,
  imapState: imapStateRepo,
  runSync: runSyncNow,
  enrich: (email) => enrichEmail({ email }),
});
