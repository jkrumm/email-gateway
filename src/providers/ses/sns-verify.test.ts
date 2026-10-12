import { describe, expect, test } from "bun:test";
import {
  notification,
  SNS_CERT_URL,
  SNS_REGION,
  snsPublicKeyPem,
  subscriptionConfirmation,
} from "../../test/sns-fixture";
import { createSnsVerifier, trustedSnsUrl } from "./sns-verify";

function setup() {
  const fetched: string[] = [];
  const verifier = createSnsVerifier({
    region: SNS_REGION,
    fetchCert: async (url) => {
      fetched.push(url);
      return snsPublicKeyPem;
    },
  });
  return { verifier, fetched };
}

const event = { eventType: "Delivery", mail: { messageId: "ses-msg-1" } };

describe("createSnsVerifier", () => {
  test("accepts a valid v2 and v1 Notification", async () => {
    const { verifier } = setup();

    expect(await verifier.verify(notification(event))).toBe(true);
    expect(
      await verifier.verify(notification(event, { SignatureVersion: "1" })),
    ).toBe(true);
  });

  test("accepts a Notification without a Subject", async () => {
    const { verifier } = setup();

    expect(
      await verifier.verify(notification(event, { Subject: undefined })),
    ).toBe(true);
  });

  test("accepts a valid SubscriptionConfirmation, v1 and v2", async () => {
    const { verifier } = setup();

    expect(await verifier.verify(subscriptionConfirmation())).toBe(true);
    expect(
      await verifier.verify(
        subscriptionConfirmation({ SignatureVersion: "1" }),
      ),
    ).toBe(true);
  });

  test("a tampered Message fails", async () => {
    const { verifier } = setup();

    const tampered = {
      ...notification(event),
      Message: JSON.stringify({ ...event, eventType: "Bounce" }),
    };

    expect(await verifier.verify(tampered)).toBe(false);
  });

  test("a signature from another key fails", async () => {
    const { verifier } = setup();

    const other = { ...notification(event), Signature: "AAAA" };

    expect(await verifier.verify(other)).toBe(false);
  });

  test("an unsupported SignatureVersion fails without fetching", async () => {
    const { verifier, fetched } = setup();

    for (const SignatureVersion of ["0", "3", "", "toString"]) {
      const message = { ...notification(event), SignatureVersion };
      expect(await verifier.verify(message)).toBe(false);
    }
    expect(fetched).toEqual([]);
  });

  test.each([
    ["http", `http://sns.${SNS_REGION}.amazonaws.com/cert.pem`],
    ["wrong region", "https://sns.us-east-1.amazonaws.com/cert.pem"],
    [
      "other-region suffix host",
      "https://sns.us-east-1.amazonaws.com.evil.com/cert.pem",
    ],
    [
      "suffix host",
      `https://sns.${SNS_REGION}.amazonaws.com.evil.com/cert.pem`,
    ],
    ["prefix host", `https://evilsns.${SNS_REGION}.amazonaws.com/cert.pem`],
    ["port", `https://sns.${SNS_REGION}.amazonaws.com:8443/cert.pem`],
    ["credentials", `https://user:pw@sns.${SNS_REGION}.amazonaws.com/cert.pem`],
    [
      "userinfo trick",
      `https://sns.${SNS_REGION}.amazonaws.com@evil.com/c.pem`,
    ],
    ["not a pem", `https://sns.${SNS_REGION}.amazonaws.com/cert.txt`],
    ["not a url", "not a url"],
  ])("a %s cert URL is rejected without fetching", async (_name, url) => {
    const { verifier, fetched } = setup();

    const message = notification(event, { SigningCertURL: url });

    expect(await verifier.verify(message)).toBe(false);
    expect(fetched).toEqual([]);
  });

  test("caches the certificate by URL", async () => {
    const { verifier, fetched } = setup();

    await verifier.verify(notification(event));
    await verifier.verify(notification(event));

    expect(fetched).toEqual([SNS_CERT_URL]);
  });

  test("a certificate fetch failure rejects", async () => {
    const verifier = createSnsVerifier({
      region: SNS_REGION,
      fetchCert: async () => {
        throw new Error("timeout");
      },
    });

    await expect(verifier.verify(notification(event))).rejects.toThrow(
      "timeout",
    );
  });
});

describe("trustedSnsUrl", () => {
  test("accepts the exact regional host over https", () => {
    const url = `https://sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&Token=t`;

    expect(trustedSnsUrl(url, SNS_REGION)?.href).toBe(url);
  });

  test("rejects other hosts, schemes and a trailing-dot host", () => {
    for (const url of [
      `http://sns.${SNS_REGION}.amazonaws.com/`,
      `https://sns.${SNS_REGION}.amazonaws.com.evil.com/`,
      `https://sns.${SNS_REGION}.amazonaws.com./`,
      `https://evil.com/sns.${SNS_REGION}.amazonaws.com`,
      "https://evil.com\\@sns.eu-central-1.amazonaws.com/",
    ]) {
      expect(trustedSnsUrl(url, SNS_REGION)).toBeNull();
    }
  });
});
