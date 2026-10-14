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
import { _test } from "../telemetry/otel";
import { createSesWebhookRoutes } from "./ses-webhook";

function setup({
  configured = true,
  failWrites = false,
}: { configured?: boolean; failWrites?: boolean } = {}) {
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
    sendLog: failWrites
      ? {
          ...sendLog,
          recordProviderEvent: () => {
            throw new Error("SQLITE_BUSY");
          },
        }
      : sendLog,
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
  return { app, post, postEvent, row, sendLog, certFetches, confirmFetches };
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

  test("a body over 256 KB with a Content-Length is 413", async () => {
    const { post } = setup();

    const response = await post("x".repeat(256 * 1024 + 1));

    expect(response.status).toBe(413);
  });

  test("a chunked body over 256 KB is 413 and is not read to the end", async () => {
    const { app } = setup();
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const totalChunks = 1000;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === totalChunks) return controller.close();
        pulled += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/ses", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(totalChunks / 2);
  });

  test("a rejecting stream cancel still yields 413", async () => {
    const { app } = setup();
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/ses", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
  });

  test("a body exactly at the cap is not refused for size", async () => {
    const { post } = setup();

    const response = await post("x".repeat(256 * 1024));

    expect(response.status).toBe(400);
  });

  test("a database write failure surfaces as 500 so SNS retries", async () => {
    const { postEvent } = setup({ failWrites: true });

    const response = await postEvent("Delivery");

    expect(response.status).toBe(500);
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

  test("a Bounce emits a ses.event with type names only", async () => {
    const { postEvent } = setup();
    const capture = _test.capture();

    await postEvent("Bounce", { bounce: { bounceType: "Permanent" } });
    capture.stop();

    const event = capture.logs.find((l) => l.body.stringValue === "ses.event")!;
    expect(event.severityText).toBe("WARN");
    expect(event.attributes).toEqual([
      { key: "event_type", value: { stringValue: "Bounce" } },
      { key: "bounce_type", value: { stringValue: "Permanent" } },
    ]);
    expect(JSON.stringify(capture.logs)).not.toContain("ses-msg-1");
  });

  test("every mapped event lands in the send_events timeline", async () => {
    const { postEvent, sendLog } = setup();

    await postEvent("Send", {
      mail: { messageId: "ses-msg-1", timestamp: "2026-10-14T08:00:00.000Z" },
    });
    await postEvent("Delivery", {
      delivery: { timestamp: "2026-10-14T08:00:02.000Z" },
    });

    expect(
      sendLog
        .listSendEvents("row-1")
        .map(({ eventType, status, occurredAt }) => ({
          eventType,
          status,
          occurredAt,
        })),
    ).toEqual([
      {
        eventType: "Send",
        status: null,
        occurredAt: "2026-10-14T08:00:00.000Z",
      },
      {
        eventType: "Delivery",
        status: "delivered",
        occurredAt: "2026-10-14T08:00:02.000Z",
      },
    ]);
  });

  test("a Send event is timeline-only and never moves the status", async () => {
    const { postEvent, row, sendLog } = setup();

    await postEvent("Delivery");
    const response = await postEvent("Send");

    expect(response.status).toBe(200);
    expect(row().status).toBe("delivered");
    expect(row().lastEvent).toBe("delivered");
    expect(sendLog.listSendEvents("row-1")).toHaveLength(2);
  });

  test("a redelivered notification writes the timeline once", async () => {
    const { postEvent, sendLog } = setup();
    const extra = { delivery: { timestamp: "2026-10-14T08:00:02.000Z" } };

    await postEvent("Delivery", extra);
    expect((await postEvent("Delivery", extra)).status).toBe(200);

    expect(sendLog.listSendEvents("row-1")).toHaveLength(1);
  });

  test("a Bounce stores type, subtype and diagnostic code but no address", async () => {
    const { postEvent, row, sendLog } = setup();

    await postEvent("Bounce", {
      bounce: {
        bounceType: "Permanent",
        bounceSubtype: "General",
        timestamp: "2026-10-14T08:00:03.000Z",
        bouncedRecipients: [
          {
            emailAddress: "guest@example.com",
            diagnosticCode: "smtp; 550 5.1.1 <guest@example.com> unknown",
          },
        ],
      },
    });

    expect(row()).toMatchObject({
      status: "bounced",
      bounceType: "Permanent",
      bounceSubtype: "General",
      diagnosticCode: "smtp; 550 5.1.1 <[address]> unknown",
    });
    const [event] = sendLog.listSendEvents("row-1");
    expect(event).toMatchObject({
      eventType: "Bounce",
      bounceType: "Permanent",
      diagnosticCode: "smtp; 550 5.1.1 <[address]> unknown",
    });
    expect(JSON.stringify(event)).not.toContain("guest@");
  });

  test("an unmatched message id writes no timeline row", async () => {
    const { post, sendLog } = setup();

    await post(
      JSON.stringify(
        notification({ eventType: "Send", mail: { messageId: "unknown" } }),
      ),
    );

    expect(sendLog.listSendEvents("row-1")).toEqual([]);
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
