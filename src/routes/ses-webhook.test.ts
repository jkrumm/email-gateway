import { describe, expect, test } from "bun:test";
import { openMailDatabase } from "../db/mail-client";
import { createSendLogRepo } from "../db/send-log";
import { createSnsVerifier } from "../providers/ses/sns-verify";
import {
  notification,
  SNS_REGION,
  SNS_TOPIC_ARN,
  snsPublicKeyPem,
  subscriptionConfirmation,
} from "../test/sns-fixture";
import { createSesWebhookRoutes } from "./ses-webhook";

function setup({ configured = true } = {}) {
  const sendLog = createSendLogRepo(openMailDatabase(":memory:"));
  const certFetches: string[] = [];
  const confirmFetches: string[] = [];
  const app = createSesWebhookRoutes({
    topicArn: configured ? SNS_TOPIC_ARN : undefined,
    region: configured ? SNS_REGION : undefined,
    verifier: createSnsVerifier({
      region: SNS_REGION,
      fetchCert: async (url) => {
        certFetches.push(url);
        return snsPublicKeyPem;
      },
    }),
    fetch: async (url) => {
      confirmFetches.push(url);
      return new Response("ok");
    },
    sendLog,
  });

  sendLog.insertSendLog({
    id: "row-1",
    recipients: ["guest@example.com"],
    provider: "ses",
    requestedBy: "route",
  });
  sendLog.recordProviderResult("row-1", {
    providerMessageId: "ses-msg-1",
    status: "sent",
  });

  function post(body: string, headers: Record<string, string> = {}) {
    return app.handle(
      new Request("http://localhost/webhooks/ses", {
        method: "POST",
        headers: { "content-type": "text/plain; charset=UTF-8", ...headers },
        body,
      }),
    );
  }

  function postEvent(eventType: string, extra: object = {}) {
    return post(
      JSON.stringify(
        notification({ eventType, mail: { messageId: "ses-msg-1" }, ...extra }),
      ),
    );
  }

  const row = () => sendLog.getSendLog("row-1")!;
  return { post, postEvent, row, sendLog, certFetches, confirmFetches };
}

describe("POST /webhooks/ses", () => {
  test("unset topic ARN 404s the path", async () => {
    const { post } = setup({ configured: false });

    const response = await post(JSON.stringify(notification({})));

    expect(response.status).toBe(404);
  });

  test("a bad JSON body is 400", async () => {
    const { post, certFetches } = setup();

    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ Type: "Notification" }))).status).toBe(
      400,
    );
    expect(certFetches).toEqual([]);
  });

  test("a body over 256 KB is 413", async () => {
    const { post } = setup();

    const response = await post("x".repeat(256 * 1024 + 1));

    expect(response.status).toBe(413);
  });

  test("a different TopicArn is 403 and fetches nothing", async () => {
    const { post, certFetches } = setup();
    const message = notification(
      { eventType: "Delivery", mail: { messageId: "ses-msg-1" } },
      { TopicArn: "arn:aws:sns:eu-central-1:999999999999:other" },
    );

    const response = await post(JSON.stringify(message));

    expect(response.status).toBe(403);
    expect(certFetches).toEqual([]);
  });

  test("a bad signature is 403 and changes nothing", async () => {
    const { post, row } = setup();
    const message = notification({
      eventType: "Bounce",
      mail: { messageId: "ses-msg-1" },
    });

    const response = await post(
      JSON.stringify({ ...message, Message: message.Message + " " }),
    );

    expect(response.status).toBe(403);
    expect(row().status).toBe("sent");
  });

  test("a cert URL off the pinned host is 403 without a fetch", async () => {
    const { post, certFetches } = setup();
    const message = notification(
      { eventType: "Delivery", mail: { messageId: "ses-msg-1" } },
      { SigningCertURL: "https://evil.example.com/cert.pem" },
    );

    expect((await post(JSON.stringify(message))).status).toBe(403);
    expect(certFetches).toEqual([]);
  });

  test("a Delivery event updates the send_log row", async () => {
    const { postEvent, row } = setup();
    const before = row().updatedAt;

    const response = await postEvent("Delivery");

    expect(response.status).toBe(200);
    expect(row().status).toBe("delivered");
    expect(row().lastEvent).toBe("delivered");
    expect(row().updatedAt >= before).toBe(true);
  });

  test("a Bounce after Delivered updates, carrying the bounce type", async () => {
    const { postEvent, row } = setup();

    await postEvent("Delivery");
    await postEvent("Bounce", { bounce: { bounceType: "Permanent" } });

    expect(row().status).toBe("bounced");
    expect(row().lastEvent).toBe("bounced:Permanent");
  });

  test("a delay after Delivered does not regress the status", async () => {
    const { postEvent, row } = setup();

    await postEvent("Delivery");
    const response = await postEvent("DeliveryDelay");

    expect(response.status).toBe(200);
    expect(row().status).toBe("delivered");
    expect(row().lastEvent).toBe("delivered");
  });

  test("an unmatched message id is 200 and changes nothing", async () => {
    const { post, row } = setup();
    const message = notification({
      eventType: "Delivery",
      mail: { messageId: "unknown" },
    });

    const response = await post(JSON.stringify(message));

    expect(response.status).toBe(200);
    expect(row().status).toBe("sent");
  });

  test("ignored and non-JSON events are 200", async () => {
    const { post, postEvent, row } = setup();

    expect((await postEvent("Open")).status).toBe(200);
    expect(
      (await post(JSON.stringify(notification({}, { Message: "{not json" }))))
        .status,
    ).toBe(200);
    expect(row().status).toBe("sent");
  });

  test("a SubscriptionConfirmation GETs the SubscribeURL once", async () => {
    const { post, confirmFetches } = setup();
    const message = subscriptionConfirmation();

    const response = await post(JSON.stringify(message));

    expect(response.status).toBe(200);
    expect(confirmFetches).toEqual([message.SubscribeURL!]);
  });

  test("a SubscribeURL off the pinned host is not fetched, still 200", async () => {
    const { post, confirmFetches } = setup();
    const message = subscriptionConfirmation({
      SubscribeURL: "https://evil.example.com/?Action=ConfirmSubscription",
    });

    const response = await post(JSON.stringify(message));

    expect(response.status).toBe(200);
    expect(confirmFetches).toEqual([]);
  });

  test("an UnsubscribeConfirmation is 200 and fetches nothing", async () => {
    const { post, confirmFetches } = setup();
    const message = subscriptionConfirmation({
      Type: "UnsubscribeConfirmation",
    });

    const response = await post(JSON.stringify(message));

    expect(response.status).toBe(200);
    expect(confirmFetches).toEqual([]);
  });
});
