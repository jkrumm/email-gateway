import { Elysia, type AnyElysia } from "elysia";
import { fppRoutes } from "./routes/fpp";
import { sySerendipityRoutes } from "./routes/sy-serendipity";
import { webRoutes } from "./web/plugin";
import { apiRoutes } from "./api/plugin";
import { env } from "./env";
import { hostAllowed } from "./host-gate";

export interface CreateAppOptions<
  TWeb extends AnyElysia = typeof webRoutes,
  TApi extends AnyElysia = typeof apiRoutes,
> {
  // Overrides env.MAIL_HOST; unset -> the gate is a no-op.
  mailHost?: string;
  // Route-factory seams for tests: mount a configured web/api app instead of
  // the env-bound singletons without re-declaring the gate. The instance type
  // is generic so a configured seam keeps its concrete routes in `App`.
  web?: TWeb;
  api?: TApi;
}

export function createApp<
  TWeb extends AnyElysia = typeof webRoutes,
  TApi extends AnyElysia = typeof apiRoutes,
>(options: CreateAppOptions<TWeb, TApi> = {}) {
  const mailHost = options.mailHost ?? env.MAIL_HOST;
  const web = (options.web ?? webRoutes) as TWeb;
  const api = (options.api ?? apiRoutes) as TApi;

  return (
    new Elysia()
      .get("/", () => "Hello Elysia")
      // Public (no bearer, reachable on the tunnel) for Uptime Kuma's liveness
      // check — never lists accounts here, that's real-address PII. The
      // bearer-guarded GET /api/accounts is where every configured account is
      // listed.
      .get("/health", () => ({ ok: true }))
      .use(fppRoutes)
      .use(sySerendipityRoutes)
      // The mail surface (/app, /api) sits behind MAIL_HOST; the send routes
      // above and /health never do. A mismatching Host 404s these routes
      // entirely. A `.guard()` (not a separate plugin used via `.use`, whose
      // local hook does not propagate) is what scopes the check over both sets.
      .guard(
        {
          beforeHandle: ({ request, set }) => {
            if (!hostAllowed(request.headers.get("host"), mailHost)) {
              set.status = 404;
              return "Not Found";
            }
          },
        },
        (gated) => gated.use(web).use(api),
      )
  );
}

export const app = createApp();

export type App = typeof app;
