# email-gateway

The single door to all of my email: Proton Mail (Bridge), Resend and later Gmail behind one API and UI. Direction: [docs/vision.md](docs/vision.md).

## Local Development

To install dependencies (uses the committed `bun.lock`):

```bash
bun install --frozen-lockfile
```

To run:

```bash
bun run start
```

Other scripts:

```bash
bun run dev              # watch mode
bun run email             # preview email templates (src/emails)
bun run typecheck         # tsc --noEmit
bun test                  # run tests
bun run format             # prettier --write .
bun run format:check       # prettier --check .
```

This project was created using `bun init` in bun v1.0.7. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Endpoints

- `POST /fpp` — bearer `SECRET_KEY`. Body: `{ name, email, subject, message }`. Sends a contact-form confirmation to the sender and forwards it to `RECEIVER_EMAIL`.
- `POST /fpp-daily-analytics` — bearer `SECRET_KEY`. Body: `{ votes, estimations, rooms, unique_users, page_views }`. Sends a daily analytics summary to `RECEIVER_EMAIL`.
- `POST /sy-serendipity` — bearer `SECRET_KEY`. Body: `{ firstName, lastName, email, numberOfPeople, destination, duration, arrivalDate, departureDate, phone, message }` (all fields except `email` are nullable). Sends a charter-request email to `SY_SERENDIPITY_RECEIVER_EMAIL`; uses `SY_SERENDIPITY_FROM_EMAIL` as the sender when set, otherwise falls back to the default `sendMail` sender.

## Spam filter

Both `/fpp` and `/sy-serendipity` run each submission through an LLM classifier (`src/spam/classify.ts`) before sending any mail. It sorts submissions into `legit`, `spam`, or `marketing` (unsolicited SEO/link-building/web-design/lead-gen/dev-outsourcing pitches), biased towards `legit` when unsure. Submissions classified as `spam`/`marketing` with confidence ≥ `0.7` are silently dropped — no emails are sent, but the caller still gets the normal success response so bots aren't tipped off. Below that threshold, the receiver mail subject is prefixed with `[Possible spam]` instead. Every decision is recorded in SQLite (`src/db/submissions.ts`) for the admin UI and `/api/submissions` to review.

The classifier fails open: if `LLM_BASE_URL`, `LLM_API_KEY`, or `LLM_MODEL` is unset, or the LLM call fails, the submission is treated as `legit` and delivered normally.

Neither endpoint waits on the classifier synchronously: `src/spam/gate.ts` races it against an 8s decision deadline, so a slow model never times out the caller (a Netlify function or Cloudflare edge). If the deadline wins, the mail is delivered immediately and the still-running classification is recorded once it lands, with its reason prefixed `Decided after deadline:` for the admin Filtered page.

New env vars:

- `LLM_BASE_URL` — OpenAI-compatible base URL for the classifier model.
- `LLM_API_KEY` — API key for that endpoint.
- `LLM_MODEL` — model id to use. Pick a fast/cheap model — form submitters wait on this call synchronously (bounded only by a 30-minute hang guard, not a tight timeout).

### Jev shadow mode

[Jev](https://typesafe.ai) is a decision model (typed answers with calibrated probabilities, no text generation) run **in shadow mode** next to the LLM: the LLM classifier stays the only authority on drop/deliver. Jev decisions are **durable**: nothing is held in memory. When Jev is configured, `src/spam/gate.ts` records each submission with `jev_status = 'pending'`, and every inbound email (`direction = inbound`, regardless of provider) gets `jev_status = 'pending'` on its `email_enrichments` row when that row is created (sync) or reset (`POST /api/emails/:id/enrich`, admin re-enrich) — independent of whether the LLM is configured. Outbound emails stay `NULL` (not judged). Enqueueing kicks the worker; it never delays or changes the delivery decision.

The worker (`src/jev/worker.ts`) runs every 60s and on demand after an enqueue. It atomically claims up to 10 due rows per table (`pending`, `jev_next_attempt_at` unset or past, `jev_claimed_at` unset or older than 35 min — longer than the 30-min hang guard, so two RollHook containers on one SQLite file never double-run a row) and judges them sequentially (`src/spam/jev-judge.ts`: one `choice` question over `legit`/`spam`/`marketing` with the classifier's criteria plus both site descriptions; `src/enrich/jev-email.ts` for emails). States (`jev_status`):

| State     | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `NULL`    | Not applicable: outbound email, or Jev was disabled when the submission was recorded |
| `pending` | Queued or waiting for a retry (`jev_next_attempt_at`)                                |
| `done`    | Decision stored                                                                      |
| `failed`  | Gave up after 8 failed attempts (last error kept in `jev_error`)                     |

A failed call (e.g. the gateway's upstream 429 "high demand") increments `jev_attempts`, stores the error and reschedules with backoff 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h; the 9th failure is terminal. The AI SDK's default retries still apply inside one call. If Jev is not configured the worker does nothing and rows simply stay `pending` (never `failed`), so setting `JEV_API_KEY` later drains them. Migration 6 queued every existing row without a successful Jev result (submissions carry their raw payload, so they can be judged now).

Stored on each `submissions` row: `llm_latency_ms` (classifier latency, for comparison) and `jev_status`, `jev_attempts`, `jev_next_attempt_at`, `jev_claimed_at`, `jev_verdict`, `jev_confidence`, `jev_probabilities` (JSON), `jev_latency_ms` (the successful call), `jev_model`, `jev_error`. `/api/submissions` returns them as `jev: { status, attempts, nextAttemptAt, verdict, confidence, probabilities, latencyMs, model, error }` (`null` when Jev was disabled at record time; the verdict fields are `null` until `done`). The admin Spam filter page shows Jev's verdict next to the LLM's with an agrees/differs marker, or `pending` (with the next attempt time) / `failed after N attempts: <error>`. Agreement rate and median latencies (`jevComparison` in `/api/stats`, Overview tile) count only `done` rows; `jevQueue: { pending, failed }` in `/api/stats` (Overview "Jev queue" tile) counts the whole queue.

Inbound emails get two Jev decisions in one request: a `spam_probability` (yes/no question: unsolicited spam/phishing/cold marketing vs. anything a human wrote to the owner or transactional mail) and a `category` from the same set as the LLM enrichment, with confidence. Stored as separate `jev_*` columns on `email_enrichments` (`jev_spam_probability`, `jev_category`, `jev_category_confidence`, `jev_latency_ms`, `jev_model`, `jev_error`, plus the same queue columns) and returned as `enrichment.jev` (same status/attempts/nextAttemptAt shape, `null` for outbound) by `/api/emails` and `/api/emails/:id`; the LLM fields are untouched, and either side failing never fails the other.

Env vars (all optional):

- `JEV_API_KEY` — Vercel AI Gateway key. Unset disables Jev everywhere, silently.
- `JEV_MODEL` — gateway evaluation model id, default `typesafe-ai/jev`.

Jev is called through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) with the AI SDK's experimental `evaluate` (`src/llm/jev.ts`); no extra dependency. Choice confidence comes from the provider metadata Jev returns (falling back to the chosen option's probability).

## Admin UI

`GET /admin` — a server-rendered, zero-JS dashboard behind HTTP Basic auth (user `admin`), styled with `basalt-ui` tokens (automatic light/dark via `prefers-color-scheme`). Pages: Overview (stats, 14-day activity chart, category breakdown, needs-action and recently-blocked panels), Inbox (filterable/searchable list of every stored email, keyset-paginated), an email detail page (meta, AI enrichment, HTML/text content, a "Re-run AI" action), Spam filter (every judged submission), and Templates (previews of the registered email templates). All filtering happens through GET query params; the two POST actions (`Sync now`, `Re-run AI`) are guarded by a same-origin check. Dates are formatted in German (`Europe/Berlin`).

- `ADMIN_PASSWORD` — Basic auth password, min 12 chars. Unset → every `/admin` route returns 404.
- `bun run seed:demo` (refuses to run with `NODE_ENV=production`) seeds `$DATA_DIR` with realistic fake emails and submissions for exploring the dashboard locally.

## Storage

Every email (sent and received via Resend, plus the human inbox via IMAP) and every contact-form submission is persisted in a SQLite database opened with `bun:sqlite` (`src/db/`), at `${DATA_DIR}/email-gateway.sqlite`. Migrations (`src/db/migrations.ts`) run automatically on first use, tracked via `PRAGMA user_version`.

Tables:

- `emails` — one row per email (`direction`, addresses, subject, `html`/`text`, `attachments`, `source` — our own template/route id for outbound mail, e.g. `fpp-sender` — and Resend's `last_event`). `provider` (`resend` | `imap`), `mailbox` and `message_id` (RFC Message-ID) record where a row came from; IMAP rows are always `inbound`.
- `imap_sync_state` — per-mailbox IMAP cursor (`uid_validity`, `last_uid`).
- `email_enrichments` — one row per email, filled in by the LLM enrichment worker (see below).
- `submissions` — one row per contact-form submission judged by the spam filter (replaces the old in-memory store).
- `emails_fts` — an FTS5 index over subject/addresses/text/summary, kept in sync by the `emails`/`email_enrichments` repository code and used by `/api/emails?q=`.

New env var:

- `DATA_DIR` — directory for the SQLite file. Defaults to `./data`. In the Docker image this is `/data`, which `docker-compose` mounts as a volume.

## Sync

`src/sync/resend-sync.ts` pulls the full history of sent and received emails from Resend into SQLite: on an empty database this is a one-time backfill, and every run after that only fetches emails newer than what's already stored (it stops paging as soon as it sees a known id). A background scheduler runs it once ~5s after boot and then every 5 minutes; `POST /api/sync` (and the admin UI's "Sync now" button) triggers a run on demand (409 if one is already in progress). `sendMail()` also writes a minimal row immediately after a successful send, which the next sync fills in with `html`/`text`/`last_event`.

Sync self-heals after a partial failure: a `sync_state` table (per direction) only marks a run complete when it drained without errors, so the next run only trusts the "known id → stop" shortcut after a clean run — otherwise it pages through the full history again rather than permanently skipping older emails.

- `RESEND_ADMIN_API_KEY` — optional full-access Resend key used for sync. Without it, sync falls back to the sending-only `RESEND_API_KEY`, and Received emails additionally need inbound receiving enabled on the domain.

## IMAP ingest

`src/sync/imap-sync.ts` pulls the human inbox (e.g. `hello@` on Proton Mail via Proton Mail Bridge, which is the only way into Proton) into the same `emails` table, so it gets the same enrichment and is served by the same `/api`. `src/sync/index.ts` is the composition root: one lock and one 5-minute schedule for both Resend and IMAP, shared by `POST /api/sync` and the admin "Sync now" button (409 while a run is in progress). Each source fails in isolation — a Resend outage doesn't block IMAP and vice versa — and the enrichment worker is kicked after any new rows.

Env vars (all optional; unset `IMAP_HOST` → IMAP ingest is off):

- `IMAP_HOST`, `IMAP_PORT` (default `1143`), `IMAP_USER`, `IMAP_PASSWORD` — Bridge's per-address credentials. A host without user/password fails fast at startup.
- `IMAP_MAILBOXES` — comma-separated, default `INBOX,Spam`. Syncing Proton's Spam folder lets you compare its filter against our classifier; filter with `?mailbox=Spam` (case-insensitive).
- `IMAP_TLS_CERT` — PEM of Bridge's self-signed certificate (`\n`-escaped newlines are accepted, so it fits a one-line secret). The cert is the sole trust anchor **and** the presented certificate's SHA-256 fingerprint must equal the pinned one, so a CA certificate configured by mistake can't vouch for anything else. Hostname matching is skipped: Bridge issues for localhost while we connect over the tailnet.
- `IMAP_TLS_INSECURE=true` — accept any certificate (one warning at startup). Only acceptable because the path is WireGuard (Tailscale); prefer `IMAP_TLS_CERT`. Ignored when a cert is set.

The connection is `STARTTLS` (login is refused if the upgrade fails) and has plain network timeouts (30 s connect, 15 s greeting, 60 s socket inactivity), after which the client is closed, so a stalled Bridge fails the tick instead of holding the sync lock.

**Read-only guarantee.** The IMAP port (`src/sync/imap-port.ts`) exposes only list and fetch — there is no code path that sets a flag, moves, copies or deletes. Mailboxes are opened read-only (`EXAMINE`) and every fetch uses `BODY.PEEK`, so `\Seen` is never touched. The adapter's tests run against a fake client that only implements `getMailboxLock`, `fetchAll` and `fetchOne`.

**Cursor semantics.** Per mailbox, `imap_sync_state` stores the `UIDVALIDITY` and the highest UID stored. Each run lists (a bounded UID window at a time) the UIDs above the cursor, at most 500 per mailbox per run, so a first-time backfill spreads over several ticks. Messages are fetched in batches (≤ 50 messages / 10 MB) and each batch's rows plus the cursor are written in one SQLite transaction, so a failure leaves the cursor at the last clean batch and the next tick retries from there. Nothing is skipped silently: a uid the server still has but did not return holds the cursor before it (and is retried); only a uid confirmed gone is skipped, and that is reported in the sync `errors`. If `UIDVALIDITY` changes the mailbox is rescanned from UID 1; row ids derive from the Message-ID (per mailbox) or, without one, from size + arrival time + a hash of the raw message — never the UID — so the rescan doesn't duplicate rows.

**Storage rules.** IMAP rows are insert-only: an existing id is never overwritten, so a sender-controlled Message-ID can't replace a stored email. Messages over 5 MB (or without a reported size) are stored headers-only; attachments are metadata only (filename, type, size). A message that can't be parsed or stored becomes a metadata-only row and is reported in `errors` instead of wedging the cursor.

**Health.** `imap_sync_state` also records `last_success_at` / `last_error` per mailbox. They appear as `imap` in `GET /api/stats` and as an "IMAP ingest" tile on the admin overview, so a dead Bridge is visible.

## Enrichment

Every email is enriched once by the LLM (`src/enrich/`): `category`, `priority`, `actionRequired`, a short `summary`, a `suggestedAction`, `language`, and up to 8 extracted `facts`. A background worker (`src/enrich/worker.ts`) claims up to 10 pending/retryable rows every 30s and enriches them sequentially; it's also kicked immediately after a sync that added new rows. Enrichment reuses the same LLM configuration as the spam classifier (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, see above) and fails the same way: rows stay `pending` if the LLM isn't configured, and a failed attempt is retried up to 3 times before being left `failed`.

`LLM_*` env vars are read once at process start — changing them requires a restart to take effect.

## API

`GET`/`POST /api/*` — bearer-authenticated JSON API over the stored emails and submissions. Unset `API_KEY` → every `/api/*` route 404s; a wrong/missing bearer token → `401 { "error": "unauthorized" }`.

| Method & path                 | Query params                                                                                                                                                                                           | Notes                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/emails`             | `direction`, `category` (comma-separated), `source`, `provider` (`resend`\|`imap`), `mailbox`, `from`, `to`, `q`, `since`, `until`, `action_required`, `status`, `limit` (1-100, default 25), `cursor` | Keyset-paginated, newest first. List items omit `html`/`text` in favor of a 240-char `snippet`.                                                     |
| `GET /api/emails/:id`         | `include=html`                                                                                                                                                                                         | Full email including `text`; `html` only when `include=html` is passed. `404` if unknown.                                                           |
| `POST /api/emails/:id/enrich` | —                                                                                                                                                                                                      | Resets and re-runs enrichment for one email, waits for the result, and returns it.                                                                  |
| `GET /api/stats`              | `since` (default: 30 days ago)                                                                                                                                                                         | Totals by direction, counts by category, open action-required count, a 14-day per-day chart (Europe/Berlin days), and submission counts by verdict. |
| `GET /api/submissions`        | `verdict`, `source`, `delivered`, `limit`, `cursor`                                                                                                                                                    | Same keyset pagination as `/api/emails`.                                                                                                            |
| `POST /api/sync`              | —                                                                                                                                                                                                      | Runs a Resend + IMAP sync now; `409` if one is already running.                                                                                     |

```bash
curl -H "Authorization: Bearer $API_KEY" "https://<host>/api/emails?direction=inbound&limit=10"
```

New env var:

- `API_KEY` — bearer key for `/api/*`, min 16 chars. Unset → the whole `/api/*` prefix 404s.
