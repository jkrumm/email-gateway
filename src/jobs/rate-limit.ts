import { GatewayRateLimitError } from '@ai-sdk/gateway'
import { APICallError } from 'ai'

// Fallback substrings for rate-limit signals that don't arrive as a typed
// `GatewayRateLimitError` — e.g. a generic Error wrapping an upstream
// message, or a different provider surfacing a 429 its own way.
const RATE_LIMIT_MESSAGE_PATTERNS = [
  'rate_limit_exceeded',
  'rate_limit',
  'rate limit',
  'high demand',
]

// AWS SDK errors (SES) are recognised by shape, never by importing the SDK:
// it costs RSS at boot (src/providers/ses/send.ts loads it lazily). Throttling
// and quota signals only — AccountSuspendedException and the like are real
// failures a retry ladder must not hide.
const AWS_THROTTLE_ERROR_NAMES = new Set([
  'TooManyRequestsException',
  'SendingPausedException',
  'LimitExceededException',
])

function isAwsThrottleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, $metadata } = error as {
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  if (typeof name === 'string' && AWS_THROTTLE_ERROR_NAMES.has(name)) {
    return true
  }
  return $metadata?.httpStatusCode === 429
}

// Classifies an error as a rate-limit signal so a caller can park a job
// (src/db/jobs.ts's `fail({ ..., rateLimited: true })`) instead of burning a
// normal attempt on it. Never throws.
export function isRateLimitError(error: unknown): boolean {
  if (GatewayRateLimitError.isInstance(error)) return true
  // Any provider's HTTP 429 — e.g. OpenRouter's Decisions API relaying
  // Workers AI's "Capacity temporarily exceeded" (2026-10-05).
  if (APICallError.isInstance(error) && error.statusCode === 429) return true

  if (isAwsThrottleError(error)) return true

  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  return RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))
}
