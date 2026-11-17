# File map

- `src/telemetry/` (the one OTel module): `otel.ts` span model on
  `AsyncLocalStorage` (`withSpan`, `withRootSpan`, `startSpan`/`activateSpan`),
  batched OTLP exporter and `flushOtel()`, `_test.capture()` to inspect the built
  records without a collector; `otel-format.ts` the pure parts (env parsing,
  `severityFor`, and the redaction: `isSensitiveKey`, `scrubText`);
  `log.ts` the `log.info/warn/error` wrapper every `src/` console call goes
  through (stdout unchanged, OTLP record additive) plus `log.event(name, attrs)`
  for the metric-style events; `http.ts` the Elysia hook plugin behind each
  request's server span. Call sites never touch the exporter. New code logs via
  `log`, never `console.*`, and puts only names/outcomes/counts on a span.
- `src/index.ts` boot: listen, then `startJobSystem` (`src/jobs/register.ts`),
  flushes telemetry on SIGTERM/SIGINT;
  `src/app.ts` mounts routes; `src/env.ts` zod env (parsed at import — modules
  that import it are untestable by design, factor pure logic out)
- `src/routes/{fpp,sy-serendipity}.ts` + `src/auth.ts` — the public send routes
- `src/routes/jkrumm-contact.ts` — `createJkrummContactRoutes`, the public
  personal-site contact route (gate source `jkrumm-contact`, migration 6 widened
  `submissions.source`); template `src/emails/jkrumm/contact-receiver-mail.tsx`.
  `/sy-serendipity` also sends the requester's confirmation
  (`src/emails/sy-serendipity/request-confirmation-mail.tsx`, fail-open)
- `src/routes/shutterflow.ts` — `createShutterflowRoutes`, `POST /shutterflow`
  (own bearer, 404 when unset); template `src/emails/shutterflow/code-mail.tsx`
  on `src/layouts/shutterflow.layout.tsx` (Shutterflow's brand shell ported
  from `apps/share/src/lib/brand`)
- `src/routes/athena.ts` — `createAthenaRoutes`, `POST /athena` (own bearer, 404
  when unset, `@iu.org` recipients only); template `src/emails/athena/code-mail.tsx`
  on `src/layouts/athena.layout.tsx` (self-contained text-first palette, light and dark)
- `src/routes/sy-serendipity-requests.ts` — `GET /sy-serendipity/requests`, the
  read-only admin feed over `mail-submissions.ts`'s `listBySource`; own key
  `SY_SERENDIPITY_READ_KEY` (unset → 404), never `SECRET_KEY`/`API_KEY`, not host-gated
- `src/providers/send-port.ts` the `SendProvider` interface (`send` of a
  pre-rendered `{from,to,replyTo?,subject,html,text,idempotencyKey?}` returning
  `{providerMessageId}`; failures throw) plus
  `renderTemplate` (`@react-email/render` html + plain text, rendered once per
  send). SES is the only provider: `src/providers/send-registry.ts` is a lazy
  singleton (`sendProvider()`; `sendProviderByName(name)` returns null for any
  name but `ses`, e.g. an old `send_log` row), built from the four required
  `SES_*` env vars; `sesClient()` is the one shared lazy `SESv2Client` (also
  used by the `ses_account` job and the suppressions routes). `sendMail`
  records `send_log.provider`/
  `provider_message_id`; the `send` job uses the provider on its send_log row.
  Both pass `tags` (`template`, `source`) that become SES `EmailTags`.
  A row's status after sending comes only from SES events via
  `POST /webhooks/ses` — no polling or reconcile job.
  `src/test/fake-send-provider.ts` is the test adapter.
- `src/providers/ses/` (Wave 12): `send.ts` the SES `SendProvider`
  (`createSesSendProvider({ client, configurationSetName })`, `SendEmailCommand`
  with `EmailTags` from `SendMessage.tags` via `sanitizeSesTag`, no `status()`;
  the registry builds it lazily from the required `SES_*` env), `events.ts` the
  pure SES event → `{providerMessageId, eventType, status | null, lastEvent,
  occurredAt, bounceType?, bounceSubtype?, diagnosticCode?}` mapping (`Send` →
  status null, timeline only; ignored types → null), `account.ts` (Wave 18)
  the pure `GetAccount` → `SesAccountSnapshot` mapping + `fetchSesAccount`,
  `suppressions.ts` the injectable list/delete of the SES account suppression
  list (`createSesSuppressions`, pages capped at 100), `sns-verify.ts` the pure
  SNS signature verifier (`createSnsVerifier({ region, fetchCert })`,
  `trustedSnsUrl`, v1/v2). `src/routes/ses-webhook.ts`
  (`createSesWebhookRoutes`) is the `POST /webhooks/ses` door and calls
  `sendLogRepo.recordProviderEvent` (status update + `send_events` row in one
  transaction; status never regresses:
  sent < delivery_delayed < delivered < bounced/complained/rejected/failed);
  `src/test/sns-fixture.ts` signs fake SNS messages with a generated key.
- `src/emails/` React Email templates + `registry.ts` (Wave 7: `TEMPLATE_IDS`
  is the single source of truth for every template id — the send routes and
  the API reference it, never a hand-typed string; `sync-registry.ts`'s
  `syncTemplateRegistry()` pushes the registry into the `templates` table on
  every boot); `src/layouts/`; `src/utils/send-mail.ts` (SES send + a
  `send_log` row via `src/db/mail-index.ts`'s `sendLogRepo` — no longer
  touches the old `emails` table — plus the redacted stored body through
  `src/utils/send-body.ts`). The registry's preview page was retired
  with the SSR admin; the client's Templates page (Wave 7) replaces it, now
  backed by `GET /api/templates(/:id/preview)` and
  `POST /api/templates/:id/test-send`
- `src/telemetry/llm-call.ts` the `llm.<lane>` client span and `llm.call` event
  for one model call (`traceLlmCall` wraps every `generateText` site;
  `src/llm/jev.ts`'s `decide` uses `startLlmCall` itself). The gateway
  reports no usage itself: usage-tracker's `email-gateway` collector reads these
  spans (tokens, model, outcome) from the VPS ClickStack into `usage.records`, so
  keep the `llm.*` span names and the `llm.model` / `llm.input_tokens` /
  `llm.output_tokens` / `llm.cache_read_tokens` attributes stable
- `src/spam/` contact-form gate (`gate.ts` deadline race, enqueues a
  `jev_submission` job on the new `mail.sqlite` `submissions` table instead of
  the old in-memory kick; `classify.ts`, `jev-judge.ts`)
- `src/enrich/` LLM enrichment logic (`enrich-email.ts`) + `jev-email.ts`,
  both now called from job handlers, not a poll loop; `src/llm/` model
  factories (`model.ts`, `jev.ts` — picks the decision provider per
  `DECISION_PROVIDER`, default `ue` = `createTypeSafeAi({ baseURL, apiKey
  }).decisionModel(model)` over `…/decisions/v1/systemone`; base from
  `DECISION_BASE_URL` or the `LLM_BASE_URL` origin; the SDK validates the
  answers, the provider drops UE's `usage.cost` so `decide` computes it from
  `DECISION_RATES` in `src/llm/jev.ts`; `@ai-sdk/provider` stays a
  types-only devDependency, runtime error classes come from `ai`; the
  OpenRouter model is wrapped in
  `openrouter-decision-model.ts` (`unwrapDecisionState` undoes `decide`'s
  normalized state)) plus `thread-summary.ts`/`draft-reply.ts`
  (Wave 8's two prompt builders for the agent API, both modelled on
  `enrich-email.ts`: same model plumbing, untrusted-data framing and 30-min
  hang guard)
- `src/db/jobs.ts` + `src/jobs/runner.ts` + `src/jobs/idle-watchdog.ts` +
  `src/jobs/rate-limit.ts`'s `isRateLimitError` (job-queue-owned, not an LLM
  concept, despite classifying LLM-gateway 429s and, by error shape only, SES
  throttles — `TooManyRequestsException`/`SendingPausedException`/
  `LimitExceededException`/HTTP 429 — among other things): the
  one job queue every async source now runs on (`docs/architecture.md`
  §Jobs), live against `mail.sqlite` via `src/jobs/queue.ts`'s `jobQueue`
  singleton. `src/jobs/register.ts` is the boot composition root
  (`startJobSystem`): registers `sync_tick`/`classify`/`jev_message`/
  `jev_submission`/`send`/`prune_send_bodies`/`ses_account` (the last two on
  daily/hourly timers), reaps this host's
  stale claims once, polls `runner.drain()`, and wires IMAP `watch()`/IDLE to
  kick a debounced `sync_tick`.
  `src/jobs/classify.ts`, `src/jobs/jev.ts`, `src/jobs/send.ts`,
  `src/jobs/prune-send-bodies.ts`, `src/jobs/ses-account.ts`
  are the handler factories (Wave 15 removed `reconcile_send_log`); `runner.ts`'s `runOnce` now classifies a caught
  error via `isRateLimitError` and calls `fail({ rateLimited: true })` so a
  429 parks on `jobs.rate_limits`'s own escalating ladder (1m → 5m → 15m →
  capped 1h, never terminal, resets on success/other failure) instead of
  burning an `attempts`. `ensureJobsSchema` ALTERs `rate_limits` onto an
  existing table idempotently — this module owns 100% of the jobs DDL, so a
  post-launch column has no versioned migration path, only this on-boot
  check (2026-09-28 fix, see README §Jev shadow mode).
- `src/sync/ingest.ts` + `src/sync/composition.ts` (Wave 4): envelope-only
  ingest of one mailbox through any `MailProvider` into `messages`/
  `message_locations`, and the composition root (`runSyncTick`) that loops
  every configured provider's mailboxes. `defaultMailboxesFor` keys each
  provider to its own env (`IMAP_MAILBOXES` for Proton, `GMAIL_IMAP_MAILBOXES`
  for Gmail) — one account's list is never applied to the other.
  `src/providers/from-env.ts` builds the configured `MailProvider`s once per
  process (Proton when `IMAP_HOST` is set; Gmail when
  `GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD` are) and resolves one back from
  a stored account id.
- `src/db/mail-index.ts` (Wave 4): the `mail.sqlite` repo singletons
  (`accountsRepo`, `messagesRepo`, `mailSubmissionsRepo`, `templatesRepo`,
  `sendLogRepo`, `threadSummariesRepo` — Wave 8's cached LLM thread
  summaries, `sendBodiesRepo`, `sesAccountRepo` — Wave 18), each bound to `mailDb`.
  `src/db/mail-migrations.ts`
  - `src/db/mail-client.ts` own the schema (`docs/architecture.md` §Lean
    store) and the `mailDb` singleton, opened alongside — never replacing — the
    untouched `email-gateway.sqlite` (`openDatabase` in `src/db/client.ts`); both share
    `src/db/migration-runner.ts`'s generic `applyMigrations`, and
    `mail-client.ts` also calls `ensureJobsSchema` so `jobs` is real there.
    `src/db/{accounts,messages,mail-submissions,templates,send-log,thread-summaries,send-bodies,ses-account}.ts`
    are the domain repos over that schema (same `createXRepo(db)`/`XRepo` shape
    as the repos below; `send-log.ts` also owns `send_events`:
    `recordProviderEvent`, `listSendEvents`, `getSendStats`).
- `src/providers/port.ts` the `MailProvider` interface (capabilities, list,
  read, search, setFlags, move, watch) every mailbox sits behind;
  `src/providers/imap/adapter.ts` grows the old IMAP port with Bridge/Gmail
  capability detection, `listMailboxes`, flags/move (`SELECT`, gated on
  MOVE+UIDPLUS together), `search`; Gmail's `X-GM-EXT-1` adds `X-GM-THRID` to
  the fetch as the generic `threadKey`, and `CONDSTORE` exposes an internal
  `listChangedSince` fast path (only in `adapter.ts`, not the public port);
  `src/providers/imap/provider.ts` wraps that into the generic `MailProvider`
  (UIDVALIDITY + cross-provider ref checks) and keeps the per-mailbox modseq
  bookmark process-local; `config.ts` reads env into `ImapConfig`
  (`imapConfigFromEnv` for Proton STARTTLS, `gmailImapConfigFromEnv` for
  `imap.gmail.com:993` implicit TLS). `list`/`read`/`search`/
  `setFlags`/`move` share one pooled, reused `ImapSession` per provider
  instance (serialized, idle-closed after `poolIdleMs`, one reconnect-and-
  retry on a dead connection for read-only calls only — a mutating call
  whose connection dies mid-flight is never replayed, since the server may
  have already applied it) instead of opening a session per call;
  `watch()`/IDLE runs on its own dedicated long-lived connection
  (`adapter.ts`'s `createIdleClient`, no `disableAutoIdle`) with
  reconnect/backoff, kept entirely separate from the pool.
  `ProviderId` is `proton | gmail`.
- `src/db/` (the old `email-gateway.sqlite` store, kept only for
  `scripts/import-legacy.ts`) `client.ts` (`openDatabase`: pragmas, migrations),
  `migrations.ts`, `submissions.ts` + `jev-queue.ts` (the queue module
  `submissions.ts` still depends on) — every other old-store repo
  (`emails.ts`, `imap-state.ts`, `sync-state.ts`) is deleted
- `client/` the Vite 8 + React 19 + basalt-ui SPA (a Bun workspace of the root
  package — one hoisted `node_modules` and lockfile, so the client's `elysia`
  and the server's are the same instance and Eden's `App` type resolves;
  `basaltViteConfig` from `basalt-ui/vite`, TanStack Router file routes in
  `client/src/routes`, TanStack Query, `client/src/lib/eden.ts`'s Eden Treaty
  typed against `src/app.ts`'s exported `App`). `bun run build` emits
  `client/dist`; `client/src/routeTree.gen.ts` is generated and gitignored.
- `src/web/plugin.ts` (`createWebRoutes`/`webRoutes`) serves `client/dist` at
  `/app` (`@elysia/static`, `alwaysStatic`, hashed assets long-cached, an
  explicit `/app` + `/app/*` catch-all returning `index.html` with no-store),
  owns the session routes `POST /app/login`, `POST /app/logout` and
  `GET /app/session` (signed HttpOnly `SameSite=Strict` cookie via Elysia's core
  cookie config, `src/session.ts`'s `sessionSecret`), and `/admin` → 302 `/app`
  only while enabled.
  Disabled entirely (404, `/admin` included) when `ADMIN_PASSWORD` is unset/short.
- `src/session.ts` shared session constants/helpers (`SESSION_COOKIE`,
  `isSameOrigin`, `sessionValue`/`isSessionValue` — the signed payload carries
  an absolute expiry both doors validate, `sessionSecret`) used by both `src/web`
  and `src/api`; `src/host-gate.ts` the `MAIL_HOST` gate (`hostAllowed` +
  `createApp`'s scoped `.guard`) — a mismatching Host 404s `/app`, `/api` and
  `/mcp` while the send routes and `/health` stay on any Host.
- `src/api/plugin.ts` bearer JSON API (Wave 18 added, inside the one route
  chain so Eden types flow: `GET /api/sends/stats`, `GET /api/sends/:id`,
  `GET /api/ses/account`, `GET /api/ses/suppressions`,
  `DELETE /api/ses/suppressions/:email`); a same-origin request carrying the valid
  `/app` session cookie is accepted as an alternative to the bearer (the browser
  client's door) — bearer semantics for agents are unchanged. Wave 8 added
  `GET /api/threads/:key/summary`, `POST /api/drafts`, `POST /api/sends` and
  `GET /api/needs-action`, and removed the legacy `/api/emails*` aliases; the
  four call `src/services/agent-api.ts`'s `createAgentApi` — the one service
  layer both the REST routes and the MCP tools share, never talking
  to SQLite or a provider directly (injectable deps default to the production
  singletons, `createApiRoutes`'s own DI style). `src/test/` fakes and setup;
  `scripts/seed-demo.ts` (submissions-only fixtures for the old store),
  `scripts/import-legacy.ts` (one-shot: old store's `submissions` →
  `mail.sqlite`), `scripts/ses-provision.ts` (Wave 13: idempotent AWS-CLI provisioning of the SES identities, configuration set, SNS topic and send-only IAM user; prints DNS records, never applies them), `scripts/backup.ts` + `scripts/backup.sh` (Wave 9: VACUUM
  INTO snapshot + off-box rsync — runs on the VPS via cron, not from a dev
  checkout; see `docs/vps-cutover.md`)
- `src/mcp/plugin.ts` (`createMcpRoutes`/`mcpRoutes`, Wave 8): the `/mcp` door
  onto the same `createAgentApi` service layer, `@modelcontextprotocol/server`
  2.0.0 `createMcpHandler` (per-request `McpServer`, `responseMode: 'sse'`,
  legacy stateless fallback) mounted as `.post('/')` + `.get('/')`. Seven
  tools — `search_mail`, `read_message`, `summarize_thread`, `needs_action`,
  `draft_reply`, `send_template`, `job_status` — each a thin wrapper returning
  `{ content, structuredContent }`, or `{ content, isError: true }` naming the
  service's error code. Bearer-only (`env.API_KEY` + `timingSafeEqualStrings`,
  no session cookie), `.onBeforeHandle` before the mount; unset `API_KEY`
  404s the prefix like `/api`. `createMcpRoutes`'s `apiKey`/`agentApi` are
  injectable for tests.
