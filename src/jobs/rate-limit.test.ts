import { describe, expect, test } from "bun:test";
import { GatewayRateLimitError } from "@ai-sdk/gateway";
import { APICallError } from "@ai-sdk/provider";
import { isRateLimitError } from "./rate-limit";

describe("isRateLimitError", () => {
  test("recognises a real GatewayRateLimitError", () => {
    expect(
      isRateLimitError(new GatewayRateLimitError({ message: "slow down" })),
    ).toBe(true);
  });

  test.each([
    "rate_limit_exceeded",
    "rate limit",
    "high demand",
    "Rate Limit exceeded",
    "RATE_LIMIT_EXCEEDED: too many requests",
    "server under HIGH DEMAND",
  ])("recognises a fallback substring in %p", (message) => {
    expect(isRateLimitError(new Error(message))).toBe(true);
  });

  test("recognises any provider's HTTP 429 APICallError", () => {
    const error = new APICallError({
      message: "HTTP 429: Capacity temporarily exceeded",
      url: "https://openrouter.ai/api/alpha/decisions",
      requestBodyValues: {},
      statusCode: 429,
    });
    expect(isRateLimitError(error)).toBe(true);
  });

  test("does not treat a non-429 APICallError as a rate limit", () => {
    const error = new APICallError({
      message: "Forbidden",
      url: "https://openrouter.ai/api/alpha/decisions",
      requestBodyValues: {},
      statusCode: 403,
    });
    expect(isRateLimitError(error)).toBe(false);
  });

  test("returns false for an unrelated Error", () => {
    expect(isRateLimitError(new Error("boom"))).toBe(false);
  });

  // A bare "429" is too loose: an unrelated error message that happens to
  // mention the number 429 (a UID, a byte count, anything) would otherwise
  // be classified as rate-limited and park the job on the first rung of the
  // backoff ladder forever, without ever spending an attempt or going
  // terminal.
  test.each([
    "HTTP 429 from upstream",
    "IMAP UID 429 could not be parsed",
    "message size 429 bytes exceeds limit",
  ])("does not treat a bare '429' mention in %p as a rate limit", (message) => {
    expect(isRateLimitError(new Error(message))).toBe(false);
  });

  test.each([null, undefined, "some string", { message: "rate limit" }])(
    "returns false without throwing for %p",
    (value) => {
      expect(() => isRateLimitError(value)).not.toThrow();
      expect(isRateLimitError(value)).toBe(false);
    },
  );
});
