# email-gateway

The single door to all of my email: Proton Mail (Bridge) and Gmail (IMAP) behind one API and UI, with Amazon SES sending the apps' mail. Direction: [docs/vision.md](docs/vision.md).

## Local Development

To install dependencies (uses the committed `bun.lock`; the `client/` SPA is a
Bun workspace of this package, so one install covers both):

```bash
bun install --frozen-lockfile
```

Secrets are resolved from 1Password via `secrets-run` (the `.env.tpl` at the
repo root — a plain KEY=op://ref list, same vault the VPS deploy reads since
this is a solo project with no separate dev secret set). Proton IMAP ingest
stays disabled locally: the tailnet ACL only grants the VPS reaching Bridge,
not the mini — see `.env.tpl`'s comment and `AGENTS.md`.

To run:

```bash
bun run start
# or
make dev
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

`make check` runs format:check + typecheck + test in one shot; `make help`
lists every target.

This project was created using `bun init` in bun v1.0.7. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Endpoints

- `POST /fpp` — bearer `SECRET_KEY`. Body: `{ name, email, subject, message }`. Sends a contact-form confirmation to the sender and forwards it to `RECEIVER_EMAIL`.
- `POST /fpp-daily-analytics` — bearer `SECRET_KEY`. Body: `{ votes, estimations, rooms, unique_users, page_views }`. Sends a daily analytics summary to `RECEIVER_EMAIL`.
- `POST /sy-serendipity` — bearer `SECRET_KEY`. Body: `{ firstName, lastName, email, numberOfPeople, destination, duration, arrivalDate, departureDate, phone, message }` (all fields except `email` are nullable). Sends a charter-request email to `SY_SERENDIPITY_RECEIVER_EMAIL`; uses `SY_SERENDIPITY_FROM_EMAIL` as the sender when set, otherwise falls back to the default `sendMail` sender. After the receiver mail, the requester gets a confirmation at `body.email` (template `sy-serendipity-confirmation`, same sender); it is fail-open (a rejected send is logged, the route still returns 2xx) and is never sent for a held spam submission.
- `POST /jkrumm-contact` — **public, no bearer** (the personal site is static and cannot hold `SECRET_KEY`). Body: `{ name: string|null (≤200), email, message (1–5000), website? }` → `200 { "message" }`, `422` on validation, `403` when `Origin` is not in `JKRUMM_CONTACT_ORIGINS` (unset → 404). The `OPTIONS` preflight answers allowed origins only (`POST`, `Content-Type`). A non-empty `website` is the honeypot: `200`, nothing sent or recorded. Otherwise the submission runs the spam gate (source `jkrumm-contact`) and sends one mail to `JKRUMM_CONTACT_RECEIVER_EMAIL` (falls back to `RECEIVER_EMAIL`) with `replyTo` the visitor (sender `JKRUMM_CONTACT_FROM_EMAIL` when set); no visitor confirmation. `Origin` is browser-enforced, not a secret — it blocks other sites, not curl; the gate and Traefik's rate limit cover the rest. Not behind `MAIL_HOST`.
- `POST /shutterflow` — Shutterflow's auth-code mails. Own bearer `SHUTTERFLOW_SECRET_KEY` (unset → 404; `SECRET_KEY` does not open it). Body: `{ kind: "sign-in"|"email-verification"|"forget-password", to: email, code: 4–16 alphanumerics, expiresInMinutes: 1–1440 }` → `200 { "message" }`, `401` bad bearer, `422` validation, `502` when the provider fails (so the caller can offer a retry). No spam gate (a user is waiting for the code); the send is synchronous, template `shutterflow-code`, sender `SHUTTERFLOW_FROM_EMAIL`. The code is never logged (the subject leads with it and is redacted), never lands in `send_log`, and is replaced by `[redacted]` in the stored copy of the mail (§Amazon SES, stored mail). Not behind `MAIL_HOST`.
- `POST /athena` — Athena's sign-in code mails (team chat; IU staff only). Own bearer `ATHENA_SECRET_KEY` (unset → 404; `SECRET_KEY` does not open it). Body: `{ kind: "sign-in", to: one address ending in @iu.org, code: exactly 6 digits, expiresInMinutes: 1–15 }` → `200 { "message" }`, `401` bad bearer, `422` validation (any other recipient domain, a list of recipients, a malformed code), `502` when the provider fails (so the caller can offer a retry). No spam gate; the send is synchronous, template `athena-code`, subject `Your Athena code: 482 915`, sender `ATHENA_FROM_EMAIL`, Reply-To `ATHENA_REPLY_TO`. No link, no data in the mail. The code is never logged (the subject is redacted), never lands in `send_log`, and both spellings of it (`482915`, `482 915`) are `[redacted]` in the stored copy. No in-app rate limit: the Traefik middleware is the limiter, and the caller caps its own volume. Not behind `MAIL_HOST`.
- `GET /sy-serendipity/requests` — bearer `SY_SERENDIPITY_READ_KEY` (read-only; `SECRET_KEY` and `API_KEY` are rejected). Query: `since` (ISO timestamp, inclusive), `limit` (1–200, default 100). Returns `{ requests, total }`: every `sy-serendipity` submission in the window, all verdicts (`legit`/`spam`/`marketing`) with `delivered`, newest first, form fields only — no classifier reason/confidence/model or `jev_*`. `total` counts the window before `limit`. Unset key → 404; wrong/missing token → `401 { "message": "Unauthorized" }`. Not behind `MAIL_HOST`. Feeds the SY Serendipity admin panel (Netlify Function).
- `POST /webhooks/ses` — public, authenticated only by the Amazon SNS message signature (see §Amazon SES). The delivery-event door for the `ses` send provider. Unset `SES_SNS_TOPIC_ARN` → 404. Not behind `MAIL_HOST`.

## Spam filter

`/fpp`, `/sy-serendipity` and `/jkrumm-contact` run each submission through an LLM classifier (`src/spam/classify.ts`) before sending any mail. It sorts submissions into `legit`, `spam`, or `marketing` (unsolicited SEO/link-building/web-design/lead-gen/dev-outsourcing pitches), biased towards `legit` when unsure. Submissions classified as `spam`/`marketing` with confidence ≥ `0.7` are silently dropped — no emails are sent, but the caller still gets the normal success response so bots aren't tipped off. Below that threshold, the receiver mail subject is prefixed with `[Possible spam]` instead. Every decision is recorded in `mail.sqlite`'s `submissions` table (`src/db/mail-submissions.ts`) for the admin Spam filter page and `/api/submissions` to review.

The classifier fails open: if `LLM_BASE_URL`, `LLM_API_KEY`, or `LLM_MODEL` is unset, or the LLM call fails, the submission is treated as `legit` and delivered normally.

Neither endpoint waits on the classifier synchronously: `src/spam/gate.ts` races it against an 8s decision deadline, so a slow model never times out the caller (a Netlify function or Cloudflare edge). If the deadline wins, the mail is delivered immediately and the still-running classification is recorded once it lands, with its reason prefixed `Decided after deadline:`.

New env vars:

- `LLM_BASE_URL` — OpenAI-compatible base URL for the classifier model.
- `LLM_API_KEY` — API key for that endpoint.
- `LLM_MODEL` — model id to use. Pick a fast/cheap model — form submitters wait on this call synchronously (bounded only by a 30-minute hang guard, not a tight timeout).

### Jev shadow mode

The shadow decision lane — "Jev" is its historical name (job kinds, `jev_*` columns and function names keep it); the default model is `pplx-decider-v1-27b` on IU's native decision API (`systemone`; OpenRouter's Decisions API via `DECISION_PROVIDER=openrouter`) — is a decision model (typed answers with calibrated probabilities, no text generation) run **in shadow mode** next to the LLM: the LLM classifier stays the only authority on drop/deliver. Jev decisions are **durable**, backed by the general `jobs` table (`src/db/jobs.ts`, `docs/architecture.md` §Jobs) rather than a dedicated queue: `src/spam/gate.ts` enqueues a `jev_submission` job after recording a submission when Jev is configured, and `src/jobs/classify.ts`'s handler enqueues a `jev_message` job for every inbound message it classifies. Enqueueing never delays or changes the delivery decision.

`src/jobs/runner.ts` claims and runs both kinds (`src/jobs/jev.ts`) alongside every other job kind — there's no separate Jev worker or poll interval anymore. A job runs, writes its result (`src/db/mail-submissions.ts#saveJevResult` / `src/db/messages.ts#saveClassification`'s `jev*` columns), and completes; a thrown error fails the job onto the shared backoff ladder (1m → 5m → 15m → 1h → 3h → 6h → 12h → 24h, terminal after 9 attempts) — a rate-limited failure (429 / `rate_limit_exceeded` / "high demand") parks on its own, separate ladder instead (`jobs.rate_limits`, 1m → 5m → 15m → capped at 1h, never terminal), without ever spending an attempt. `src/llm/jev.ts` sets `maxRetries: 0` on the `evaluate()` call since the job queue owns retries. A submission or message with no Jev result yet (job still pending, or Jev was disabled when it was recorded) simply has no `jev_*` values set — there is no separate queue-state column to inspect.

`rate_limits` resets to 0 on success or on any non-rate-limit failure — fixed 2026-09-28 (root-caused 40 minutes after the Wave 4 deploy): the original version always rescheduled a rate-limited job on the ladder's first, 1-minute rung regardless of how many times it had already been rate-limited, so a sustained upstream 429 kept every parked job retrying every ~1 minute — replaying roughly its own request volume straight back at the gateway that was returning 429 in the first place (17 `jev_submission` + 2 `jev_message` jobs stuck re-firing at ~14 req/min). The runner also logs a rate-limited outcome as one line (`[jobs] <kind> <id> rate-limited, retry in <n>s (rate_limits=<k>)`) instead of the full error object — a genuine, non-rate-limit failure still gets the full object.

Stored on each `submissions` row: `llm_latency_ms` (classifier latency, for comparison) and `jev_verdict`, `jev_confidence`, `jev_probabilities` (JSON), `jev_latency_ms` (the successful call), `jev_model`, `jev_error`. `/api/submissions` returns them as `jev: { verdict, confidence, probabilities, latencyMs, model, error }` (`null` when nothing has been recorded yet; the verdict fields are `null` until Jev succeeds). The admin Spam filter page shows Jev's verdict next to the LLM's with an agrees/differs marker, or "not yet judged". `getJevComparison` (agreement rate, median latencies) counts only rows with a Jev verdict.

Inbound messages get the same two Jev decisions as before — `spam_probability` (yes/no: unsolicited spam/phishing/cold marketing vs. anything a human wrote to the owner or transactional mail) and a `category` from the same set as the LLM enrichment, with confidence — stored as `jev_*` columns on `classifications` (`src/db/messages.ts`) and returned as part of a message's classification; the LLM fields are untouched, and either side failing never fails the other.

Env vars (all optional):

- `DECISION_PROVIDER` — `ue` (default) or `openrouter`. `ue` reaches IU's decision API with the same `LLM_API_KEY` as the classifier, on the origin of `LLM_BASE_URL`; `openrouter` uses `OPENROUTER_API_KEY`. Missing credentials for the selected provider disable the lane everywhere, silently.
- `OPENROUTER_API_KEY` — OpenRouter key, only read when `DECISION_PROVIDER=openrouter`.
- `DECISION_BASE_URL` — decisions base URL for `ue`, e.g. `<ue-origin>/decisions/v1`. Default: the origin of `LLM_BASE_URL` plus `/decisions/v1` (an unparseable `LLM_BASE_URL` disables the lane).
- `DECISION_MODEL` — decision model id, default `pplx-decider-v1-27b` (UE; `decision-1-eu`, `clef-eu` and the other ids from `GET <ue-origin>/decisions/v1/models` also work). With `openrouter` set an OpenRouter id such as `cloudflare/clef`. Stored in the `jev_model` columns.
- `ARGO_USAGE_URL`, `ARGO_API_SECRET` — Argo usage reporting (below); either unset makes it a no-op.
- `MACHINE` — the `machine` field on usage records, default `vps`.

The lane is called through the AI SDK's experimental `decide` (`src/llm/jev.ts`) with a decision model per `DECISION_PROVIDER`: the official `@ai-sdk/typesafe-ai` provider for `ue` (`createTypeSafeAi({ baseURL, apiKey }).decisionModel(model)`: a `POST <ue-origin>/decisions/v1/systemone` with a Bearer key and `{ model, state, questions }`; boolean maps to UE's `noul`; the SDK validates the answers, including that a choice is one of the question's options; a non-2xx throws an `APICallError` so a 429 parks on the rate-limit ladder), or `@openrouter/ai-sdk-provider`'s `evaluationModel` for `openrouter` (wrapped to unwrap `decide`'s normalized state back to the raw value that provider still posts). Choice confidence comes from `providerMetadata.typesafe.confidence[question]` for `ue` and `providerMetadata.openrouter.answers[question].confidence` for `openrouter` (falling back to the chosen option's probability); OpenRouter also reports the request cost (USD) in `providerMetadata.openrouter.usage.cost`. The TypeSafe provider drops UE's `usage.cost`, so for `ue` `decide` computes it from `DECISION_RATES` (`computeDecisionCost`, `src/usage/argo.ts`): 0.04 USD per 1M input and output tokens for `pplx-decider-v1-27b`, 0.042 per 1M input tokens (output free) for decision-1 / decision-1-eu; other UE models report cost `none`. It is reported as `computed`. Workers AI truncates Clef's text state to ~2K tokens, so `src/enrich/jev-email.ts` caps an email's `text` at 6,000 characters before sending (from/subject stay first); the LLM enrichment path is untouched.

Usage reporting: every model call — the decision lane (`decision-email`, `decision-submission`, billing `iu` for `ue` or `openrouter` for `openrouter`, cost as reported by OpenRouter, or computed for the UE models) and the IU LLM calls (`spam-classify`, `enrich`, `draft-reply`, `thread-summary`, billing `iu`, cost computed from a small rate table in `src/usage/argo.ts`, none for an unknown model) — is posted fire-and-forget to Argo's `POST /usage/records` as one `request`-grain record (`workspace: private`), success and failure alike. Failures are logged, never thrown, and never awaited by the caller.

## Client

`GET /app` — the React SPA (Vite + React 19 + basalt-ui) served by the same Elysia process from `client/dist` (built by the Dockerfile's client stage, never a dev server). It replaces the retired SSR admin; `/admin` now 302s to `/app`. Pages:

- **Inbox** — messages across every account, sorted by "needs me" first, with an account chip per row and category / priority / unread / action-required filters.
- **Message view** — live read through the provider (`GET /api/messages/:key?include=body`), the HTML body rendered in a sandboxed `<iframe sandbox="">`, the classification panel, and mark read/unread, star, archive, spam and trash via the flag/move endpoints.
- **Submissions** — the spam-filter decisions (`getJevComparison` verdicts beside the LLM's), ported from the old SSR page.
- **Templates** — every registered template (`GET /api/templates`), each with a detail page: a 375/600 width preview (`GET /api/templates/:id/preview`, a same-origin `<iframe>`), a "Send test" button (`POST /api/templates/:id/test-send`), the raw preview props, and that template's own send log (`GET /api/send-log?templateId=`).
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
- `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET` — **required**; Amazon SES is the only send provider (§Amazon SES). Credentials are passed to the client explicitly, never from the ambient AWS chain. Missing any of the four fails startup.
- `SES_SNS_TOPIC_ARN` — optional; the one SNS topic `POST /webhooks/ses` accepts (must be in `SES_REGION`). Unset → the webhook path 404s.

`bun run seed:demo` (refuses to run with `NODE_ENV=production`) seeds `$DATA_DIR`'s old `email-gateway.sqlite` with fake spam-filter submissions for exploring the Submissions page locally. `bun run import-legacy` (`scripts/import-legacy.ts`) is the one-shot legacy import — see §Storage below.

## Amazon SES

`ses` is the only `SendProvider` (`src/providers/ses/send.ts`); `src/providers/send-registry.ts` holds a lazy singleton (`sendProvider()`; `sendProviderByName()` returns null for any name but `ses`), built from the four required `SES_*` vars. SES has no idempotency key, so `send_log` is the only duplicate-send protection: the `send` job skips a row that already has a provider message id and otherwise claims the row atomically (`status` `sending`; a fresh claim held by another worker makes the job retry later, a claim older than `SEND_CLAIM_STALE_MS` is taken over, a failed send releases it). The claim stops two live workers from both sending; it does not cover an ambiguous outcome (SES accepted the message but the response or the DB write was lost), which can re-send after `SEND_CLAIM_STALE_MS` — an accepted gap.

SES reports delivery by SNS: the configuration set (`SES_CONFIGURATION_SET`) has an event destination that publishes to an SNS topic, and that topic has an HTTPS subscription to `POST /webhooks/ses`. The route reads the `text/plain` body (256 KB cap, else 413), checks `TopicArn` equals `SES_SNS_TOPIC_ARN` (else 403) **before any network call**, then verifies the SNS signature (`src/providers/ses/sns-verify.ts`, signature versions 1 and 2): the signing certificate is fetched only from exactly `https://sns.<SES_REGION>.amazonaws.com/…pem` (5 s timeout, cached) and anything else is 403. A `SubscriptionConfirmation` is confirmed by a GET of its `SubscribeURL`, held to the same host check. A `Notification` is mapped to the `send_log` row with provider `ses` and that `provider_message_id` (status, plus bounce type/subtype and the diagnostic code on a bounce) and appended to that send's `send_events` timeline, both in one transaction; an unmatched, stale or ignored event is logged (event type and ids only, never the payload) and answered 200 so SNS stops retrying. Rate limiting is Traefik's.

Topic requirements: **raw message delivery must stay off** (the signed SNS envelope is what gets verified) and the topic's `SignatureVersion` should be `2` (SHA-256; version 1 is still accepted).

| SES event                              | `send_log.status`    | `last_event`           |
| -------------------------------------- | -------------------- | ---------------------- |
| `Delivery`                             | `delivered`          | `delivered`            |
| `Bounce`                               | `bounced`            | `bounced:<bounceType>` |
| `Complaint`                            | `complained`         | `complained`           |
| `Reject`                               | `rejected`           | `rejected`             |
| `DeliveryDelay`                        | `delivery_delayed`   | `delivery_delayed`     |
| `Rendering Failure`                    | `failed`             | `failed`               |
| `Send`                                 | none (timeline only) |                        |
| `Open`, `Click`, `Subscription`, other | ignored              |                        |

The status never regresses: `sent` < `delivery_delayed` < `delivered` < `bounced`/`complained`/`rejected`/`failed`. An event applies only if its rank is at least the row's current rank, so a late delay cannot undo `delivered`, while a bounce after `delivered` does apply. SES rows have no `status()` read-back and are not touched by `reconcile_send_log`.

`send_events` is the per-send timeline (`send_id`, `event_type`, `status`, bounce type/subtype, diagnostic code, `occurred_at` from the event's own timestamp, `received_at`): every mapped event lands there, `Send` included, even when it is stale for `send_log`. A UNIQUE index on `(send_id, event_type, occurred_at)` makes an SNS redelivery a no-op. Neither `send_events` nor the new `send_log` bounce columns hold an email address: the diagnostic code has any address-shaped text scrubbed to `[address]` (and is capped at 500 characters), and the SNS recipient lists are never stored. There is no open/click tracking and no Virtual Deliverability Manager — transactional mail only.

### Tags, throttling, suppression

Every send carries two SES message tags (`EmailTags`): `template` (the template id) and `source` (what requested it: `route` for the inline routes, `test-send`, `agent`), so SES events and metrics drill down by template. Values are sanitized to SES's alphabet (`[A-Za-z0-9_\-.@]`, 256 characters; anything else becomes `_`) in one place, `sanitizeSesTag` in `src/providers/ses/send.ts`. SES throttling (`TooManyRequestsException`, `SendingPausedException`, `LimitExceededException`, or any AWS error with HTTP 429) is recognised by `isRateLimitError` (`src/jobs/rate-limit.ts`, by error shape — the SDK is never imported there), so a throttled `send` job parks on the job queue's rate-limit ladder instead of burning attempts; `AccountSuspendedException` is not a rate limit.

The account-level suppression list (SES adds hard bounces and complaints to it) is readable and deletable through `GET /api/ses/suppressions` and `DELETE /api/ses/suppressions/:email` (`src/providers/ses/suppressions.ts`; pages of at most 100, `reason` BOUNCE|COMPLAINT, `cursor` is SES's `NextToken`). Addresses are returned but never stored or logged.

### Stored mail and the account snapshot

A dispatched send keeps its rendered html and text in `send_bodies` (keyed by the `send_log` id) for review: `sendMail` for the inline routes and the `send` job for queued sends store through the one helper `storeSendBody` (`src/utils/send-body.ts`). The stored copy is redacted first: a template registry entry may name secrets via `redact(props)` (`shutterflow-code` returns its auth code) and every occurrence in html and text becomes `[redacted]`; a template that names secrets is not stored at all when its props are missing or yield no non-empty secret. Storing is fail-open (a failure is logged without the body and never fails the send), a failed send stores nothing, and bodies are never logged. Retention is 30 days: the `prune_send_bodies` job deletes older rows daily, and prunes `send_events` with them (same cutoff, by `received_at`). A `redact` that yields no usable secret (empty, not a string, or none) also means nothing is stored.

The hourly `ses_account` job stores SES's `GetAccount` (sending enabled, enforcement status, production access, 24-hour quota, max send rate, sent in the last 24 hours) as the single `ses_account` row, served by `GET /api/ses/account`. It fails quietly (one log line, retried next hour); a throttle parks on the rate-limit ladder. The SDK client is the same lazy one the send provider uses (`sesClient()` in `src/providers/send-registry.ts`).

### Provisioning

`bun scripts/ses-provision.ts [--create-key] <domain>…` converges the AWS side through the `aws` CLI (profile `jk-ses`, `eu-central-1`; override with `AWS_PROFILE`/`AWS_REGION`): per domain an SES identity with Easy DKIM 2048 and a custom MAIL FROM on `ses.<domain>`, the configuration set `email-gateway` with an SNS event destination (send, delivery, bounce, complaint, reject, delivery delay), the SNS topic `email-gateway-ses` (publish allowed only for that configuration set), and the IAM user `email-gateway-ses` scoped to `ses:SendEmail`/`SendRawEmail` on exactly those identities and the set. Re-running is safe. It prints the DNS records to add (three DKIM CNAMEs, the MAIL FROM MX and SPF TXT) and never applies them. `--create-key` mints the access key only if the user has none and prints it once. The HTTPS subscription to `/webhooks/ses` is created after the gateway is deployed with `SES_SNS_TOPIC_ARN` set (the confirmation would 404 before that), with raw message delivery off.

## Observability

OpenTelemetry traces and trace-linked logs for `service.name` `email-gateway`, exported to the ClickStack collector as OTLP/HTTP JSON (`<endpoint>/v1/traces`, `/v1/logs`). SDK-free (`src/telemetry/`, plain `fetch`, batched every 2 s, flushed on SIGTERM/SIGINT); there is no metrics exporter, so counters are structured log events that ClickStack tiles and alerts query. Off — no network at all — unless the endpoint is set.

| Env var                       | Meaning                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL (e.g. `http://<collector>:4319`). Unset → exporter off (dev, tests). |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Optional `key=value,key=value` headers (a bearer for a public ingest).                  |
| `OTEL_SERVICE_NAME`           | Default `email-gateway`.                                                                |
| `OTEL_RESOURCE_ATTRIBUTES`    | Optional `key=value,key=value` extra resource attributes (e.g. `host.name=...`).        |

Spans (all attributes are names, outcomes and counts — never an address, subject, body, auth code, message id, header, query string or prompt; a failed span's status text and its `exception` event carry the error name only, never the message or stack):

| Span                                                                                 | Kind   | Attributes                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<METHOD> <route pattern>`                                                           | server | `http.request.method`, `http.route` (pattern, omitted when unmatched), `http.response.status_code`; 5xx → error status, 4xx unset; `/health` is skipped                         |
| `job.<kind>`                                                                         | root   | `job.kind`, `job.attempt`, `outcome` = `ok` / `retry` / `error` (out of attempts) / `rate_limited`; error status on any handler failure; trace id = the job id when UUID-shaped |
| `ses.send`                                                                           | client | `email.template`, `email.source`, `outcome`; on failure the error name only                                                                                                     |
| `imap.sync`                                                                          | client | `mail.provider`, `mail.mailbox` (role: `inbox`, `spam`, `sent`, ... else `other`), `outcome`, `sync.fetched`, `sync.ingested`                                                   |
| `llm.classify` / `llm.enrich` / `llm.jev` / `llm.thread-summary` / `llm.draft-reply` | client | `llm.model`, `outcome`, `llm.latency_ms`, `llm.input_tokens`, `llm.output_tokens`, `llm.cache_read_tokens`; on failure the error name only                                      |

Log events (OTLP log records, body = name, no stdout line; stamped with the active trace and span id):

| Event              | Attributes                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `send.result`      | `template`, `source`, `status` (`sent` / `failed`)                                                            |
| `ses.event`        | `event_type`, `bounce_type` (warn for bounce / complaint / reject)                                            |
| `job.failed`       | `kind`, `outcome` (`retry` / `error`), `attempt`                                                              |
| `job.rate_limited` | `kind`, `rate_limits`                                                                                         |
| `sync.tick`        | `provider`, `mailbox` (role), `outcome`, `fetched`, `ingested` — a stalled sync is the absence of `ok` events |
| `llm.call`         | `lane`, `outcome`, `latency_ms`                                                                               |
| `ses.account`      | `sending_enabled`, `sent_24h`, `max_24h_send`, `headroom_pct`                                                 |

Mailboxes appear in spans, events and the IMAP log lines by role only. Every `log.info/warn/error` line in `src/` keeps its stdout output byte for byte and additionally ships one log record (message as body, fields as attributes). The OTLP copy is sanitised at the exporter: sensitive attribute names (`to`, `from`, `subject`, `body`, `code`, `*messageId`, ...) are dropped and address-shaped text is replaced with `[redacted-email]` in every attribute, status message and body. The AI SDK's `experimental_telemetry` is deliberately not used (it records prompts and outputs).

## Storage

Two SQLite databases, both opened with `bun:sqlite`, live side by side in `$DATA_DIR` (D4, `docs/architecture.md` §Decisions — the lean-store cutover never migrated the old file, it built a fresh one and left the old one for the owner to delete):

- `${DATA_DIR}/mail.sqlite` — the live store (`src/db/mail-client.ts`, migrations in `src/db/mail-migrations.ts`, tracked via its own `PRAGMA user_version`, independent of the counter below). Tables (full shapes: `docs/architecture.md` §Lean store):
  - `accounts` — one row per configured provider account: address, per-mailbox sync cursors (JSON), last success/error/warning. Providers are `proton` and `gmail`; the `provider` CHECK still allows `resend`, and migration 5 deleted the old Resend account's rows (messages and dependents; `send_log` history stays).
  - `messages` + `message_locations` — envelope-only per message (`direction`, addresses, subject, thread key, flags snapshot) plus every mailbox it's currently seen in (provider ref, last seen). Bodies are never stored here — only a cache.
  - `classifications` — LLM category/priority/summary/facts **and** the Jev shadow columns (`jev_*`), one row per message, filled in by the `classify`/`jev_message` jobs.
  - `body_cache` — `html`/`text` keyed by message, filled on a live read or a `body_prefetch` job; bounded and evicted LRU by `fetched_at` — the reading view's cache, never the source of truth.
  - `send_log` — one row per outbound send (template id, recipients, provider id, `provider_message_id`, status/last event, requested by). Route sends write `provider_message_id` and status `sent` with the row; template sends write them when the `send` job completes. Migration 7 added `bounce_type`, `bounce_subtype` and `diagnostic_code` (set by a bounce event, never an address).
  - `send_events` — the per-send SES event timeline (migration 7); no address column. See §Amazon SES.
  - `send_bodies` — the redacted rendered html + text of a dispatched send, 30-day retention (migration 8).
  - `ses_account` — the latest `GetAccount` snapshot, one row (migration 9).
  - `submissions` — one row per contact-form submission judged by the spam filter, including the Jev shadow columns.
  - `templates` — registered template id, name, preview props, last test-send.
  - `messages_fts` — FTS5 over subject/addresses/summary only, **not** bodies (body search goes live through the provider instead).
  - `jobs` — see below; owned by `src/db/jobs.ts`, not by the migrations file.
- `${DATA_DIR}/email-gateway.sqlite` — the old store (`src/db/migrations.ts`), kept only for `src/db/submissions.ts`'s one remaining legitimate caller, `scripts/import-legacy.ts` (below). Nothing else reads or writes it; it is never deleted by code.

New env var:

- `DATA_DIR` — directory for both SQLite files. Defaults to `./data`. In the Docker image this is `/data`, which `docker-compose` mounts as a volume.

### One-shot legacy import

`bun run import-legacy` (`scripts/import-legacy.ts`) copies every row of the old store's `submissions` table into the new one, preserving the original `id` and `received_at` exactly (D4: `submissions` is the one table that can't be rebuilt from the providers). It reads the old file through `src/db/submissions.ts`'s repo, paginating every page; writes with `INSERT OR IGNORE` on `id`, so running it again is a safe no-op for rows already imported; and never modifies or deletes the old file. Not run automatically — invoke it once, explicitly, during the cutover: `bun run scripts/import-legacy.ts [oldPath] [newPath]` (defaults to `$DATA_DIR/email-gateway.sqlite` and `$DATA_DIR/mail.sqlite`).

## Jobs

Everything asynchronous — sync, classification, Jev, sends — is a row in `mail.sqlite`'s `jobs` table (`src/db/jobs.ts`, `docs/architecture.md` §Jobs): atomic single-row claim with a token, `complete`/`fail` guarded by that token, backoff 1m → 5m → 15m → 1h → 3h → 6h → 12h → 24h, terminal `failed` after nine attempts, stale claims (35 min) taken over so RollHook's two-container deploy overlap never double-runs a row. `src/jobs/runner.ts` polls every 10s (`src/jobs/register.ts`) and dispatches by `kind`:

<!-- prettier-ignore -->
| Kind | Handler | Enqueued by |
|-|-|-|
| `sync_tick` | `src/sync/composition.ts` | A 5-minute schedule, IMAP IDLE (debounced), `POST /admin/sync` and `POST /api/sync` |
| `classify` | `src/jobs/classify.ts` | `sync_tick`, for every newly-ingested message |
| `jev_message` | `src/jobs/jev.ts` | `classify`, for inbound messages once Jev is configured |
| `jev_submission` | `src/jobs/jev.ts` | `src/spam/gate.ts`, after recording a submission, once Jev is configured |
| `send` | `src/jobs/send.ts` | A send route, only on provider failure (the first attempt runs inline); `POST /api/templates/:id/test-send` |
| `prune_send_bodies` | `src/jobs/prune-send-bodies.ts` | A daily schedule (first run shortly after boot); deletes `send_bodies` and `send_events` rows older than 30 days |
| `ses_account` | `src/jobs/ses-account.ts` | An hourly schedule (first run shortly after boot); snapshots SES `GetAccount` into `ses_account` |

A `sync_tick` runs one envelope-only ingest pass per configured provider/mailbox through the `MailProvider` port (`src/sync/ingest.ts`): a "head" pass always re-lists the newest page (so new mail at the top is never missed) plus a bounded backfill pass that pages backward once, historically. It never fetches a body — `classify` does that live via `provider.read()`, and only `classify`'s LLM call and Jev populate `classifications`. IMAP watch (`provider.watch()`/IDLE) kicks a tick as soon as the server reports a change, on top of the 5-minute schedule.

## Templates

`src/emails/registry.ts`'s `emailRegistry` (id, name, component, preview props) is the single source of truth for every template — `TEMPLATE_IDS` is what the send routes and the API reference, never a hand-typed string, so a rename can't silently drift out of sync (`src/emails/registry.test.ts` fails the suite if it ever does). `syncTemplateRegistry()` pushes the registry into the `templates` table on every boot (`src/index.ts`), so the DB list always matches what actually renders.

```bash
curl -H "Authorization: Bearer $API_KEY" https://<host>/api/templates
curl -H "Authorization: Bearer $API_KEY" -X POST https://<host>/api/templates/fpp-sender/test-send
```

A test-send always goes to the owner's own `RECEIVER_EMAIL` — there is no recipient override — as a `send` job, so it goes through the same idempotent, retried path as every other send; `templates.last_test_send_at` records it. `send_log` (one row per outbound send: template id, recipients, provider, status, requested by `route`/`test-send`/future `agent`) is filled in at send time; its status afterwards comes only from SES events delivered to `POST /webhooks/ses` (§Amazon SES) — there is no polling or reconcile job, so a row stays `sent` until an event arrives. Sending is provider-neutral (`src/providers/send-port.ts`): a template is rendered once to html + text and handed to the SES `SendProvider`; a template send fixes its provider at enqueue time (stored in `send_log.provider`) and the `send` job uses that row's provider.

The client's Templates page (§Client above) is a thin view over this: list, a 375/600 preview, test-send, and the per-template send log.

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

| Method & path                         | Query / body                                                                                                                                                            | Notes                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/accounts`                   | —                                                                                                                                                                       | Every account the env configures (`id`, `provider`, `address`), without connecting to any of them — includes an account that has never synced yet, unlike `/api/stats`'s `accounts`.                                                                                                                                           |
| `GET /api/messages`                   | `account` (comma-separated account ids), `direction`, `category`, `needs_me`/`action_required` (`1` or `true`), `since`, `until`, `limit` (1-100, default 25), `cursor` | Keyset-paginated, newest first, from `messages`/`classifications`. `needs_me=1` is sugar for `action_required=true`.                                                                                                                                                                                                           |
| `GET /api/messages/:key`              | `include=body`                                                                                                                                                          | Envelope + locations + classification; body (`html`/`text`, may be `null` if never cached) only when `include=body` is passed. `404` if unknown. Never triggers a live provider read.                                                                                                                                          |
| `GET /api/threads/:key`               | —                                                                                                                                                                       | Every message sharing the key's `threadKey`, newest first; a message with no `threadKey` returns just itself. `404` if the message itself is unknown.                                                                                                                                                                          |
| `GET /api/threads/:key/summary`       | —                                                                                                                                                                       | LLM thread summary (2-4 sentences), cached on the thread key until the thread's newest message changes — built from each message's own `classifications.summary` plus envelope metadata, never one live body read per message. `{ summary, model, messageCount, cached }`; `404` if unknown, `503` if the LLM is unconfigured. |
| `GET /api/search`                     | `q`, `account`, `limit`                                                                                                                                                 | FTS5 over subject/addresses/summary (not bodies) — `{ via: "fts", keys: [...summaries] }`.                                                                                                                                                                                                                                     |
| `POST /api/drafts`                    | body `{ key, instructions? }`                                                                                                                                           | A reply drafted as the owner would write it, plain text (D2: no send-as-owner yet) — uses the cached body, or one live provider read if uncached. `{ draft, model }`; `404` if unknown, `503` if the LLM is unconfigured.                                                                                                      |
| `POST /api/sends`                     | body `{ templateId, to, templateProps, subject?, replyTo? }`                                                                                                            | An agent template send: inserts a `send_log` row (`requestedBy: "agent"`) and enqueues a `send` job — `templateProps` is required (no preview-props fallback), `subject` defaults to `Message: <name>`. `{ enqueued, sendLogId, jobId }`; `404` if `templateId` is unknown.                                                    |
| `GET /api/needs-action`               | `account`, `since`, `until`, `limit`, `cursor`                                                                                                                          | Same keyset-paginated list shape as `/api/messages`, always filtered to `action_required = true`.                                                                                                                                                                                                                              |
| `POST /api/messages/:key/flags`       | body `{ mailbox, add?, remove?, set? }`                                                                                                                                 | Resolves the message's location in `mailbox`, then the account's provider; `501` if the provider's capabilities report `flag: false`.                                                                                                                                                                                          |
| `POST /api/messages/:key/move`        | body `{ mailbox, toMailbox }`                                                                                                                                           | `501` if `move: false`; on success the new location is recorded, the old mailbox's row is left for the next sync tick to supersede.                                                                                                                                                                                            |
| `GET /api/submissions`                | `verdict`, `source`, `delivered`, `limit`, `cursor`                                                                                                                     | Same keyset pagination as before, now over the new `submissions` table (no `jev_status`/`jev_attempts` — that state lives on jobs).                                                                                                                                                                                            |
| `GET /api/templates`                  | —                                                                                                                                                                       | Every registered template (id, name, preview props, last test-send) — see §Templates below.                                                                                                                                                                                                                                    |
| `GET /api/templates/:id/preview`      | `width` (advisory only, for the client's own iframe sizing)                                                                                                             | Renders the template with its registry preview props (`@react-email/render`) and returns raw `text/html`. `404` if `id` is unknown.                                                                                                                                                                                            |
| `POST /api/templates/:id/test-send`   | —                                                                                                                                                                       | Sends the template to the owner's own address (`RECEIVER_EMAIL`) via a `send` job; returns `{ enqueued: true, sendLogId, jobId }`. `404` if `id` is unknown.                                                                                                                                                                   |
| `GET /api/send-log`                   | `templateId`, `limit`, `cursor`                                                                                                                                         | Keyset-paginated send history (every route send, test-send and future agent send), newest first.                                                                                                                                                                                                                               |
| `GET /api/sends/stats`                | `days` (1-90, default 30)                                                                                                                                               | Send counts per UTC day, template and status (`daily`), plus `rates.last7Days` / `rates.last30Days`: `{ sends, bounceRate, complaintRate }` over sends that have a provider message id (rates `null` with 0 sends). Dashboard-facing.                                                                                          |
| `GET /api/sends/:id`                  | —                                                                                                                                                                       | One `send_log` entry (with `bounceType`, `bounceSubtype`, `diagnosticCode`) plus `events` (the `send_events` timeline, oldest first) and `body` (`{ html, text, storedAt }`, redacted, or `null` once pruned or never stored). `404` if unknown. Dashboard-facing.                                                             |
| `GET /api/ses/account`                | —                                                                                                                                                                       | The stored SES account snapshot (`sendingEnabled`, `enforcementStatus`, `productionAccess`, `max24HourSend`, `maxSendRate`, `sentLast24Hours`, `fetchedAt`); `404` until the hourly `ses_account` job has run. Dashboard-facing.                                                                                               |
| `GET /api/ses/suppressions`           | `reason` (`BOUNCE`\|`COMPLAINT`), `cursor`                                                                                                                              | The SES account suppression list, `{ data: [{ email, reason, lastUpdate }], nextCursor }`, pages of at most 100; `502` when SES fails. Dashboard-facing.                                                                                                                                                                       |
| `DELETE /api/ses/suppressions/:email` | —                                                                                                                                                                       | Removes an address from the suppression list — the only mutation here; same bearer / same-origin-session door as every route. `{ ok: true }`; `404` if it is not on the list, `502` when SES fails. Dashboard-facing.                                                                                                          |
| `GET /api/stats`                      | `since` (default: 30 days ago)                                                                                                                                          | `messages` (total/inbound/outbound + category breakdown), `jevComparison`, `jobs` (`{ pending, failed }` across **every** kind, not Jev-specific), `accounts` (per-account health).                                                                                                                                            |
| `POST /api/sync`                      | —                                                                                                                                                                       | Enqueues a `sync_tick` job and returns `{ enqueued: true }` immediately — sync is async now, so there is no result to wait for and no `409 busy`.                                                                                                                                                                              |
| `GET /api/jobs/:id`                   | —                                                                                                                                                                       | One job's status/attempts/error. `404` if unknown.                                                                                                                                                                                                                                                                             |

The four agent-facing endpoints above (`/threads/:key/summary`, `/drafts`, `/sends`, `/needs-action`) are served by one shared service layer (`src/services/agent-api.ts`) that the REST routes and the MCP tools both call.

A bearer-only MCP door at `/mcp` (`src/mcp/plugin.ts`) exposes the same service layer to MCP clients — seven tools (`search_mail`, `read_message`, `summarize_thread`, `needs_action`, `draft_reply`, `send_template`, `job_status`). Like `/app` and `/api` it sits behind `MAIL_HOST`; unset `API_KEY` 404s the prefix. See `docs/agent-api.md` for the curl examples and the MCP client config.

```bash
curl -H "Authorization: Bearer $API_KEY" "https://<host>/api/messages?needs_me=1&limit=10"
```

New env var:

- `API_KEY` — bearer key for `/api/*`, min 16 chars. Unset → the whole `/api/*` prefix 404s.
- `JKRUMM_CONTACT_ORIGINS` — comma-separated browser Origins allowed to call `POST /jkrumm-contact`. Unset → that route 404s.
- `JKRUMM_CONTACT_FROM_EMAIL` — optional sender for the `/jkrumm-contact` receiver mail; falls back to the default sender.
- `JKRUMM_CONTACT_RECEIVER_EMAIL` — optional recipient of the `/jkrumm-contact` receiver mail (e.g. `hello@<your-domain>`); falls back to `RECEIVER_EMAIL`.
- `SHUTTERFLOW_SECRET_KEY` — bearer for `POST /shutterflow` (≥32 chars). Unset → that route 404s.
- `SHUTTERFLOW_FROM_EMAIL` — optional sender for the Shutterflow code mails (a verified SES identity); falls back to the default sender.
- `ATHENA_SECRET_KEY` — bearer for `POST /athena` (≥32 chars). Unset → that route 404s.
- `ATHENA_FROM_EMAIL` — optional sender for the Athena code mails (a verified SES identity, e.g. `Athena <athena@<your-domain>>`); falls back to the default sender. Never an `@iu.org` address (iu.org publishes DMARC `p=reject`).
- `ATHENA_REPLY_TO` — optional Reply-To of the Athena code mails (the owner's address). Set in the deploy env, never in the repo.
- `SY_SERENDIPITY_READ_KEY` — bearer key for `GET /sy-serendipity/requests` only, min 32 chars. Unset → that route 404s.
