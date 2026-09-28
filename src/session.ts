// Shared by the /app session routes (src/web) and the /api guard: the browser
// gets a signed HttpOnly cookie at /app/login, and /api accepts it for
// same-origin requests so the SPA can read data while agents keep the bearer.
import {
  InvalidCookieSignature,
  type Context,
  type CookieOptions,
} from "elysia";

export const SESSION_COOKIE = "session";
// The signed payload carries its own absolute expiry (`authenticated:<ms>`),
// so a captured cookie cannot be replayed past it. The Set-Cookie `Max-Age` is
// a browser hint only — this is the server-side check.
const SESSION_VALUE_PREFIX = "authenticated";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
export const MIN_PASSWORD_LENGTH = 12;

// A POST/PUT/DELETE is only accepted from the app itself: modern browsers send
// `Sec-Fetch-Site: same-origin`, and Origin is the fallback for clients that
// don't set it. Same shape as the retired SSR admin's isSameOriginPost.
export function isSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// Mints the signed cookie payload for a login at `now`, valid until
// `now + SESSION_MAX_AGE_MS`.
export function sessionValue(now: number = Date.now()): string {
  return `${SESSION_VALUE_PREFIX}:${now + SESSION_MAX_AGE_MS}`;
}

export function isSessionValue(
  value: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof value !== "string") return false;
  if (!value.startsWith(`${SESSION_VALUE_PREFIX}:`)) return false;

  const expiresAt = Number(value.slice(SESSION_VALUE_PREFIX.length + 1));
  return Number.isFinite(expiresAt) && expiresAt > now;
}

// The cookie signing secret: an explicit COOKIE_SECRET when set, otherwise the
// admin password. Undefined when no valid password is configured, which is
// what disables the whole mail surface. An empty or too-short explicit secret
// falls back to the password — a weak signing key would let a cookie be
// forged, the same reason the password itself has a length floor.
export function sessionSecret(
  password: string | undefined,
  cookieSecret: string | undefined,
): string | undefined {
  if (password === undefined || password.length < MIN_PASSWORD_LENGTH) {
    return undefined;
  }
  if (
    cookieSecret !== undefined &&
    cookieSecret.length >= MIN_PASSWORD_LENGTH
  ) {
    return cookieSecret;
  }
  return password;
}

// One signed-cookie config for both doors, so /app and /api can never drift on
// the cookie name, the secret or whether signing is on at all.
export function sessionCookieOptions(
  secret: string,
): CookieOptions & { sign: string[] } {
  return { secrets: secret, sign: [SESSION_COOKIE] };
}

// A tampered/expired signed cookie must read as "no session", never a 500.
// Returns the 401 body when it handled the error, undefined for anything else.
export function handleCookieSignatureError(
  error: unknown,
  set: Context["set"],
): { error: string } | undefined {
  if (!(error instanceof InvalidCookieSignature)) return undefined;
  set.status = 401;
  return { error: "unauthorized" };
}
