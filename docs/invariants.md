# Invariants that change a decision

- **`POST /jkrumm-contact` is the one unauthenticated send route.** No bearer
  (static site, no secret to hold); its guards are the `JKRUMM_CONTACT_ORIGINS`
  allow-list (checked in `onRequest`, so a bad Origin is 403 before body
  validation and every response carries CORS), the `website` honeypot, the spam
  gate and Traefik's rate limit. Never add a visitor confirmation or any
  recipient the caller controls — that would make it an open relay. The
  receiver is `JKRUMM_CONTACT_RECEIVER_EMAIL` (e.g. `hello@<your-domain>`),
  falling back to `RECEIVER_EMAIL`; `JKRUMM_CONTACT_FROM_EMAIL` is the sender.
- **`POST /shutterflow` carries one-time auth codes.** Own bearer
  (`SHUTTERFLOW_SECRET_KEY`, never `SECRET_KEY`), no spam gate, synchronous send,
  502 on a provider error. The subject leads with the code, so `sendMail` is
  always called with `sensitiveSubject: true` there (logs say `[redacted]`);
  never log the body or the rendered mail, and `send_log` records only the
  recipient and template id.
- **`POST /athena` carries one-time sign-in codes for IU staff.** Same shape as
  `/shutterflow` (own bearer `ATHENA_SECRET_KEY`, never `SECRET_KEY`; unset → 404;
  no spam gate; synchronous; 502 on a provider error; `sensitiveSubject: true`),
  and stricter: `code` is exactly six digits, `expiresInMinutes` ≤ 15, `to` is one
  `@iu.org` address (anything else is a 422, so a leaked key cannot mail outsiders).
  The subject spells the code spaced (`482 915`), the body once as `482915`; the template's `redact`
  returns both. Sender and Reply-To come from `ATHENA_FROM_EMAIL` / `ATHENA_REPLY_TO`
  in the deploy env (the repo is public); never an `@iu.org` From.
- **Three live callers, contract frozen.** FPP web (Vercel, 7 s abort),
  fpp-analytics (VPS, 30 s), sy-serendipity (Netlify, 10 s) post to the send
  routes with the shared `SECRET_KEY`. Paths, body schemas, 2xx-on-suppressed
  and the 8 s classifier deadline (`src/spam/gate.ts`) stay. A non-2xx is a
  user-visible failure on those sites.
- **Every push to `master` deploys** (RollHook, `.github/workflows/deploy.yml`,
  no CI test gate). During a deploy **two containers share one SQLite file** for
  a short overlap — every queue is `src/db/jobs.ts`'s one `jobs` table now
  (atomic claim with a token, stale takeover after `JOB_STALE_CLAIM_MS`,
  `reapOwnStaleClaims()` once at boot per `src/jobs/register.ts`), never an
  in-memory lock alone. Safe only while `vps/apps/email-gateway/compose.yml`
  sets no `hostname:` (see the comment next to `reapOwnStaleClaims`).
- **IMAP sync stays read-only**: `EXAMINE` + `BODY.PEEK`, STARTTLS required for
  Bridge (implicit TLS for Gmail), cert pinned by SHA-256 when `IMAP_TLS_CERT`
  is set. The IMAP adapter (`src/providers/imap/adapter.ts`) does expose
  `setFlags`/`move` (`SELECT`, per D2) for future callers — the sync tick
  itself never opens a mailbox for write. Capabilities are detected per
  connection, and each IMAP provider ingests only its own mailbox list
  (`defaultMailboxesFor`, `src/sync/composition.ts`) — never another account's.
- **`messages` rows refresh on every re-sight** (Wave 4) — unlike the old
  Message-ID-derived id, `messages.key` is `sha256(account:provider:mailbox:
  uidValidity:uid)`, never attacker-influenced, so `ON CONFLICT DO UPDATE`ing
  envelope metadata (flags, subject, date) on re-sight carries none of the old
  insert-only rule's spoofed-Message-ID risk. Ingest never touches a message's
  body at all (`src/sync/ingest.ts` is envelope-only); `body_cache` is filled
  separately, only by a live `read()` (the classify job, or an API caller).
- **Fail open on the submission path.** The gate never 500s after delivery; DB
  errors there are logged, not thrown. The classifier and Jev are optional at
  runtime (unset env → off, rows stay unclassified).
- **Memory is 256 MB** in prod. Envelope-only ingest has no body-size bound to
  enforce (bodies are never fetched during sync) — the only per-run bound is
  `src/sync/ingest.ts`'s `DEFAULT_MAX_PAGES_PER_RUN` (20 pages of up to 500
  envelopes each) on the backfill pass; the head pass is always exactly one
  page.
- **`POST /webhooks/ses` is on the public door and signature-verified.** It sits
  outside the `MAIL_HOST` guard (SNS cannot reach the gated surface); the SNS
  message signature is its only auth. Order is fixed: `TopicArn` pin (403)
  before any network fetch, then `SigningCertURL`/`SubscribeURL` held to
  exactly `https://sns.<SES_REGION>.amazonaws.com` (SSRF), then the signature.
  Never log the payload (recipient PII); raw SNS message delivery must stay
  off. **SES is the only send provider**: `SES_REGION`/`_ACCESS_KEY_ID`/
  `_SECRET_ACCESS_KEY`/`_CONFIGURATION_SET` are required (missing → startup
  fails); `SES_SNS_TOPIC_ARN` is optional and gates the webhook (unset → 404).
  This door is also the only source of `send_log` status after a send. SES has no idempotency key: the `send` job skips a row that has a
  provider message id and takes an atomic `send_log` claim (`claimSend`: status
  `sending`, stale after `SEND_CLAIM_STALE_MS`, released by its holder if the
  provider throws). The claim stops two live workers from both sending; it does
  not cover an ambiguous outcome (SES accepted but the response or the DB write
  was lost), which can re-send once the claim goes stale — accepted gap.
- **Migrations are append-only**; `accounts.provider` has a CHECK constraint, so a
  new provider is a migration (it still allows `resend`; migration 5 deleted the
  Resend account's rows in Wave 15). Wave 18 added 7 (`send_log` bounce columns +
  `send_events`), 8 (`send_bodies`) and 9 (`ses_account`).
- **Stored mail is redacted, 30-day, never logged** (Wave 18). `send_bodies`
  holds a dispatched send's html + text, written only through
  `src/utils/send-body.ts`'s `storeSendBody` (both `sendMail` and the `send`
  job), fail-open, after the template registry's `redact(props)` secrets
  (`shutterflow-code`'s auth code) became `[redacted]`; a template that names
  secrets is not stored without its props (or when `redact` yields no non-empty
  string). The `prune_send_bodies` job deletes `send_bodies` rows and
  `send_events` older than 30 days (`SEND_BODY_RETENTION_MS`; `send_events` are
  pruned with bodies, 30 days). Never log a body or the
  error of a failed store. `send_events` and the `send_log` bounce columns
  hold no addresses (diagnostic codes are scrubbed in `ses/events.ts`) beyond
  the existing `send_log.recipients`; SNS payloads stay unlogged. No open/click
  tracking and no VDM.
- **No timeouts on agent-style work** (`rules/agent-limits.md`): the LLM calls
  carry a 30-min hang guard, not a budget.
- **The mail surface is host-gated and bearer-first.** `/app` and `/api` sit
  behind `MAIL_HOST` (`src/host-gate.ts`) — no-op while it is unset, 404 on any
  other Host once set; the send routes and `/health` are never gated. The
  browser door is the signed `/app` session cookie, accepted by `/api` only for
  same-origin requests; the bearer contract for agents does not change.
