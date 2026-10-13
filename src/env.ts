import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { normalizePem } from "./utils/pem";
import { splitMailboxes } from "./utils/mailboxes";

// Shared by both IMAP accounts' superRefine checks below: every key in
// `keys` must be set once any one of them is, so a half-configured account
// (host but no password, user but no app password) fails fast at startup
// instead of connecting with an undefined credential.
function requireTogether<T extends Record<string, unknown>>(
  context: z.RefinementCtx,
  value: T,
  keys: readonly (keyof T & string)[],
  reason: string,
): void {
  for (const key of keys) {
    if (!value[key]) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required when ${reason}`,
      });
    }
  }
}

function requireNonEmptyMailboxList(
  context: z.RefinementCtx,
  key: string,
  value: string,
): void {
  if (splitMailboxes(value).length === 0) {
    context.addIssue({
      code: "custom",
      path: [key],
      message: `${key} must name at least one mailbox`,
    });
  }
}

export const envSchema = z
  .object({
    SECRET_KEY: z.string().min(10, "SECRET_KEY is required!"),
    RECEIVER_EMAIL: z.email("RECEIVER_EMAIL is required!"),
    SY_SERENDIPITY_RECEIVER_EMAIL: z.email(
      "SY_SERENDIPITY_RECEIVER_EMAIL is required!",
    ),
    SY_SERENDIPITY_FROM_EMAIL: z.string().optional(),
    // POST /jkrumm-contact is public (the personal site is static and cannot
    // hold SECRET_KEY): comma-separated allowed browser Origins. Unset -> the
    // route 404s. JKRUMM_CONTACT_FROM_EMAIL falls back to the default sender;
    // JKRUMM_CONTACT_RECEIVER_EMAIL falls back to RECEIVER_EMAIL.
    JKRUMM_CONTACT_ORIGINS: z.string().optional(),
    JKRUMM_CONTACT_FROM_EMAIL: z.string().optional(),
    JKRUMM_CONTACT_RECEIVER_EMAIL: z.email().optional(),
    PORT: z.coerce.number().default(3010),

    LLM_BASE_URL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    // Shadow decision lane ("Jev", historical name). `ue` (default) is IU's
    // Unified Endpoint via LLM_BASE_URL + LLM_API_KEY; `openrouter` is the
    // OpenRouter Decisions API via OPENROUTER_API_KEY (use an OpenRouter model
    // id such as `cloudflare/clef` with it). Missing creds -> the lane is
    // disabled everywhere.
    DECISION_PROVIDER: z.enum(["ue", "openrouter"]).default("ue"),
    OPENROUTER_API_KEY: z.string().optional(),
    DECISION_MODEL: z.string().default("clef-eu"),
    // Usage reporting to Argo (src/usage/argo.ts). Either unset -> no-op.
    ARGO_USAGE_URL: z.string().optional(),
    ARGO_API_SECRET: z.string().optional(),
    MACHINE: z.string().default("vps"),
    ADMIN_PASSWORD: z.string().optional(),
    // Signing secret for the /app session cookie. Falls back to
    // ADMIN_PASSWORD when unset or shorter than 12 chars (src/session.ts's
    // sessionSecret), so there is no new required secret and a weak override
    // can't become the signing key.
    COOKIE_SECRET: z.string().optional(),
    // When set, the mail surface (/app, /api) answers only on this hostname;
    // unset -> reachable on any Host. Dev and prod leave it unset until Wave 9.
    // An empty string must be a validation error, not a silent gate bypass.
    MAIL_HOST: z.string().min(1).optional(),
    // Amazon SES, the only send provider (src/providers/ses). Region, both
    // keys and the configuration set are required. Credentials are passed to
    // the client explicitly — no ambient AWS credential chain.
    // SES_SNS_TOPIC_ARN turns on the public POST /webhooks/ses event door
    // (needs SES_REGION to pin the SNS host); unset -> that path 404s.
    SES_REGION: z.string().min(1, "SES_REGION is required!"),
    SES_ACCESS_KEY_ID: z.string().min(1, "SES_ACCESS_KEY_ID is required!"),
    SES_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "SES_SECRET_ACCESS_KEY is required!"),
    SES_CONFIGURATION_SET: z
      .string()
      .min(1, "SES_CONFIGURATION_SET is required!"),
    SES_SNS_TOPIC_ARN: z.string().optional(),

    // Directory for the SQLite database file. Defaults to ./data so local dev
    // doesn't need any setup; ops sets it to a mounted volume path in prod.
    DATA_DIR: z.string().default("./data"),
    // Bearer key for /api/*. Unset -> every /api route 404s.
    API_KEY: z.string().min(16).optional(),
    // Read-only bearer key for GET /sy-serendipity/requests (the SY Serendipity
    // admin panel). Opens nothing else: not /api, not the send routes. Unset ->
    // the route 404s.
    SY_SERENDIPITY_READ_KEY: z.string().min(32).optional(),

    // IMAP ingest (Proton Mail Bridge). Unset host -> IMAP ingest disabled.
    IMAP_HOST: z.string().optional(),
    IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(1143),
    IMAP_USER: z.string().optional(),
    IMAP_PASSWORD: z.string().optional(),
    IMAP_MAILBOXES: z.string().default("INBOX,Spam"),
    // PEM of the server certificate to pin (literal "\n" sequences accepted so
    // it fits a one-line secret). Preferred over IMAP_TLS_INSECURE.
    IMAP_TLS_CERT: z.string().optional(),
    IMAP_TLS_INSECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // IMAP ingest (Gmail, imap.gmail.com over implicit TLS). Unset user ->
    // Gmail ingest disabled. The port is fixed (993) and the certificate is
    // not pinned (a public CA). Default mailbox is INBOX only: Gmail's
    // Archive/Spam/Trash folder paths are localized ("[Gmail]/…"), so the
    // owner opts into any others by name.
    GMAIL_IMAP_USER: z.string().optional(),
    GMAIL_IMAP_APP_PASSWORD: z.string().optional(),
    GMAIL_IMAP_MAILBOXES: z.string().default("INBOX"),
  })
  .superRefine((value, context) => {
    if (value.SES_SNS_TOPIC_ARN) {
      // arn:aws:sns:<region>:<account>:<topic> — the webhook pins the SNS
      // host to SES_REGION, so a topic in another region could never verify.
      const topicRegion = value.SES_SNS_TOPIC_ARN.split(":")[3];
      if (topicRegion !== value.SES_REGION) {
        context.addIssue({
          code: "custom",
          path: ["SES_SNS_TOPIC_ARN"],
          message: "SES_SNS_TOPIC_ARN must be a topic in SES_REGION",
        });
      }
    }

    if (value.IMAP_HOST) {
      requireTogether(
        context,
        value,
        ["IMAP_USER", "IMAP_PASSWORD"],
        "IMAP_HOST is set",
      );
      if (value.IMAP_TLS_CERT) {
        try {
          new X509Certificate(normalizePem(value.IMAP_TLS_CERT));
        } catch {
          context.addIssue({
            code: "custom",
            path: ["IMAP_TLS_CERT"],
            message: "IMAP_TLS_CERT is not a valid PEM certificate",
          });
        }
      }
      requireNonEmptyMailboxList(
        context,
        "IMAP_MAILBOXES",
        value.IMAP_MAILBOXES,
      );
    }

    if (value.GMAIL_IMAP_USER || value.GMAIL_IMAP_APP_PASSWORD) {
      requireTogether(
        context,
        value,
        ["GMAIL_IMAP_USER", "GMAIL_IMAP_APP_PASSWORD"],
        "Gmail IMAP is configured",
      );
      requireNonEmptyMailboxList(
        context,
        "GMAIL_IMAP_MAILBOXES",
        value.GMAIL_IMAP_MAILBOXES,
      );
    }
  });

export function parseEnv(
  environment: Record<string, string | undefined> = process.env,
) {
  // Compose interpolates an unset `${VAR}` to "", which must read as unset —
  // otherwise optional vars with a min length crash-loop the container. The
  // one exception is MAIL_HOST: a present-but-empty value would read as unset
  // and silently disable the mail-surface host gate (src/host-gate.ts), which
  // is exactly the bypass the schema's min(1) cannot catch once the strip has
  // run, so it is checked against the raw env before the generic strip.
  if (environment.MAIL_HOST === "") {
    throw new Error(
      "Invalid environment variables:\n  - MAIL_HOST: MAIL_HOST must not be empty",
    );
  }

  const definedEnv = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== ""),
  );
  const result = envSchema.safeParse(definedEnv);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  return result.data;
}

export const env = parseEnv();
