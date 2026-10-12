import { GatewayRateLimitError } from "@ai-sdk/gateway";
import { APICallError } from "ai";

// Fallback substrings for rate-limit signals that don't arrive as a typed
// `GatewayRateLimitError` — e.g. a generic Error wrapping an upstream
// message, or a different provider surfacing a 429 its own way.
const RATE_LIMIT_MESSAGE_PATTERNS = [
  "rate_limit_exceeded",
  "rate_limit",
  "rate limit",
  "high demand",
];

// Classifies an error as a rate-limit signal so a caller can park a job
// (src/db/jobs.ts's `fail({ ..., rateLimited: true })`) instead of burning a
// normal attempt on it. Never throws.
export function isRateLimitError(error: unknown): boolean {
  if (GatewayRateLimitError.isInstance(error)) return true;
  // Any provider's HTTP 429 — e.g. OpenRouter's Decisions API relaying
  // Workers AI's "Capacity temporarily exceeded" (2026-10-05).
  if (APICallError.isInstance(error) && error.statusCode === 429) return true;

  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}
