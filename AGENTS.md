# email-gateway — Agent Instructions

Bun + Elysia service on the VPS: the one door to the owner's mail. Today it sends
app mail through Resend (`/fpp`, `/fpp-daily-analytics`, `/sy-serendipity`),
syncs Resend history and the Proton `hello@` inbox (Bridge on the homelab, tailnet
IMAP) into SQLite, classifies with an LLM plus Jev in shadow mode, and serves an
SSR admin at `/admin` and a bearer JSON API at `/api/*`. **README.md is the
contract** (endpoints, env vars, storage, sync rules); this file is what a
dispatched agent needs before touching code.

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
bun run seed:demo      # fake emails + submissions into $DATA_DIR (refuses NODE_ENV=production)
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
  a short overlap — every queue needs an atomic claim with a token and stale
  takeover (`src/db/jev-queue.ts` is the reference), never an in-memory lock
  alone.
- **IMAP sync stays read-only**: `EXAMINE` + `BODY.PEEK`, STARTTLS required,
  cert pinned by SHA-256 when `IMAP_TLS_CERT` is set. The IMAP adapter
  (`src/providers/imap/adapter.ts`) does expose `setFlags`/`move`
  (`SELECT`, per D2) for future callers — the sync tick itself never opens a
  mailbox for write.
- **Rows are insert-only for IMAP** — a sender-controlled Message-ID must never
  overwrite a stored row. Row ids never derive from the UID.
- **Fail open on the submission path.** The gate never 500s after delivery; DB
  errors there are logged, not thrown. The classifier and Jev are optional at
  runtime (unset env → off, rows stay `pending`).
- **Memory is 256 MB** in prod; the 5 MB / 10 MB / 50-message / 500-per-run
  IMAP bounds exist for that.
- **Migrations are append-only**; `emails.provider` has a CHECK constraint, so a
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
tailnet; the tailnet ACL grants VPS → homelab `tcp:1143`. **No backup covers
`/var/lib/email-gateway` yet.** Not wired in prod today: `RESEND_ADMIN_API_KEY`,
`IMAP_TLS_CERT` (runs `IMAP_TLS_INSECURE=true`), `IMAP_MAILBOXES`.

## Local dev

`doppler.yaml` (project `email-gateway`, config `dev`) feeds `bun run dev` — the
only repo in the workspace still on Doppler; the siblings use `secrets-run` +
`.env.tpl`, and the move is a planned wave. `src/test/setup.ts` sets dummy
required env and `DATA_DIR=":memory:"`, so tests never need secrets.

## File map

- `src/index.ts` boot: listen, then `startSync`, `startEnrichmentWorker`,
  `startJevWorker`; `src/app.ts` mounts routes; `src/env.ts` zod env (parsed at
  import — modules that import it are untestable by design, factor pure logic out)
- `src/routes/{fpp,sy-serendipity}.ts` + `src/auth.ts` — the public send routes
- `src/emails/` React Email templates + `registry.ts` (admin preview only);
  `src/layouts/`; `src/utils/send-mail.ts` (Resend send + minimal outbound row)
- `src/spam/` contact-form gate (`gate.ts` deadline race, `classify.ts`,
  `jev-judge.ts`)
- `src/enrich/` LLM enrichment of every email + `jev-email.ts`; `src/llm/`
  model factories (`model.ts`, `jev.ts`)
- `src/jev/worker.ts` drains both Jev queues; `src/db/jev-queue.ts` the generic
  claim/backoff queue (table-parameterised, despite the name)
- `src/db/jobs.ts` + `src/jobs/runner.ts` + `src/jobs/idle-watchdog.ts`: the
  general one-table job queue from `docs/architecture.md` §Jobs (Wave 3).
  Schema-neutral today — its DDL is **not** in `migrations.ts` and nothing on
  the boot path imports it (`src/db/jobs-schema-isolation.test.ts` is the
  tripwire); proven only against an in-memory DB until Wave 4 gives it a real
  table and moves `jev-queue.ts`'s consumers onto it
- `src/providers/port.ts` the `MailProvider` interface (capabilities, list,
  read, search, setFlags, move, send, watch) every mailbox sits behind;
  `src/providers/imap/adapter.ts` grows the old IMAP port with Bridge/Gmail
  capability detection, `listMailboxes`, flags/move (`SELECT`, gated on
  MOVE+UIDPLUS together), `search` — plus the batched low-level
  session/mailbox primitives `src/sync/imap-sync.ts` still consumes directly;
  `src/providers/imap/provider.ts` wraps that into the generic `MailProvider`
  (UIDVALIDITY + cross-provider ref checks); `config.ts` reads env into
  `ImapConfig`. `src/providers/resend/` wraps `send-mail.ts`/`utils/resend.ts`
  as a send+list-only provider
- `src/sync/` `index.ts` composition root + schedule, `resend-sync.ts`,
  `imap-sync.ts` (cursor, batches, holds) — both consume their adapter from
  `src/providers/`
- `src/db/` `client.ts` (lazy singleton, pragmas), `migrations.ts`,
  repositories `emails.ts`, `submissions.ts`, `imap-state.ts`, `sync-state.ts`
- `src/admin/` SSR admin (`plugin.tsx` routes + Basic auth + same-origin POSTs,
  `pages/`, `ui.tsx`, `styles.ts`, `assets.ts` fonts + palette CSS)
- `src/api/plugin.ts` bearer JSON API; `src/test/` fakes and setup;
  `scripts/seed-demo.ts`

## Conventions

Deep modules, ports and adapters: route factories and the sync runner take their
dependencies as parameters; tests inject in-memory SQLite (`openDatabase(":memory:")`),
fake IMAP ports/clients, `MockLanguageModelV4`, `fakeJevModel`. No
`mock.module`, no `spyOn`. Tests live next to the code as `*.test.ts` and build
Elysia apps from the factories, calling `app.handle(new Request(...))`. Dates
render in `Europe/Berlin`. Never add AI/tool attribution anywhere.

## Gotchas

- `jev-queue.ts` claims **one row per call**; the README's "up to 10 per table"
  describes the batch loop, not the claim.
- The FPP web caller aborts at 7 s while the gate's deadline is 8 s — a slow
  classifier makes FPP report failure although the mail is delivered.
- `resend-sync.ts` re-upserts every known outbound row on every run; the
  `updated` count is not "changed".
- The enrichment queue (`emails.ts` `claimEnrichment`) has no backoff and no
  claim token — it is the queue the architecture retires first.
- fpp-analytics reads `BEA_BASE_URL`/`BEA_SECRET_KEY` while the VPS compose sets
  `EMAIL_GATEWAY_URL`/`EMAIL_GATEWAY_SECRET_KEY` — check prod before trusting
  that daily analytics mail arrives.
