# email-gateway — Agent Instructions

Bun + Elysia service on the VPS: the one door to the owner's mail. Today it sends
app mail through Resend (`/fpp`, `/fpp-daily-analytics`, `/sy-serendipity`),
syncs Resend history and two IMAP accounts — Proton `hello@` through Bridge on
the homelab (tailnet, STARTTLS) and Gmail through its IMAP endpoint (implicit
TLS, app password) — into SQLite, classifies with an LLM plus Jev in shadow
mode, and serves an SSR admin at `/admin` and a bearer JSON API at `/api/*`.
**README.md is the contract** (endpoints, env vars, storage, sync rules); this
file is what a dispatched agent needs before touching code.

| Doc                    | Holds                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `README.md`            | Endpoints, env, spam gate, Jev queue, storage tables, sync and IMAP rules — first               |
| `docs/vision.md`       | Where this is going, in the owner's words                                                       |
| `docs/architecture.md` | The settled target: provider port, lean store, jobs, client, agent API, topology, **Decisions** |
| `docs/waves/PLAN.md`   | The wave chain building it; exactly one wave is `active`                                        |

## Stack

Bun 1.4 · Elysia 1.4 (`@elysiajs/bearer`) · `bun:sqlite` (WAL, migrations by
`PRAGMA user_version`, append-only) · imapflow 2 + postal-mime · resend 6 +
react-email 6 · AI SDK 7 (`@ai-sdk/openai-compatible` for the LLM, the Vercel AI
Gateway `evaluation` for Jev) · React 19 SSR for `/admin` with `basalt-ui`
tokens · zod 4 · TypeScript strict, `verbatimModuleSyntax`. No build step: the
image runs `src/index.ts` directly.

## Commands

```bash
bun install --frozen-lockfile
bun run dev            # watch mode (doppler run — dev secrets, see Local dev)
bun run typecheck      # tsc --noEmit
bun test               # bun test, preload src/test/setup.ts (in-memory DB, dummy env)
bun run format:check   # prettier — the gate runs this, run `bun run format` before committing
bun run email          # react-email preview of src/emails
bun run seed:demo      # fake submissions into the old email-gateway.sqlite (refuses NODE_ENV=production)
bun run import-legacy  # one-shot: copy the old store's submissions into mail.sqlite
```

Gate for every change: `/check` (format:check, typecheck, `bun test`, fallow),
then `/review` on code. There is no lint script; prettier is the formatter.

## Invariants that change a decision

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
- **Migrations are append-only**; `accounts.provider` has a CHECK constraint, so a
  new provider is a migration.
- **No timeouts on agent-style work** (`rules/agent-limits.md`): the LLM calls
  carry a 30-min hang guard, not a budget.

## Production

VPS container, `vps/apps/email-gateway/compose.yml` (image
`rollhook.jkrumm.com/email-gateway`, port 3010, `/var/lib/email-gateway:/data`,
Traefik host `email-gateway.<domain>` behind Cloudflare Tunnel, rate-limit +
security-headers middlewares, `/health` check, Uptime Kuma monitor). Secrets:
`vps/apps/email-gateway/.env.tpl` → `make email-gateway-env` (1Password). Bridge
lives on the homelab (`homelab/docs/proton-bridge.md`), IMAP only, on the
tailnet; the tailnet ACL grants VPS → homelab `tcp:1143`. Gmail joins directly
from the container (`imap.gmail.com:993`, app password). **No backup covers
`/var/lib/email-gateway` yet.** Not wired in prod today: `RESEND_ADMIN_API_KEY`,
`IMAP_TLS_CERT` (runs `IMAP_TLS_INSECURE=true`), `IMAP_MAILBOXES`,
`GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD` (awaiting the app password).

## Local dev

`doppler.yaml` (project `email-gateway`, config `dev`) feeds `bun run dev` — the
only repo in the workspace still on Doppler; the siblings use `secrets-run` +
`.env.tpl`, and the move is a planned wave. `src/test/setup.ts` sets dummy
required env and `DATA_DIR=":memory:"`, so tests never need secrets.

## File map

- `src/index.ts` boot: listen, then `startJobSystem` (`src/jobs/register.ts`);
  `src/app.ts` mounts routes; `src/env.ts` zod env (parsed at import — modules
  that import it are untestable by design, factor pure logic out)
- `src/routes/{fpp,sy-serendipity}.ts` + `src/auth.ts` — the public send routes
- `src/emails/` React Email templates + `registry.ts` (admin preview only);
  `src/layouts/`; `src/utils/send-mail.ts` (Resend send + a `send_log` row via
  `src/db/mail-index.ts`'s `sendLogRepo` — no longer touches the old `emails`
  table)
- `src/spam/` contact-form gate (`gate.ts` deadline race, enqueues a
  `jev_submission` job on the new `mail.sqlite` `submissions` table instead of
  the old in-memory kick; `classify.ts`, `jev-judge.ts`)
- `src/enrich/` LLM enrichment logic (`enrich-email.ts`) + `jev-email.ts`,
  both now called from job handlers, not a poll loop; `src/llm/` model
  factories (`model.ts`, `jev.ts`)
- `src/db/jobs.ts` + `src/jobs/runner.ts` + `src/jobs/idle-watchdog.ts` +
  `src/jobs/rate-limit.ts`'s `isRateLimitError` (job-queue-owned, not an LLM
  concept, despite classifying LLM-gateway 429s among other things): the
  one job queue every async source now runs on (`docs/architecture.md`
  §Jobs), live against `mail.sqlite` via `src/jobs/queue.ts`'s `jobQueue`
  singleton. `src/jobs/register.ts` is the boot composition root
  (`startJobSystem`): registers `sync_tick`/`classify`/`jev_message`/
  `jev_submission`/`send`, reaps this host's stale claims once, polls
  `runner.drain()`, and wires IMAP `watch()`/IDLE to kick a debounced
  `sync_tick`. `src/jobs/classify.ts`, `src/jobs/jev.ts`, `src/jobs/send.ts`
  are the handler factories; `runner.ts`'s `runOnce` now classifies a caught
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
  process (Resend always; Proton when `IMAP_HOST` is set; Gmail when
  `GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD` are) and resolves one back from
  a stored account id.
- `src/db/mail-index.ts` (Wave 4): the `mail.sqlite` repo singletons
  (`accountsRepo`, `messagesRepo`, `mailSubmissionsRepo`, `templatesRepo`,
  `sendLogRepo`), each bound to `mailDb` the same way the old-store repos
  below are bound to `db`. `src/db/mail-migrations.ts`
  - `src/db/mail-client.ts` own the schema (`docs/architecture.md` §Lean
    store) and the `mailDb` singleton, opened alongside — never replacing — the
    untouched `email-gateway.sqlite`/`db` from `src/db/client.ts`; both share
    `src/db/migration-runner.ts`'s generic `applyMigrations`, and
    `mail-client.ts` also calls `ensureJobsSchema` so `jobs` is real there.
    `src/db/{accounts,messages,mail-submissions,templates,send-log}.ts` are the
    domain repos over that schema (same `createXRepo(db)`/`XRepo` shape as the
    repos below).
- `src/providers/port.ts` the `MailProvider` interface (capabilities, list,
  read, search, setFlags, move, send, watch) every mailbox sits behind;
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
  reconnect/backoff, kept entirely separate from the pool. `src/providers/resend/`
  wraps `send-mail.ts`/`utils/resend.ts` as a send+list-only provider
- `src/db/` (the old `email-gateway.sqlite` store, kept only for
  `scripts/import-legacy.ts`) `client.ts` (lazy singleton, pragmas),
  `migrations.ts`, `submissions.ts` + `jev-queue.ts` (the queue module
  `submissions.ts` still depends on) — every other old-store repo
  (`emails.ts`, `imap-state.ts`, `sync-state.ts`) is deleted
- `src/admin/` SSR admin: `plugin.tsx` routes (Basic auth, same-origin POSTs),
  `layout.tsx`/`ui.tsx`/`styles.ts`/`assets.ts`. Only `pages/submissions.tsx`
  and `pages/templates.tsx` remain — Overview/Inbox/email-detail were deleted
  in Wave 4's lean-store cutover along with the old `emails`/`email_enrichments`
  tables they read; `/admin` redirects to `/admin/submissions` until Wave 6
  replaces this with the React client
- `src/api/plugin.ts` bearer JSON API; `src/test/` fakes and setup;
  `scripts/seed-demo.ts` (submissions-only fixtures for the old store),
  `scripts/import-legacy.ts` (one-shot: old store's `submissions` → `mail.sqlite`)

## Conventions

Deep modules, ports and adapters: route factories and the sync runner take their
dependencies as parameters; tests inject in-memory SQLite (`openDatabase(":memory:")`),
fake IMAP ports/clients, `MockLanguageModelV4`, `fakeJevModel`. No
`mock.module`, no `spyOn`. Tests live next to the code as `*.test.ts` and build
Elysia apps from the factories, calling `app.handle(new Request(...))`. Dates
render in `Europe/Berlin`. Never add AI/tool attribution anywhere.

## Gotchas

- The FPP web caller aborts at 7 s while the gate's deadline is 8 s — a slow
  classifier makes FPP report failure although the mail is delivered.
- fpp-analytics reads `BEA_BASE_URL`/`BEA_SECRET_KEY` while the VPS compose sets
  `EMAIL_GATEWAY_URL`/`EMAIL_GATEWAY_SECRET_KEY` — check prod before trusting
  that daily analytics mail arrives.
