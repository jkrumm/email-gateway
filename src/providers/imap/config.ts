import { env } from "../../env";
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
    mailboxes: source.IMAP_MAILBOXES.split(",")
      .map((mailbox) => mailbox.trim())
      .filter(Boolean),
    tlsCert: source.IMAP_TLS_CERT,
    tlsInsecure: source.IMAP_TLS_INSECURE,
  };
}
