import { Elysia } from "elysia";
import { fppRoutes } from "./routes/fpp";
import { sySerendipityRoutes } from "./routes/sy-serendipity";
import { adminRoutes } from "./admin/plugin";
import { apiRoutes } from "./api/plugin";

export const app = new Elysia()
  .get("/", () => "Hello Elysia")
  // Public (no bearer, reachable on the tunnel) for Uptime Kuma's liveness
  // check — never lists accounts here, that's real-address PII. The
  // bearer-guarded GET /api/accounts is where every configured account is
  // listed.
  .get("/health", () => ({ ok: true }))
  .use(fppRoutes)
  .use(sySerendipityRoutes)
  .use(adminRoutes)
  .use(apiRoutes);
