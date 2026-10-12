import type { SESv2Client } from "@aws-sdk/client-sesv2";
import type { SendProvider } from "../send-port";

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
    async send({ from, to, replyTo, subject, html, text }) {
      // Loaded on first send: the SDK costs ~19 MB RSS at boot, which
      // matters in the 256 MB container.
      const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      const response = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
          ConfigurationSetName: configurationSetName,
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: html, Charset: "UTF-8" },
                Text: { Data: text, Charset: "UTF-8" },
              },
            },
          },
        }),
      );
      if (!response.MessageId) {
        throw new Error("SES accepted the message but returned no MessageId");
      }
      return { providerMessageId: response.MessageId };
    },
  };
}
