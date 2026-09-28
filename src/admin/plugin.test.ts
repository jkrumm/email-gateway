import { describe, expect, test } from "bun:test";
import { createAdminRoutes } from "./plugin";
import { openMailDatabase } from "../db/mail-client";
import { createMailSubmissionsRepo } from "../db/mail-submissions";
import { emailRegistry } from "../emails/registry";

const PASSWORD = "local-admin-pass-123";
const FIXED_NOW = new Date("2026-09-15T08:30:00.000Z");

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function sameOriginHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: basicAuth("admin", PASSWORD),
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function testApp(overrides: { password?: string | undefined } = {}) {
  const db = openMailDatabase(":memory:");
  const submissions = createMailSubmissionsRepo(db);

  const app = createAdminRoutes({
    password: "password" in overrides ? overrides.password : PASSWORD,
    submissions,
    now: () => FIXED_NOW,
  });

  return { app, submissions };
}

describe("admin plugin auth", () => {
  test("password unset -> /admin is 404", async () => {
    const { app } = testApp({ password: undefined });

    const response = await app.handle(new Request("http://localhost/admin"));

    expect(response.status).toBe(404);
  });

  test("password shorter than 12 chars -> /admin is 404", async () => {
    const { app } = testApp({ password: "short" });

    const response = await app.handle(new Request("http://localhost/admin"));

    expect(response.status).toBe(404);
  });

  test("no auth header -> 401 with WWW-Authenticate", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/submissions"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  test("wrong password -> 401", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/submissions", {
        headers: { authorization: basicAuth("admin", "wrong-password") },
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("admin root redirect", () => {
  test("/admin -> /admin/submissions", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
        redirect: "manual",
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/submissions");
  });
});

describe("admin submissions", () => {
  test("HTML-escapes submission values", async () => {
    const { app, submissions } = testApp();
    submissions.insertSubmission({
      source: "fpp",
      verdict: "spam",
      confidence: 0.9,
      reason: "looks like spam",
      model: "test-model",
      delivered: false,
      submission: { message: "<script>alert(1)</script>" },
    });

    const response = await app.handle(
      new Request("http://localhost/admin/submissions", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("filters pass through to the repo", async () => {
    const { app, submissions } = testApp();
    submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.95,
      reason: "genuine feedback",
      model: "test-model",
      delivered: true,
      submission: { message: "love the tool" },
    });
    submissions.insertSubmission({
      source: "sy-serendipity",
      verdict: "spam",
      confidence: 0.9,
      reason: "looks like spam",
      model: "test-model",
      delivered: false,
      submission: { message: "buy now" },
    });

    const response = await app.handle(
      new Request("http://localhost/admin/submissions?source=fpp", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    const html = await response.text();
    expect(html).toContain("love the tool");
    expect(html).not.toContain("buy now");
  });

  test("a submission with no Jev result yet shows a placeholder", async () => {
    const { app, submissions } = testApp();
    submissions.insertSubmission({
      source: "fpp",
      verdict: "legit",
      confidence: 0.95,
      reason: "genuine feedback",
      model: "test-model",
      delivered: true,
      submission: { message: "love the tool" },
    });

    const response = await app.handle(
      new Request("http://localhost/admin/submissions", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    const html = await response.text();
    expect(html).toContain("not yet judged");
  });
});

describe("admin sync", () => {
  test("POST without same-origin signal -> 403", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/sync", {
        method: "POST",
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(403);
  });

  test("POST with Sec-Fetch-Site: same-origin enqueues a sync_tick job and redirects", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/sync", {
        method: "POST",
        headers: sameOriginHeaders(),
        redirect: "manual",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=sync-enqueued");
  });
});

describe("admin templates", () => {
  test("lists every registry name", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/templates", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    for (const entry of emailRegistry) {
      expect(html).toContain(entry.name);
    }
  });

  test("/admin/templates/fpp-sender renders a sandboxed iframe", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/templates/fpp-sender", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<iframe");
    expect(html).toContain("sandbox");
  });

  test("unknown template id -> 404", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/templates/does-not-exist", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("admin assets", () => {
  test("app.css contains tokens and a dark-mode media query", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/assets/app.css", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.status).toBe(200);
    const css = await response.text();
    expect(css).toContain("--vx-surface-bg");
    expect(css).toContain("prefers-color-scheme: dark");
  });
});

describe("security headers", () => {
  test("are present on an admin page response", async () => {
    const { app } = testApp();

    const response = await app.handle(
      new Request("http://localhost/admin/templates", {
        headers: { authorization: basicAuth("admin", PASSWORD) },
      }),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });
});
