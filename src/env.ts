import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { normalizePem } from "./utils/pem";
import { splitMailboxes } from "./utils/mailboxes";
import { parseSendProviders, sesConfigured } from "./providers/send-select";

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
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required!"),
    SY_SERENDIPITY_RECEIVER_EMAIL: z.email(
      "SY_SERENDIPITY_RECEIVER_EMAIL is required!",
    ),
    SY_SERENDIPITY_FROM_EMAIL: z.string().optional(),
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
    // Full-access key for the admin UI's list/get calls; the send path keeps
    // the sending-only RESEND_API_KEY.
    RESEND_ADMIN_API_KEY: z.string().optional(),
    // Which provider each template sends through: `templateId=provider,...`.
    // Unset or unlisted templates use resend. Parsed to a template id ->
    // provider name map; an unknown provider or template id fails startup.
    SEND_PROVIDERS: z
      .string()
      .optional()
      .transform((raw, context) => {
        const { map, issues } = parseSendProviders(raw);
        for (const message of issues) {
          context.addIssue({ code: "custom", message });
        }
        return map;
      }),

    // Amazon SES as a second send provider (src/providers/ses). All four of
    // region, both keys and the configuration set must be set for SES to be
    // configured; SEND_PROVIDERS routing a template to `ses` without that
    // fails startup. Credentials are passed to the client explicitly — no
    // ambient AWS credential chain. SES_SNS_TOPIC_ARN turns on the public
    // POST /webhooks/ses event door (needs SES_REGION to pin the SNS host);
    // unset -> that path 404s.
    SES_REGION: z.string().optional(),
    SES_ACCESS_KEY_ID: z.string().optional(),
    SES_SECRET_ACCESS_KEY: z.string().optional(),
    SES_CONFIGURATION_SET: z.string().optional(),
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
    if (
      Object.values(value.SEND_PROVIDERS).includes("ses") &&
      !sesConfigured(value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["SEND_PROVIDERS"],
        message:
          "SEND_PROVIDERS routes a template to ses, which needs SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY and SES_CONFIGURATION_SET",
      });
    }
    if (value.SES_SNS_TOPIC_ARN) {
      requireTogether(
        context,
        value,
        ["SES_REGION"],
        "SES_SNS_TOPIC_ARN is set",
      );
      // arn:aws:sns:<region>:<account>:<topic> — the webhook pins the SNS
      // host to SES_REGION, so a topic in another region could never verify.
      const topicRegion = value.SES_SNS_TOPIC_ARN.split(":")[3];
      if (value.SES_REGION && topicRegion !== value.SES_REGION) {
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
