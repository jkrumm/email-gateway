// Pure mapping and redaction helpers for the OTel exporter — dependency-free (no env, no
// network) so they are unit-testable on their own. The wiring (span model, queues, OTLP/HTTP
// JSON over plain fetch) lives in otel.ts, which imports these.

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` → header map. `key=value,key=value`; values MAY contain `=`
 * (a base64 token) — only the FIRST `=` splits key from value. A pair with no `=`, an empty
 * key, or an empty value is skipped rather than failing boot.
 */
export function parseOtlpHeadersEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * The standard `OTEL_RESOURCE_ATTRIBUTES` env var (`key=value,key=value`) so compose can
 * override or extend the resource without a code change. Malformed pairs are skipped.
 */
export function parseResourceAttributesEnv(
  raw: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * The only part of a caught error that spans may carry: a failure's message and stack can
 * echo the mail being handled (subject, body, an auth code, a prompt), so span status and
 * exception events record the name alone.
 */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/**
 * A nanosecond wall clock that cannot step backwards: the wall time once at creation plus
 * the elapsed monotonic time, so span durations survive an NTP adjustment mid-span. Both
 * sources are injected so tests are deterministic.
 */
export function createNanoClock(
  wallMs: number,
  monotonicNs: () => number,
): () => bigint {
  const origin = BigInt(wallMs) * 1_000_000n;
  const startNs = BigInt(Math.trunc(monotonicNs()));
  return () => origin + (BigInt(Math.trunc(monotonicNs())) - startNs);
}

// ── Redaction ────────────────────────────────────────────────────────────────
// Telemetry is the one place mail content could leak by accident, so the exporter sanitises
// at its single choke point (every span/log attribute, status message, exception and log
// body passes through here) instead of trusting each call site. Console output is not
// affected: only the OTLP copy is scrubbed.

const REDACTED_EMAIL = "[redacted-email]";
const EMAIL_PATTERN = /[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[^\s<>"'(),;:@]+/g;

/** Replace anything address-shaped (also covers `<id@host>` Message-IDs) in free text. */
export function scrubText(text: string): string {
  return text.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

// Attribute names whose value is mail content or a secret — dropped outright, whatever the
// value. Compared after lower-casing and stripping `.`/`_`/`-`, against the whole key and
// against its last dot-segment (`http.request.header.authorization`).
const SENSITIVE_KEYS = new Set([
  "to",
  "from",
  "replyto",
  "cc",
  "bcc",
  "subject",
  "recipient",
  "recipients",
  "address",
  "addresses",
  "email",
  "body",
  "html",
  "text",
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "messageid",
  "authcode",
  "code",
  "prompt",
  "output",
  "completion",
]);
// `code` is only sensitive as a whole key (the auth-code field); as a last segment it is
// the generic suffix of `error.code`-style diagnostics.
const SENSITIVE_WHOLE_KEY_ONLY = new Set(["code"]);

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[._-]/g, "");

export function isSensitiveKey(key: string): boolean {
  const whole = normalizeKey(key);
  // `providerMessageId`, `message_id`, ... — any message id, ours or the sender's.
  if (SENSITIVE_KEYS.has(whole) || whole.endsWith("messageid")) return true;
  const lastSegment = normalizeKey(key.split(".").at(-1) ?? "");
  return (
    SENSITIVE_KEYS.has(lastSegment) &&
    !SENSITIVE_WHOLE_KEY_ONLY.has(lastSegment)
  );
}

export type LogAttributeValue = string | number | boolean;

function errorText(error: Error): string {
  return `${error.name}: ${error.message}`;
}

/**
 * Turns arbitrary log fields into OTel-legal attributes (string/number/boolean only).
 * Errors become `Name: message` (an Error JSON-stringifies to `{}`), other non-scalars are
 * JSON-stringified, `undefined` and `null` are dropped (an absent attribute is the honest
 * "no value"). Sensitive keys are dropped and address-shaped
 * text is scrubbed from every string.
 */
export function toLogAttributes(
  fields: Record<string, unknown>,
): Record<string, LogAttributeValue> {
  const attrs: Record<string, LogAttributeValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || isSensitiveKey(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      attrs[key] = value;
      continue;
    }
    if (typeof value === "string") {
      attrs[key] = scrubText(value);
      continue;
    }
    if (value instanceof Error) {
      attrs[key] = scrubText(errorText(value));
      continue;
    }
    attrs[key] = scrubText(safeStringify(value));
  }
  return attrs;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ── Severity ─────────────────────────────────────────────────────────────────

export type LogSeverity = "info" | "warn" | "error";

/**
 * Mechanical severity for a structured event: ERROR when the name ends in `.failed` or
 * `.error`; WARN when the fields carry a truthy `error` or the name ends in `.rejected`,
 * `.rate_limited` or `.stalled`; INFO otherwise. Legacy `log.*` lines take their severity
 * from the console method they replace and never come through here.
 */
export function severityFor(
  event: string,
  fields: Record<string, unknown> = {},
): LogSeverity {
  if (event.endsWith(".failed") || event.endsWith(".error")) return "error";
  if (
    Boolean(fields["error"]) ||
    event.endsWith(".rejected") ||
    event.endsWith(".rate_limited") ||
    event.endsWith(".stalled")
  ) {
    return "warn";
  }
  return "info";
}
