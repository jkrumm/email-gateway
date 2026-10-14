import { Elysia, type AnyElysia } from "elysia";
import { fppRoutes } from "./routes/fpp";
import { jkrummContactRoutes } from "./routes/jkrumm-contact";
import { sySerendipityRoutes } from "./routes/sy-serendipity";
import { shutterflowRoutes } from "./routes/shutterflow";
import { sySerendipityRequestsRoutes } from "./routes/sy-serendipity-requests";
import { sesWebhookRoutes } from "./routes/ses-webhook";
import { webRoutes } from "./web/plugin";
import { apiRoutes } from "./api/plugin";
import { mcpRoutes } from "./mcp/plugin";
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
  // Same for the SES webhook, which sits outside the gate. Typed concretely
  // (not generic like web/api): it is mounted before the `.guard`, and a
  // generic instance there leaks into the guard's hook typing and breaks it.
  ses?: typeof sesWebhookRoutes;
}

export function createApp<
  TWeb extends AnyElysia = typeof webRoutes,
  TApi extends AnyElysia = typeof apiRoutes,
>(options: CreateAppOptions<TWeb, TApi> = {}) {
  const mailHost = options.mailHost ?? env.MAIL_HOST;
  const web = (options.web ?? webRoutes) as TWeb;
  const api = (options.api ?? apiRoutes) as TApi;
  const ses = options.ses ?? sesWebhookRoutes;

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
      // Public (no bearer): the static personal site cannot hold a secret.
      // Origin allow-list + honeypot + spam gate instead; see the route.
      .use(jkrummContactRoutes)
      // Read-only admin feed, its own key (SY_SERENDIPITY_READ_KEY); never
      // behind the MAIL_HOST gate, never opened by SECRET_KEY or API_KEY.
      .use(sySerendipityRequestsRoutes)
      // Shutterflow's auth codes; own bearer (SHUTTERFLOW_SECRET_KEY), unset 404s.
      .use(shutterflowRoutes)
      // SNS -> send_log delivery events. On the public door like the send
      // routes (SNS cannot reach the MAIL_HOST-gated surface); the SNS
      // signature is its only auth, and unset SES_SNS_TOPIC_ARN 404s it.
      .use(ses)
      // The mail surface (/app, /api, /mcp) sits behind MAIL_HOST; the send
      // routes above and /health never do. A mismatching Host 404s these
      // routes entirely. A `.guard()` (not a separate plugin used via `.use`,
      // whose local hook does not propagate) is what scopes the check over
      // all three sets.
      .guard(
        {
          beforeHandle: ({ request, set }) => {
            if (!hostAllowed(request.headers.get("host"), mailHost)) {
              set.status = 404;
              return "Not Found";
            }
          },
        },
        (gated) => gated.use(web).use(api).use(mcpRoutes),
      )
  );
}

export const app = createApp();

export type App = typeof app;
