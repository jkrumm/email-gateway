import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebRoutes } from "./plugin";
import { createApiRoutes } from "../api/plugin";
import { SESSION_MAX_AGE_MS } from "../session";
import { openMailDatabase } from "../db/mail-client";
import { createAccountsRepo } from "../db/accounts";
import { createMessagesRepo } from "../db/messages";
import { createMailSubmissionsRepo } from "../db/mail-submissions";
import { createJobQueue } from "../db/jobs";

const PASSWORD = "local-admin-pass-123";
const COOKIE_SECRET = "test-cookie-secret-1234567890";
const API_KEY = "test-api-key-1234567890";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

async function makeAssets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eg-web-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><div>app</div>");
  await writeFile(join(dir, "assets", "index-abc123.js"), "console.log('x')");
  return dir;
}

async function testWebApp(
  overrides: {
    password?: string | undefined;
    cookieSecret?: string | undefined;
    now?: () => number;
  } = {},
) {
  const assets = await makeAssets();
  const app = createWebRoutes({
    password: "password" in overrides ? overrides.password : PASSWORD,
    cookieSecret:
      "cookieSecret" in overrides ? overrides.cookieSecret : COOKIE_SECRET,
    assets,
    now: overrides.now,
  });
  return app;
}

function loginRequest(password: string, origin = true) {
  return new Request("http://mail.test/app/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { "sec-fetch-site": "same-origin" } : {}),
    },
    body: JSON.stringify({ password }),
  });
}

function sessionCookieOf(response: Response): string {
  const raw = response.headers.getSetCookie()[0] ?? "";
  return raw.split(";")[0] ?? "";
}

describe("web session auth", () => {
  test("password unset -> /app/login and /app/session 404", async () => {
    const app = await testWebApp({ password: undefined });

    expect((await app.handle(loginRequest(PASSWORD))).status).toBe(404);
    const session = await app.handle(
      new Request("http://mail.test/app/session"),
    );
    expect(session.status).toBe(404);
  });

  test("login without a same-origin signal -> 403", async () => {
    const app = await testWebApp();

    const response = await app.handle(loginRequest(PASSWORD, false));
    expect(response.status).toBe(403);
  });

  test("wrong password -> 401", async () => {
    const app = await testWebApp();

    const response = await app.handle(loginRequest("wrong-password-xx"));
    expect(response.status).toBe(401);
  });

  test("correct password sets a signed HttpOnly SameSite=Strict cookie", async () => {
    const app = await testWebApp();

    const response = await app.handle(loginRequest(PASSWORD));
    expect(response.status).toBe(200);

    const setCookie = response.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain("session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    // Signed: the value carries a signature separate from the raw payload.
    expect(setCookie).toContain(".");
  });

  test("session reports authenticated only with a valid cookie, and logout clears it", async () => {
    const app = await testWebApp();

    const anonymous = await app.handle(
      new Request("http://mail.test/app/session"),
    );
    expect(await anonymous.json()).toEqual({ authenticated: false });

    const login = await app.handle(loginRequest(PASSWORD));
    const cookie = sessionCookieOf(login);

    const authenticated = await app.handle(
      new Request("http://mail.test/app/session", {
        headers: { cookie },
      }),
    );
    expect(await authenticated.json()).toEqual({ authenticated: true });

    const logout = await app.handle(
      new Request("http://mail.test/app/logout", {
        method: "POST",
        headers: { cookie, "sec-fetch-site": "same-origin" },
      }),
    );
    const cleared = logout.headers.getSetCookie()[0] ?? "";
    expect(cleared).toContain("session=");
    expect(cleared).toContain("Max-Age=0");
  });

  test("a tampered cookie is a 401, not a 500", async () => {
    const app = await testWebApp();

    const response = await app.handle(
      new Request("http://mail.test/app/session", {
        headers: { cookie: "session=forged-value.not-a-signature" },
      }),
    );

    expect(response.status).toBe(401);
  });

  test("a validly-signed but expired cookie is no session", async () => {
    const loginAt = 1_700_000_000_000;
    const app = await testWebApp({ now: () => loginAt });
    const login = await app.handle(loginRequest(PASSWORD));
    const cookie = sessionCookieOf(login);

    const later = await testWebApp({
      now: () => loginAt + SESSION_MAX_AGE_MS + 1,
    });
    const response = await later.handle(
      new Request("http://mail.test/app/session", { headers: { cookie } }),
    );

    expect(await response.json()).toEqual({ authenticated: false });
  });
});

describe("web static serving", () => {
  test("serves index.html for /app and SPA routes, and hashed assets", async () => {
    const app = await testWebApp();

    for (const path of ["/app", "/app/inbox", "/app/messages/abc"]) {
      const response = await app.handle(new Request(`http://mail.test${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("app");
    }

    const asset = await app.handle(
      new Request("http://mail.test/app/assets/index-abc123.js"),
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("console.log");
  });

  test("/admin redirects to /app", async () => {
    const app = await testWebApp();

    const response = await app.handle(
      new Request("http://mail.test/admin", { redirect: "manual" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app");
  });

  test("disabled surface -> /admin 404s with the rest of /app", async () => {
    const app = await testWebApp({ password: undefined });

    const response = await app.handle(
      new Request("http://mail.test/admin", { redirect: "manual" }),
    );

    expect(response.status).toBe(404);
  });
});

describe("api session door", () => {
  function apiApp(now?: () => number) {
    const db = openMailDatabase(":memory:");
    return createApiRoutes({
      apiKey: API_KEY,
      session: { secret: COOKIE_SECRET, now },
      accounts: createAccountsRepo(db),
      messages: createMessagesRepo(db),
      mailSubmissions: createMailSubmissionsRepo(db),
      jobs: createJobQueue({ db, claimedBy: "test:1" }),
      providerFor: () => null,
      configuredProviders: () => [],
    });
  }

  test("a same-origin session cookie authenticates /api; cross-origin does not", async () => {
    const web = await testWebApp();
    const login = await web.handle(loginRequest(PASSWORD));
    const cookie = sessionCookieOf(login);
    const api = apiApp();

    const sameOrigin = await api.handle(
      new Request("http://mail.test/api/stats", {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      }),
    );
    expect(sameOrigin.status).toBe(200);

    const crossOrigin = await api.handle(
      new Request("http://mail.test/api/stats", {
        headers: { cookie, "sec-fetch-site": "cross-site" },
      }),
    );
    expect(crossOrigin.status).toBe(401);
  });

  test("no bearer and no session -> 401; a valid bearer still works", async () => {
    const api = apiApp();

    const anonymous = await api.handle(
      new Request("http://mail.test/api/stats"),
    );
    expect(anonymous.status).toBe(401);

    const bearer = await api.handle(
      new Request("http://mail.test/api/stats", {
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
    );
    expect(bearer.status).toBe(200);
  });

  test("a tampered session cookie is a 401, not a 500", async () => {
    const api = apiApp();

    const response = await api.handle(
      new Request("http://mail.test/api/stats", {
        headers: {
          cookie: "session=forged-value.not-a-signature",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  test("a validly-signed but expired session cookie is rejected", async () => {
    const loginAt = 1_700_000_000_000;
    const web = await testWebApp({ now: () => loginAt });
    const login = await web.handle(loginRequest(PASSWORD));
    const cookie = sessionCookieOf(login);

    const api = apiApp(() => loginAt + SESSION_MAX_AGE_MS + 1);
    const response = await api.handle(
      new Request("http://mail.test/api/stats", {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      }),
    );

    expect(response.status).toBe(401);
  });
});
