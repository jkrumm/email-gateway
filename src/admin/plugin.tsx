import { Elysia, redirect } from "elysia";
import { timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import { mailSubmissionsRepo } from "../db/mail-index";
import { enqueueSyncTick, jobQueue } from "../jobs/queue";
import type {
  MailSubmissionsRepo,
  SubmissionSource,
  Verdict,
} from "../db/mail-submissions";
import { emailRegistry } from "../emails/registry";
import { APP_CSS, getFontAsset } from "./assets";
import {
  assetResponse,
  rawHtmlResponse,
  renderPage,
  textResponse,
} from "./render";
import { SubmissionsPage } from "./pages/submissions";
import {
  TemplateDetailPage,
  TemplateNotFoundPage,
  TemplatesListPage,
  renderTemplateHtml,
} from "./pages/templates";

const MIN_PASSWORD_LENGTH = 12;
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

type NoticeQuery = { notice?: string };

function noticeFor(
  query: NoticeQuery,
): { text: string; error?: boolean } | null {
  switch (query.notice) {
    case "sync-enqueued":
      return { text: "Sync enqueued." };
    default:
      return null;
  }
}

export function createAdminRoutes({
  password,
  submissions,
  now,
}: {
  password: string | undefined;
  submissions: MailSubmissionsRepo;
  now?: () => Date;
}) {
  const passwordValid =
    password !== undefined && password.length >= MIN_PASSWORD_LENGTH;

  if (!passwordValid) {
    console.log(
      "[admin] ADMIN_PASSWORD unset or shorter than 12 chars — /admin routes disabled",
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
    .get("/", () => redirect("/admin/submissions", 302))
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
          now={currentTime()}
          notice={noticeFor(query)}
        />,
      );
    })
    .post("/sync", ({ request }) => {
      const back = refererPathOrDefault(request, "/admin/submissions");
      enqueueSyncTick(jobQueue);
      return redirect(withParam(back, "notice", "sync-enqueued"), 303);
    })
    .get("/templates", () => renderPage(<TemplatesListPage />))
    .get("/templates/:id", async ({ params, query }) => {
      const entry = emailRegistry.find(
        (candidate) => candidate.id === params.id,
      );

      if (!entry) {
        return renderPage(<TemplateNotFoundPage id={params.id} />, {
          status: 404,
        });
      }

      const width = query.width === "375" ? 375 : 600;
      const html = await renderTemplateHtml(entry);
      return renderPage(
        <TemplateDetailPage entry={entry} html={html} width={width} />,
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
  password: env.ADMIN_PASSWORD,
  submissions: mailSubmissionsRepo,
});
