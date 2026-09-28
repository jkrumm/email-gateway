import { existsSync } from "node:fs";
import { join } from "node:path";
import { Elysia, redirect, t } from "elysia";
import type { Context } from "elysia";
import { staticPlugin } from "@elysia/static";
import { timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  handleCookieSignatureError,
  isSameOrigin,
  isSessionValue,
  sessionCookieOptions,
  sessionSecret,
  sessionValue,
} from "../session";

const ASSET_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

async function serveIndex(assets: string, set: Context["set"]) {
  const file = Bun.file(join(assets, "index.html"));
  if (!(await file.exists())) {
    set.status = 404;
    return "Not Found";
  }
  set.headers["cache-control"] = "no-store";
  set.headers["content-type"] = "text/html; charset=utf-8";
  return file;
}

// Routes serving the SPA at /app plus its session endpoints. The client bundle
// lives in `client/dist` (built by the Dockerfile's client stage). `/api` and
// `/mcp` are not here — they stay bearer-first and live in their own plugins.
export function createWebRoutes({
  password,
  cookieSecret,
  assets,
  now = Date.now,
}: {
  password: string | undefined;
  cookieSecret: string | undefined;
  assets: string;
  now?: () => number;
}) {
  const secret = sessionSecret(password, cookieSecret);

  // sessionSecret only returns a secret once the password is set and long
  // enough, so a missing secret means the whole mail surface is disabled and
  // no /app route exists at all (not even /admin). One chain for the enabled
  // case keeps every route in `typeof webRoutes` — separate `app.post(...)`
  // statements would leave the binding's type at the empty initial instance.
  if (secret === undefined || password === undefined) {
    console.log(
      `[web] ADMIN_PASSWORD unset or shorter than ${MIN_PASSWORD_LENGTH} chars — /app disabled`,
    );
    return new Elysia().onError(({ error, set }) =>
      handleCookieSignatureError(error, set),
    );
  }

  return (
    new Elysia({ cookie: sessionCookieOptions(secret) })
      .onError(({ error, set }) => handleCookieSignatureError(error, set))
      .post(
        "/app/login",
        ({ body, cookie, request, set }) => {
          if (!isSameOrigin(request)) {
            set.status = 403;
            return "Forbidden";
          }
          if (!timingSafeEqualStrings(body.password, password)) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          cookie.session.set({
            value: sessionValue(now()),
            httpOnly: true,
            sameSite: "strict",
            path: "/",
            maxAge: SESSION_MAX_AGE_SECONDS,
            secure: process.env.NODE_ENV === "production",
          });
          return { ok: true };
        },
        {
          body: t.Object({ password: t.String() }),
          cookie: t.Cookie({ [SESSION_COOKIE]: t.Optional(t.String()) }),
        },
      )
      .post("/app/logout", ({ cookie, request, set }) => {
        if (!isSameOrigin(request)) {
          set.status = 403;
          return "Forbidden";
        }
        cookie.session.remove();
        return { ok: true };
      })
      .get("/app/session", ({ cookie }) => ({
        authenticated: isSessionValue(cookie.session.value, now()),
      }))
      // The SPA is rebuilt into client/dist; `/admin` is a permanent redirect to
      // the client so old bookmarks keep working. Registered only while the mail
      // surface is enabled — otherwise /admin 404s like the rest of /app.
      .get("/admin", () => redirect("/app", 302))
      // `@elysia/static` resolves real files only; index.html is served by the
      // no-store fallback routes below. An empty plugin when client/dist is
      // absent (a source checkout) so a missing build never breaks boot.
      .use(
        existsSync(assets)
          ? staticPlugin({
              assets,
              prefix: "/app",
              alwaysStatic: true,
              // Hashed Vite assets are immutable; index.html is served below with
              // no-store so a deploy is picked up immediately.
              indexHTML: false,
              maxAge: ASSET_MAX_AGE_SECONDS,
              directive: "public",
              silent: true,
            })
          : new Elysia(),
      )
      // The static plugin only resolves real files; SPA routes need an explicit
      // fallback to index.html (`@elysia/static`'s indexHTML is a directory
      // index, not a client-side-router fallback).
      .get("/app", ({ set }) => serveIndex(assets, set))
      .get("/app/*", ({ set }) => serveIndex(assets, set))
  );
}

export const webRoutes = createWebRoutes({
  password: env.ADMIN_PASSWORD,
  cookieSecret: env.COOKIE_SECRET,
  assets: "client/dist",
});
