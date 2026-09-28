# email-gateway

The single door to all of my email: Proton Mail (Bridge), Gmail (IMAP) and Resend behind one API and UI. Direction: [docs/vision.md](docs/vision.md).

## Local Development

To install dependencies (uses the committed `bun.lock`; the `client/` SPA is a
Bun workspace of this package, so one install covers both):

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
bun run typecheck         # tsc --noEmit for the server and the client workspace
bun test                  # run tests
bun run build             # build the client SPA into client/dist
bun run client:dev        # Vite dev server for the client (proxies /api to bun run dev)
bun run format             # prettier --write .
bun run format:check       # prettier --check .
```

This project was created using `bun init` in bun v1.0.7. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Endpoints

- `POST /fpp` — bearer `SECRET_KEY`. Body: `{ name, email, subject, message }`. Sends a contact-form confirmation to the sender and forwards it to `RECEIVER_EMAIL`.
- `POST /fpp-daily-analytics` — bearer `SECRET_KEY`. Body: `{ votes, estimations, rooms, unique_users, page_views }`. Sends a daily analytics summary to `RECEIVER_EMAIL`.
- `POST /sy-serendipity` — bearer `SECRET_KEY`. Body: `{ firstName, lastName, email, numberOfPeople, destination, duration, arrivalDate, departureDate, phone, message }` (all fields except `email` are nullable). Sends a charter-request email to `SY_SERENDIPITY_RECEIVER_EMAIL`; uses `SY_SERENDIPITY_FROM_EMAIL` as the sender when set, otherwise falls back to the default `sendMail` sender.

## Spam filter

Both `/fpp` and `/sy-serendipity` run each submission through an LLM classifier (`src/spam/classify.ts`) before sending any mail. It sorts submissions into `legit`, `spam`, or `marketing` (unsolicited SEO/link-building/web-design/lead-gen/dev-outsourcing pitches), biased towards `legit` when unsure. Submissions classified as `spam`/`marketing` with confidence ≥ `0.7` are silently dropped — no emails are sent, but the caller still gets the normal success response so bots aren't tipped off. Below that threshold, the receiver mail subject is prefixed with `[Possible spam]` instead. Every decision is recorded in `mail.sqlite`'s `submissions` table (`src/db/mail-submissions.ts`) for the admin Spam filter page and `/api/submissions` to review.

The classifier fails open: if `LLM_BASE_URL`, `LLM_API_KEY`, or `LLM_MODEL` is unset, or the LLM call fails, the submission is treated as `legit` and delivered normally.

Neither endpoint waits on the classifier synchronously: `src/spam/gate.ts` races it against an 8s decision deadline, so a slow model never times out the caller (a Netlify function or Cloudflare edge). If the deadline wins, the mail is delivered immediately and the still-running classification is recorded once it lands, with its reason prefixed `Decided after deadline:`.

New env vars:

- `LLM_BASE_URL` — OpenAI-compatible base URL for the classifier model.
- `LLM_API_KEY` — API key for that endpoint.
- `LLM_MODEL` — model id to use. Pick a fast/cheap model — form submitters wait on this call synchronously (bounded only by a 30-minute hang guard, not a tight timeout).

### Jev shadow mode

[Jev](https://typesafe.ai) is a decision model (typed answers with calibrated probabilities, no text generation) run **in shadow mode** next to the LLM: the LLM classifier stays the only authority on drop/deliver. Jev decisions are **durable**, backed by the general `jobs` table (`src/db/jobs.ts`, `docs/architecture.md` §Jobs) rather than a dedicated queue: `src/spam/gate.ts` enqueues a `jev_submission` job after recording a submission when Jev is configured, and `src/jobs/classify.ts`'s handler enqueues a `jev_message` job for every inbound message it classifies. Enqueueing never delays or changes the delivery decision.

`src/jobs/runner.ts` claims and runs both kinds (`src/jobs/jev.ts`) alongside every other job kind — there's no separate Jev worker or poll interval anymore. A job runs, writes its result (`src/db/mail-submissions.ts#saveJevResult` / `src/db/messages.ts#saveClassification`'s `jev*` columns), and completes; a thrown error fails the job onto the shared backoff ladder (1m → 5m → 15m → 1h → 3h → 6h → 12h → 24h, terminal after 9 attempts) — a rate-limited failure (429 / `rate_limit_exceeded` / "high demand") parks on its own, separate ladder instead (`jobs.rate_limits`, 1m → 5m → 15m → capped at 1h, never terminal), without ever spending an attempt. `src/llm/jev.ts` sets `maxRetries: 0` on the `evaluate()` call since the job queue owns retries. A submission or message with no Jev result yet (job still pending, or Jev was disabled when it was recorded) simply has no `jev_*` values set — there is no separate queue-state column to inspect.

`rate_limits` resets to 0 on success or on any non-rate-limit failure — fixed 2026-09-28 (root-caused 40 minutes after the Wave 4 deploy): the original version always rescheduled a rate-limited job on the ladder's first, 1-minute rung regardless of how many times it had already been rate-limited, so a sustained upstream 429 kept every parked job retrying every ~1 minute — replaying roughly its own request volume straight back at the gateway that was returning 429 in the first place (17 `jev_submission` + 2 `jev_message` jobs stuck re-firing at ~14 req/min). The runner also logs a rate-limited outcome as one line (`[jobs] <kind> <id> rate-limited, retry in <n>s (rate_limits=<k>)`) instead of the full error object — a genuine, non-rate-limit failure still gets the full object.

Stored on each `submissions` row: `llm_latency_ms` (classifier latency, for comparison) and `jev_verdict`, `jev_confidence`, `jev_probabilities` (JSON), `jev_latency_ms` (the successful call), `jev_model`, `jev_error`. `/api/submissions` returns them as `jev: { verdict, confidence, probabilities, latencyMs, model, error }` (`null` when nothing has been recorded yet; the verdict fields are `null` until Jev succeeds). The admin Spam filter page shows Jev's verdict next to the LLM's with an agrees/differs marker, or "not yet judged". `getJevComparison` (agreement rate, median latencies) counts only rows with a Jev verdict.

Inbound messages get the same two Jev decisions as before — `spam_probability` (yes/no: unsolicited spam/phishing/cold marketing vs. anything a human wrote to the owner or transactional mail) and a `category` from the same set as the LLM enrichment, with confidence — stored as `jev_*` columns on `classifications` (`src/db/messages.ts`) and returned as part of a message's classification; the LLM fields are untouched, and either side failing never fails the other.

Env vars (all optional):

- `JEV_API_KEY` — Vercel AI Gateway key. Unset disables Jev everywhere, silently.
- `JEV_MODEL` — gateway evaluation model id, default `typesafe-ai/jev`.

Jev is called through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) with the AI SDK's experimental `evaluate` (`src/llm/jev.ts`); no extra dependency. Choice confidence comes from the provider metadata Jev returns (falling back to the chosen option's probability).

## Client

`GET /app` — the React SPA (Vite + React 19 + basalt-ui) served by the same Elysia process from `client/dist` (built by the Dockerfile's client stage, never a dev server). It replaces the retired SSR admin; `/admin` now 302s to `/app`. Pages:

- **Inbox** — messages across every account, sorted by "needs me" first, with an account chip per row and category / priority / unread / action-required filters.
- **Message view** — live read through the provider (`GET /api/messages/:key?include=body`), the HTML body rendered in a sandboxed `<iframe sandbox="">`, the classification panel, and mark read/unread, star, archive, spam and trash via the flag/move endpoints.
- **Submissions** — the spam-filter decisions (`getJevComparison` verdicts beside the LLM's), ported from the old SSR page.
- **Accounts & health** — every configured account plus per-account sync health and the job queue counts.

Auth: `POST /app/login` with `{ password }` checks `ADMIN_PASSWORD` and sets a signed, HttpOnly, `SameSite=Strict` session cookie (Elysia core cookie, signed with `COOKIE_SECRET` or, when unset or shorter than 12 chars, `ADMIN_PASSWORD`); the signed payload carries its own 30-day expiry, validated server-side by both `/app` and `/api`; `POST /app/logout` clears it. The browser's same-origin `/api` calls are accepted through that cookie; agent bearer auth is unchanged. Session mutations require a same-origin request (`Sec-Fetch-Site` / `Origin`), the same check the SSR admin used. `/api` and future `/mcp` stay bearer-first.

`MAIL_HOST` — when set, `/app` and `/api` answer only on that hostname; the send routes and `/health` stay reachable on any Host. Unset in dev and in prod until Wave 9 sets it, so today it is a no-op. A mismatching Host 404s the mail surface.

Client build:

```bash
bun run build           # cd client && vite build  -> client/dist
bun run client:dev      # Vite dev server on 5173, proxying /api and the /app session routes
```

- `COOKIE_SECRET` — optional signing secret for the session cookie. Defaults to `ADMIN_PASSWORD` when unset or shorter than 12 chars.
- `MAIL_HOST` — optional; the only hostname allowed to serve `/app` and `/api`.

`bun run seed:demo` (refuses to run with `NODE_ENV=production`) seeds `$DATA_DIR`'s old `email-gateway.sqlite` with fake spam-filter submissions for exploring the Submissions page locally. `bun run import-legacy` (`scripts/import-legacy.ts`) is the one-shot legacy import — see §Storage below.

## Storage

Two SQLite databases, both opened with `bun:sqlite`, live side by side in `$DATA_DIR` (D4, `docs/architecture.md` §Decisions — the lean-store cutover never migrated the old file, it built a fresh one and left the old one for the owner to delete):

- `${DATA_DIR}/mail.sqlite` — the live store (`src/db/mail-client.ts`, migrations in `src/db/mail-migrations.ts`, tracked via its own `PRAGMA user_version`, independent of the counter below). Tables (full shapes: `docs/architecture.md` §Lean store):
  - `accounts` — one row per configured provider account: address, per-mailbox sync cursors (JSON), last success/error/warning.
  - `messages` + `message_locations` — envelope-only per message (`direction`, addresses, subject, thread key, flags snapshot) plus every mailbox it's currently seen in (provider ref, last seen). Bodies are never stored here — only a cache.
  - `classifications` — LLM category/priority/summary/facts **and** the Jev shadow columns (`jev_*`), one row per message, filled in by the `classify`/`jev_message` jobs.
  - `body_cache` — `html`/`text` keyed by message, filled on a live read or a `body_prefetch` job; bounded and evicted LRU by `fetched_at` — the reading view's cache, never the source of truth.
  - `send_log` — one row per outbound send (template id, recipients, provider id, status/last event, requested by).
  - `submissions` — one row per contact-form submission judged by the spam filter, including the Jev shadow columns.
  - `templates` — registered template id, name, preview props, last test-send.
  - `messages_fts` — FTS5 over subject/addresses/summary only, **not** bodies (body search goes live through the provider instead).
  - `jobs` — see below; owned by `src/db/jobs.ts`, not by the migrations file.
- `${DATA_DIR}/email-gateway.sqlite` — the old store (`src/db/migrations.ts`), kept only for `src/db/submissions.ts`'s one remaining legitimate caller, `scripts/import-legacy.ts` (below). Nothing else reads or writes it; it is never deleted by code.

New env var:

- `DATA_DIR` — directory for both SQLite files. Defaults to `./data`. In the Docker image this is `/data`, which `docker-compose` mounts as a volume.

### One-shot legacy import

`bun run import-legacy` (`scripts/import-legacy.ts`) copies every row of the old store's `submissions` table into the new one, preserving the original `id` and `received_at` exactly (D4: `submissions` is the one table that can't be rebuilt from the providers — the Resend send log rebuilds from Resend history on first sync instead). It reads the old file through `src/db/submissions.ts`'s repo, paginating every page; writes with `INSERT OR IGNORE` on `id`, so running it again is a safe no-op for rows already imported; and never modifies or deletes the old file. Not run automatically — invoke it once, explicitly, during the cutover: `bun run scripts/import-legacy.ts [oldPath] [newPath]` (defaults to `$DATA_DIR/email-gateway.sqlite` and `$DATA_DIR/mail.sqlite`).

## Jobs

Everything asynchronous — sync, classification, Jev, sends — is a row in `mail.sqlite`'s `jobs` table (`src/db/jobs.ts`, `docs/architecture.md` §Jobs): atomic single-row claim with a token, `complete`/`fail` guarded by that token, backoff 1m → 5m → 15m → 1h → 3h → 6h → 12h → 24h, terminal `failed` after nine attempts, stale claims (35 min) taken over so RollHook's two-container deploy overlap never double-runs a row. `src/jobs/runner.ts` polls every 10s (`src/jobs/register.ts`) and dispatches by `kind`:

| Kind             | Handler                   | Enqueued by                                                                         |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `sync_tick`      | `src/sync/composition.ts` | A 5-minute schedule, IMAP IDLE (debounced), `POST /admin/sync` and `POST /api/sync` |
| `classify`       | `src/jobs/classify.ts`    | `sync_tick`, for every newly-ingested message                                       |
| `jev_message`    | `src/jobs/jev.ts`         | `classify`, for inbound messages once Jev is configured                             |
| `jev_submission` | `src/jobs/jev.ts`         | `src/spam/gate.ts`, after recording a submission, once Jev is configured            |
| `send`           | `src/jobs/send.ts`        | A send route, only on provider failure (the first attempt runs inline)              |

A `sync_tick` runs one envelope-only ingest pass per configured provider/mailbox through the `MailProvider` port (`src/sync/ingest.ts`): a "head" pass always re-lists the newest page (so new mail at the top is never missed) plus a bounded backfill pass that pages backward once, historically. It never fetches a body — `classify` does that live via `provider.read()`, and only `classify`'s LLM call and Jev populate `classifications`. IMAP watch (`provider.watch()`/IDLE) kicks a tick as soon as the server reports a change, on top of the 5-minute schedule.

## IMAP

`src/providers/imap/` is the Proton (via Bridge) and Gmail adapter behind the `MailProvider` port (`src/providers/port.ts`): `capabilities()` (declared from what the server actually advertises, per account), `listMailboxes()`, `list()`/`read()` (newest-first), `search()`, `setFlags()`/`move()` (open the mailbox with `SELECT`, not `EXAMINE`, since a write needs it), `watch()` (IDLE). `src/sync/ingest.ts` only ever calls `list()`/`read()` for a `sync_tick` — flags/moves are exposed through `/api/messages/:key/flags` and `/move` instead.

Capabilities are detected per connection, never assumed from the provider id. On Gmail (`X-GM-EXT-1`) every listed envelope also carries its `X-GM-THRID` as the generic `threadKey`, and a folder's special-use attribute (`\All`, `\Junk`, `\Trash`, …) maps Archive/Spam/Trash through `listMailboxes()` — folder paths are localized, so special-use is the portable signal and `[Gmail]/…` names are never hardcoded. When the server advertises `CONDSTORE`, the head sync pass uses a `changedSince` fast path bookmarked per mailbox (seed on the first full scan, process-local); every server without it — Bridge — keeps the byte-identical UID-window scan. Gmail labels themselves are not captured yet: there is no `labels` field in the schema, so a folder/special-use move is the in-scope label operation (documented gap).

Env vars (all optional; unset `IMAP_HOST` → Proton ingest is off; unset `GMAIL_IMAP_USER` → Gmail ingest is off):

- `IMAP_HOST`, `IMAP_PORT` (default `1143`), `IMAP_USER`, `IMAP_PASSWORD` — Bridge's per-address credentials. A host without user/password fails fast at startup.
- `IMAP_MAILBOXES` — comma-separated, default `INBOX,Spam`. Syncing Proton's Spam folder lets you compare its filter against our classifier.
- `IMAP_TLS_CERT` — PEM of Bridge's self-signed certificate (`\n`-escaped newlines are accepted, so it fits a one-line secret). The cert is the sole trust anchor **and** the presented certificate's SHA-256 fingerprint must equal the pinned one, so a CA certificate configured by mistake can't vouch for anything else. Hostname matching is skipped: Bridge issues for localhost while we connect over the tailnet.
- `IMAP_TLS_INSECURE=true` — accept any certificate (one warning at startup). Only acceptable because the path is WireGuard (Tailscale); prefer `IMAP_TLS_CERT`. Ignored when a cert is set.
- `GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD` — the Gmail address and a 16-character app password (2-Step Verification required). A user without a password (or vice versa) fails fast at startup. Two named vars rather than a `MAIL_ACCOUNTS` JSON blob: they match the `IMAP_*` naming and keep the 1Password template one line per secret.
- `GMAIL_IMAP_MAILBOXES` — comma-separated, default `INBOX`. INBOX only by default because Gmail's other folder paths are localized; add folders by their exact `LIST` path.

The Proton connection is `STARTTLS` (login is refused if the upgrade fails); Gmail is implicit TLS to `imap.gmail.com:993` with the system trust store. Both have plain network timeouts (30 s connect, 15 s greeting, 60 s socket inactivity), after which the client is closed, so a stalled server fails the tick instead of holding the job's claim.

`GET /health` stays a plain `{ "ok": true }` liveness check (unauthenticated, on the public tunnel, watched by Uptime Kuma) — it never lists real mail addresses. `GET /api/accounts` (bearer, see §Agent API) lists every configured account (`id`, `provider`, `address`) without connecting to any of them, for both env-configured-but-never-synced accounts and ones already in the store.

A CONDSTORE server (Gmail) bookmarks its mailbox's modseq per `mailbox:UIDVALIDITY` pair, process-local — a mailbox recreation (a new UIDVALIDITY, e.g. a Gmail label rebuild) looks like a fresh mailbox instead of reusing a bookmark the server's reset counter would otherwise answer "nothing changed" to.

## Enrichment

Every newly-ingested message is enriched once by the LLM (`src/enrich/`, run from the `classify` job): `category`, `priority`, `actionRequired`, a short `summary`, a `suggestedAction`, `language`, and up to 8 extracted `facts`. The job fetches the body live via the provider (never from the store), enriches it, then saves the classification and, for inbound messages once Jev is configured, enqueues `jev_message`. Enrichment reuses the same LLM configuration as the spam classifier (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, see above) and fails the same way: the job no-ops if the LLM isn't configured, and a thrown error retries on the job's own backoff ladder (see §Jobs) rather than a dedicated attempts column.

`LLM_*` env vars are read once at process start — changing them requires a restart to take effect.

## API

`GET`/`POST /api/*` — bearer-authenticated JSON API, now backed by the lean `mail.sqlite` tables (`src/db/messages.ts`, `src/db/mail-submissions.ts`, `src/db/accounts.ts`, `src/db/jobs.ts`) instead of the old `emails`/`submissions`/`imap_sync_state` store. Unset `API_KEY` → every `/api/*` route 404s; a wrong/missing bearer token → `401 { "error": "unauthorized" }`.

| Method & path                   | Query / body                                                                                                                                                            | Notes                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/accounts`             | —                                                                                                                                                                       | Every account the env configures (`id`, `provider`, `address`), without connecting to any of them — includes an account that has never synced yet, unlike `/api/stats`'s `accounts`.  |
| `GET /api/messages`             | `account` (comma-separated account ids), `direction`, `category`, `needs_me`/`action_required` (`1` or `true`), `since`, `until`, `limit` (1-100, default 25), `cursor` | Keyset-paginated, newest first, from `messages`/`classifications`. `needs_me=1` is sugar for `action_required=true`.                                                                  |
| `GET /api/messages/:key`        | `include=body`                                                                                                                                                          | Envelope + locations + classification; body (`html`/`text`, may be `null` if never cached) only when `include=body` is passed. `404` if unknown. Never triggers a live provider read. |
| `GET /api/threads/:key`         | —                                                                                                                                                                       | Every message sharing the key's `threadKey`, newest first; a message with no `threadKey` returns just itself. `404` if the message itself is unknown.                                 |
| `GET /api/search`               | `q`, `account`, `limit`                                                                                                                                                 | FTS5 over subject/addresses/summary (not bodies) — `{ via: "fts", keys: [...summaries] }`.                                                                                            |
| `POST /api/messages/:key/flags` | body `{ mailbox, add?, remove?, set? }`                                                                                                                                 | Resolves the message's location in `mailbox`, then the account's provider; `501` if the provider's capabilities report `flag: false`.                                                 |
| `POST /api/messages/:key/move`  | body `{ mailbox, toMailbox }`                                                                                                                                           | `501` if `move: false`; on success the new location is recorded, the old mailbox's row is left for the next sync tick to supersede.                                                   |
| `GET /api/submissions`          | `verdict`, `source`, `delivered`, `limit`, `cursor`                                                                                                                     | Same keyset pagination as before, now over the new `submissions` table (no `jev_status`/`jev_attempts` — that state lives on jobs).                                                   |
| `GET /api/stats`                | `since` (default: 30 days ago)                                                                                                                                          | `messages` (total/inbound/outbound + category breakdown), `jevComparison`, `jobs` (`{ pending, failed }` across **every** kind, not Jev-specific), `accounts` (per-account health).   |
| `POST /api/sync`                | —                                                                                                                                                                       | Enqueues a `sync_tick` job and returns `{ enqueued: true }` immediately — sync is async now, so there is no result to wait for and no `409 busy`.                                     |
| `GET /api/jobs/:id`             | —                                                                                                                                                                       | One job's status/attempts/error. `404` if unknown.                                                                                                                                    |
| `GET /api/emails`               | `direction`, `category`, `needs_me`/`action_required`, `since`, `until`, `limit`, `cursor`, `status` (accepted, has no effect — retired, see below)                     | Legacy alias over `GET /api/messages`, reshaped into the old field names (`id`, `fromAddress`, `toAddresses`, `createdAt`, `enrichment`).                                             |
| `GET /api/emails/:id`           | `include=html`                                                                                                                                                          | Legacy alias over `GET /api/messages/:key`; `html`/`text` come from the cache only (`null` if never fetched) — this alias never triggers a live read.                                 |
| `POST /api/emails/:id/enrich`   | —                                                                                                                                                                       | Legacy alias: enqueues a `classify` job and returns `{ enqueued: true }` (previously waited for the result synchronously).                                                            |

The old `status` filter (pending/done/failed) had no equivalent once the enrichment queue moved onto `jobs` — passing it is accepted for compatibility but silently ignored.

```bash
curl -H "Authorization: Bearer $API_KEY" "https://<host>/api/messages?needs_me=1&limit=10"
```

New env var:

- `API_KEY` — bearer key for `/api/*`, min 16 chars. Unset → the whole `/api/*` prefix 404s.
