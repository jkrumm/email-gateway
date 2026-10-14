import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { withSpan } from "../../telemetry/otel";
import { errorName } from "../../telemetry/otel-format";
import type { SendProvider } from "../send-port";

// SES message tag names and values accept only [A-Za-z0-9_\-.@], at most 256
// characters; anything else becomes "_". The one place that rule lives.
const SES_TAG_MAX_LENGTH = 256;

export function sanitizeSesTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_\-.@]/g, "_").slice(0, SES_TAG_MAX_LENGTH);
}

// Only what send() calls — narrower than the full SDK client so a test fake
// can be injected.
type SesSendOnly = Pick<SESv2Client, "send">;

export function createSesSendProvider({
  client,
  configurationSetName,
}: {
  client: SesSendOnly;
  // Routes delivery events to the SNS topic behind POST /webhooks/ses.
  configurationSetName: string;
}): SendProvider {
  return {
    id: "ses",
    // SES has no idempotency key, so message.idempotencyKey is deliberately
    // ignored: the send job's send_log guard (skip once a provider message id
    // is recorded) is the only protection against a duplicate send.
    // A failed send throws from the SDK.
    async send({ from, to, replyTo, subject, html, text, tags }) {
      // Loaded on first send: the SDK costs ~19 MB RSS at boot, which
      // matters in the 256 MB container.
      const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      const command = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
        ConfigurationSetName: configurationSetName,
        ...(tags && Object.keys(tags).length > 0
          ? {
              EmailTags: Object.entries(tags).map(([name, value]) => ({
                Name: sanitizeSesTag(name),
                Value: sanitizeSesTag(value),
              })),
            }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: html, Charset: "UTF-8" },
              Text: { Data: text, Charset: "UTF-8" },
            },
          },
        },
      });
      // Only the template and source names go on the span — never an address,
      // subject, body or auth code.
      return withSpan(
        "ses.send",
        { "email.template": tags?.template, "email.source": tags?.source },
        async (span) => {
          try {
            const response = await client.send(command);
            if (!response.MessageId) {
              throw new Error(
                "SES accepted the message but returned no MessageId",
              );
            }
            span.setAttributes({ outcome: "ok" });
            return { providerMessageId: response.MessageId };
          } catch (error) {
            span.setAttributes({ outcome: "error" });
            // The error name only: a failure's text could echo the subject or body.
            span.setStatus("error", errorName(error));
            throw error;
          }
        },
        "client",
      );
    },
  };
}
