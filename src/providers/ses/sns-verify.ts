import { createVerify } from "node:crypto";
import { z } from "zod";

// Pure SNS message verification (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html),
// env-free: the region and the certificate fetcher are injected. SNS posts to
// a public URL, so the signature is the only authentication — and
// SigningCertURL / SubscribeURL are attacker-controlled until verified, so
// both are pinned to the exact regional SNS host before anything is fetched.
export const snsMessageSchema = z.object({
  Type: z.enum([
    "SubscriptionConfirmation",
    "Notification",
    "UnsubscribeConfirmation",
  ]),
  MessageId: z.string(),
  TopicArn: z.string(),
  Message: z.string(),
  Timestamp: z.string(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
  SignatureVersion: z.string(),
  Signature: z.string(),
  SigningCertURL: z.string(),
});

export type SnsMessage = z.infer<typeof snsMessageSchema>;

// Fetches the PEM at an already-validated URL; throws on any failure.
export type FetchCert = (url: string) => Promise<string>;

export interface SnsVerifier {
  verify(message: SnsMessage): Promise<boolean>;
}

const CERT_FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED_CERTS = 8;

// Field order is fixed by SNS; only keys the message actually carries count.
const SIGNED_KEYS: Record<SnsMessage["Type"], readonly (keyof SnsMessage)[]> = {
  Notification: [
    "Message",
    "MessageId",
    "Subject",
    "Timestamp",
    "TopicArn",
    "Type",
  ],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

const ALGORITHM_BY_SIGNATURE_VERSION: Record<string, string> = {
  "1": "RSA-SHA1",
  "2": "RSA-SHA256",
};

// The parsed URL when it is https, carries no credentials or port, and its
// host is EXACTLY `sns.<region>.amazonaws.com` (an exact compare on the parsed
// hostname, so `…amazonaws.com.evil.com`, `evilsns.…` and `host\@evil` tricks
// all fail); null otherwise. Callers fetch the returned URL's href, never the
// raw string. `pem` additionally requires a `.pem` path (the signing cert).
export function trustedSnsUrl(
  raw: string,
  region: string,
  { pem = false }: { pem?: boolean } = {},
): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (url.hostname !== `sns.${region}.amazonaws.com`) return null;
  if (pem && !url.pathname.endsWith(".pem")) return null;
  return url;
}

function stringToSign(message: SnsMessage): string {
  return SIGNED_KEYS[message.Type]
    .filter((key) => message[key] !== undefined)
    .map((key) => `${key}\n${message[key]}\n`)
    .join("");
}

async function fetchCertPem(url: string): Promise<string> {
  // redirect: "error" — a 3xx must not walk the fetch off the pinned host.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`SNS signing certificate fetch failed: ${response.status}`);
  }
  const pem = await response.text();
  if (pem.length > MAX_CERT_BYTES || !pem.includes("BEGIN CERTIFICATE")) {
    throw new Error("SNS signing certificate is not a PEM certificate");
  }
  return pem;
}

export function createSnsVerifier({
  region,
  fetchCert = fetchCertPem,
}: {
  region: string;
  fetchCert?: FetchCert;
}): SnsVerifier {
  // Small bounded cache by URL (SNS rotates certs rarely); oldest out first.
  const certs = new Map<string, string>();

  async function certFor(url: string): Promise<string> {
    const cached = certs.get(url);
    if (cached) return cached;

    const pem = await fetchCert(url);
    if (certs.size >= MAX_CACHED_CERTS) {
      certs.delete(certs.keys().next().value!);
    }
    certs.set(url, pem);
    return pem;
  }

  return {
    // False for any message that is not provably from SNS; throws only when
    // the (validated) certificate cannot be fetched.
    async verify(message) {
      const algorithm = Object.hasOwn(
        ALGORITHM_BY_SIGNATURE_VERSION,
        message.SignatureVersion,
      )
        ? ALGORITHM_BY_SIGNATURE_VERSION[message.SignatureVersion]
        : undefined;
      if (!algorithm) return false;

      const certUrl = trustedSnsUrl(message.SigningCertURL, region, {
        pem: true,
      });
      if (!certUrl) return false;

      const certPem = await certFor(certUrl.href);
      try {
        return createVerify(algorithm)
          .update(stringToSign(message), "utf8")
          .verify(certPem, message.Signature, "base64");
      } catch {
        return false;
      }
    },
  };
}
