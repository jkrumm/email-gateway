import { describe, expect, test } from "bun:test";
import { createApp, app } from "./app";
import { createApiRoutes } from "./api/plugin";
import { openMailDatabase } from "./db/mail-client";
import { createAccountsRepo } from "./db/accounts";
import { createMessagesRepo } from "./db/messages";
import { createSendLogRepo } from "./db/send-log";
import { createMailSubmissionsRepo } from "./db/mail-submissions";
import { createJobQueue } from "./db/jobs";
import { createSesWebhookRoutes } from "./routes/ses-webhook";
import { SNS_REGION, SNS_TOPIC_ARN } from "./test/sns-fixture";

const TEST_API_KEY = "test-api-key-1234567890";
const MAIL_HOST = "mail.test";

// A real, configured /api app mounted behind the gate via createApp's own
// `api` seam — the app factory takes its dependencies as parameters, so the
// gate is exercised against a real bearer-guarded route rather than a
// throwaway one.
function gatedApiApp(mailHost: string | undefined) {
  const db = openMailDatabase(":memory:");
  const api = createApiRoutes({
    apiKey: TEST_API_KEY,
    accounts: createAccountsRepo(db),
    messages: createMessagesRepo(db),
    mailSubmissions: createMailSubmissionsRepo(db),
    jobs: createJobQueue({ db, claimedBy: "test:1" }),
    providerFor: () => null,
    configuredProviders: () => [],
  });
  return createApp({ mailHost, api });
}

function hostRequest(path: string, host: string, init: RequestInit = {}) {
  return new Request(`http://${host}${path}`, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });
}

function bearerHeaders(host: string) {
  return { host, authorization: `Bearer ${TEST_API_KEY}` };
}

describe("app", () => {
  test("GET /health returns ok", async () => {
    const response = await app.handle(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("POST /fpp without bearer returns 400 Unauthorized", async () => {
    const response = await app.handle(
      new Request("http://localhost/fpp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: "test@example.com",
          subject: "Hi",
          message: "Hello",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Unauthorized" });
  });

  test("POST /sy-serendipity with valid bearer but invalid body returns 422", async () => {
    const response = await app.handle(
      new Request("http://localhost/sy-serendipity", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.SECRET_KEY}`,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(422);
  });
});

describe("MAIL_HOST gate", () => {
  test("unset MAIL_HOST -> the gated /api door answers on any Host", async () => {
    const gatedApp = gatedApiApp(undefined);

    const response = await gatedApp.handle(
      hostRequest("/api/stats", "public.test", {
        headers: bearerHeaders("public.test"),
      }),
    );

    expect(response.status).toBe(200);
  });

  test("set MAIL_HOST -> a mismatching Host 404s the gated /api door", async () => {
    const gatedApp = gatedApiApp(MAIL_HOST);

    const response = await gatedApp.handle(
      hostRequest("/api/stats", "public.test", {
        headers: bearerHeaders("public.test"),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("set MAIL_HOST -> the matching Host still reaches /api", async () => {
    const gatedApp = gatedApiApp(MAIL_HOST);

    const withBearer = await gatedApp.handle(
      hostRequest("/api/stats", MAIL_HOST, {
        headers: bearerHeaders(MAIL_HOST),
      }),
    );
    expect(withBearer.status).toBe(200);

    const withoutBearer = await gatedApp.handle(
      hostRequest("/api/stats", MAIL_HOST),
    );
    expect(withoutBearer.status).toBe(401);
  });

  test("set MAIL_HOST -> the SES webhook still answers on a Host that fails the gate", async () => {
    const ses = createSesWebhookRoutes({
      topicArn: SNS_TOPIC_ARN,
      region: SNS_REGION,
      sendLog: createSendLogRepo(openMailDatabase(":memory:")),
    });
    const gated = createApp({ mailHost: MAIL_HOST, ses });

    const webhook = await gated.handle(
      hostRequest("/webhooks/ses", "other.test", {
        method: "POST",
        body: "{not json",
      }),
    );
    const api = await gated.handle(
      hostRequest("/api/accounts", "other.test", {
        headers: bearerHeaders("other.test"),
      }),
    );

    // 400 = the route itself ran (bad JSON), not the gate's 404.
    expect(webhook.status).toBe(400);
    expect(api.status).toBe(404);
  });

  test("the send routes and /health stay reachable on any Host when gated", async () => {
    const gatedApp = gatedApiApp(MAIL_HOST);

    const health = await gatedApp.handle(hostRequest("/health", "public.test"));
    expect(health.status).toBe(200);

    // 400 (the send routes' own bearer guard), not 404 — reachable regardless.
    const send = await gatedApp.handle(
      hostRequest("/fpp", "public.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: "test@example.com",
          subject: "Hi",
          message: "Hello",
        }),
      }),
    );
    expect(send.status).toBe(400);
  });
});
