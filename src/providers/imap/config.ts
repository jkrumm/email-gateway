import { env } from "../../env";
import { splitMailboxes } from "../../utils/mailboxes";
import type { ImapConfig } from "./adapter";

type ImapEnv = Pick<
  typeof env,
  | "IMAP_HOST"
  | "IMAP_PORT"
  | "IMAP_USER"
  | "IMAP_PASSWORD"
  | "IMAP_MAILBOXES"
  | "IMAP_TLS_CERT"
  | "IMAP_TLS_INSECURE"
>;

type GmailImapEnv = Pick<
  typeof env,
  "GMAIL_IMAP_USER" | "GMAIL_IMAP_APP_PASSWORD" | "GMAIL_IMAP_MAILBOXES"
>;

// Gmail's IMAP endpoint is fixed: a public CA over implicit TLS (unlike
// Bridge's STARTTLS + optional pinned certificate).
const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

// Undefined when IMAP ingest isn't configured. env.ts already rejected a host
// without credentials at startup.
export function imapConfigFromEnv(
  source: ImapEnv = env,
): ImapConfig | undefined {
  if (!source.IMAP_HOST || !source.IMAP_USER || !source.IMAP_PASSWORD) {
    return undefined;
  }

  return {
    host: source.IMAP_HOST,
    port: source.IMAP_PORT,
    user: source.IMAP_USER,
    password: source.IMAP_PASSWORD,
    mailboxes: splitMailboxes(source.IMAP_MAILBOXES),
    tls: "starttls",
    tlsCert: source.IMAP_TLS_CERT,
    tlsInsecure: source.IMAP_TLS_INSECURE,
  };
}

// Undefined when Gmail ingest isn't configured. env.ts already rejected a user
// without an app password at startup. Named per-account vars rather than a
// MAIL_ACCOUNTS JSON blob: they match the existing IMAP_* naming and keep
// 1Password templating (vps/apps/email-gateway/.env.tpl) one line per secret.
export function gmailImapConfigFromEnv(
  source: GmailImapEnv = env,
): ImapConfig | undefined {
  if (!source.GMAIL_IMAP_USER || !source.GMAIL_IMAP_APP_PASSWORD) {
    return undefined;
  }

  return {
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    user: source.GMAIL_IMAP_USER,
    password: source.GMAIL_IMAP_APP_PASSWORD,
    mailboxes: splitMailboxes(source.GMAIL_IMAP_MAILBOXES),
    tls: "implicit",
    tlsInsecure: false,
  };
}
