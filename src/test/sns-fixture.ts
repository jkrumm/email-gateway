import { createSign, generateKeyPairSync } from "node:crypto";
import type { SnsMessage } from "../providers/ses/sns-verify";

// A throwaway RSA key pair and a signer that follows SNS's string-to-sign
// rules, so verifier and webhook tests run without a real AWS certificate.
// The "certificate" a fake fetcher returns is just the public key PEM.
export const SNS_REGION = "eu-central-1";
export const SNS_TOPIC_ARN = "arn:aws:sns:eu-central-1:111122223333:ses-events";
export const SNS_CERT_URL = `https://sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-test.pem`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

export const snsPublicKeyPem = publicKey.export({
  type: "spki",
  format: "pem",
}) as string;

type Unsigned = Omit<SnsMessage, "Signature" | "SignatureVersion"> &
  Partial<Pick<SnsMessage, "SignatureVersion">>;

const NOTIFICATION_KEYS = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
] as const;
const CONFIRMATION_KEYS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

export function signSnsMessage(message: Unsigned): SnsMessage {
  const signatureVersion = message.SignatureVersion ?? "2";
  const keys =
    message.Type === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  const toSign = keys
    .filter((key) => message[key] !== undefined)
    .map((key) => `${key}\n${message[key]}\n`)
    .join("");

  const signature = createSign(
    signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256",
  )
    .update(toSign, "utf8")
    .sign(privateKey, "base64");

  return {
    ...message,
    SignatureVersion: signatureVersion,
    Signature: signature,
  };
}

export function notification(
  event: unknown,
  overrides: Partial<Unsigned> = {},
): SnsMessage {
  return signSnsMessage({
    Type: "Notification",
    MessageId: "sns-message-1",
    TopicArn: SNS_TOPIC_ARN,
    Subject: "Amazon SES Email Event Notification",
    Message: JSON.stringify(event),
    Timestamp: "2026-10-12T10:00:00.000Z",
    SigningCertURL: SNS_CERT_URL,
    ...overrides,
  });
}

export function subscriptionConfirmation(
  overrides: Partial<Unsigned> = {},
): SnsMessage {
  return signSnsMessage({
    Type: "SubscriptionConfirmation",
    MessageId: "sns-confirm-1",
    TopicArn: SNS_TOPIC_ARN,
    Message: "You have chosen to subscribe to the topic.",
    SubscribeURL: `https://sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&Token=abc`,
    Token: "abc",
    Timestamp: "2026-10-12T10:00:00.000Z",
    SigningCertURL: SNS_CERT_URL,
    ...overrides,
  });
}
