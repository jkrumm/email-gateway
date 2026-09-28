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
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required!"),
    SY_SERENDIPITY_RECEIVER_EMAIL: z.email(
      "SY_SERENDIPITY_RECEIVER_EMAIL is required!",
    ),
    SY_SERENDIPITY_FROM_EMAIL: z.string().optional(),
    PORT: z.coerce.number().default(3010),

    LLM_BASE_URL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    // Jev decision model (shadow mode). Unset key -> Jev is disabled everywhere.
    JEV_API_KEY: z.string().optional(),
    JEV_MODEL: z.string().default("typesafe-ai/jev"),
    ADMIN_PASSWORD: z.string().optional(),
    // Full-access key for the admin UI's list/get calls; the send path keeps
    // the sending-only RESEND_API_KEY.
    RESEND_ADMIN_API_KEY: z.string().optional(),

    // Directory for the SQLite database file. Defaults to ./data so local dev
    // doesn't need any setup; ops sets it to a mounted volume path in prod.
    DATA_DIR: z.string().default("./data"),
    // Bearer key for /api/*. Unset -> every /api route 404s.
    API_KEY: z.string().min(16).optional(),

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

function parseEnv() {
  // Compose interpolates an unset `${VAR}` to "", which must read as unset —
  // otherwise optional vars with a min length crash-loop the container.
  const definedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
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
