import { GatewayRateLimitError } from "@ai-sdk/gateway";

// Fallback substrings for rate-limit signals that don't arrive as a typed
// `GatewayRateLimitError` — e.g. a generic Error wrapping an upstream
// message, or a different provider surfacing a 429 its own way.
const RATE_LIMIT_MESSAGE_PATTERNS = [
  "rate_limit_exceeded",
  // Resend's own error carries `name: "rate_limit"` (src/jobs/send.ts
  // rethrows it as "rate_limit - <message>") — shorter than the gateway's
  // "rate_limit_exceeded", so it needs its own entry rather than relying on
  // the longer pattern to match it.
  "rate_limit",
  "rate limit",
  "high demand",
];

// Classifies an error as a rate-limit signal so a caller can park a job
// (src/db/jobs.ts's `fail({ ..., rateLimited: true })`) instead of burning a
// normal attempt on it. Never throws.
export function isRateLimitError(error: unknown): boolean {
  if (GatewayRateLimitError.isInstance(error)) return true;

  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}
