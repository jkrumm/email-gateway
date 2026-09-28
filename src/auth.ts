import { timingSafeEqual } from "node:crypto";
import { bearer } from "@elysiajs/bearer";
import { Elysia } from "elysia";
import { env } from "./env";

// Shared by every bearer/basic-auth guard in this codebase (form routes,
// the admin UI, the /api/* layer) so token comparisons never leak timing.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

function isValidBearer(token: string | undefined): boolean {
  if (!token) return false;

  return timingSafeEqualStrings(token, env.SECRET_KEY);
}

// Shared by every bearer-checking guard (src/api/plugin.ts, src/mcp/plugin.ts):
// pulls the token out of an `Authorization: Bearer <token>` header, or
// undefined if the header is missing or a different scheme.
export function extractBearerToken(
  authorization: string | null | undefined,
): string | undefined {
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

/**
 * Registers the bearer plugin and rejects unauthenticated requests on the
 * given Elysia instance. Call before adding routes so the guard applies to
 * every route added afterwards on that instance.
 */
export function withBearerAuth(app: Elysia) {
  return app.use(bearer()).onBeforeHandle(({ bearer: token, set }) => {
    if (!isValidBearer(token)) {
      set.status = 400;
      set.headers["WWW-Authenticate"] =
        `Bearer realm='sign', error="invalid_request"`;
      return { message: "Unauthorized" };
    }
  });
}
