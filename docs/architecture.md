# Architecture

The settled shape of email-gateway. `docs/vision.md` says where we want to go
in the owner's words; this file says how, and records the decisions taken with
the owner on 2026-09-27. Later waves follow this file; contradicting it means
going back to the owner. `README.md` documents what runs today.

## Principles

1. **Providers stay the source of truth.** Proton (through Bridge), Gmail and
   Resend own the mail. The gateway reads through them live and persists only
   what they cannot give back: classifications, the send log, submissions,
   templates, job state. Wiping the store loses nothing a re-read cannot
   rebuild.
2. **One port, N adapters.** Every mailbox sits behind the same `MailProvider`
   interface. A new mailbox is a new adapter, not a new code path.
3. **One job table.** Everything asynchronous — classification, Jev, sends,
   sync ticks — is a persisted job with claim, backoff and a terminal state.
4. **One deployable.** Server, workers and the client ship as one container.
5. **`master` is production.** Every push deploys via RollHook; every commit
   keeps `/fpp`, `/fpp-daily-analytics` and `/sy-serendipity` working.

## Today, in one paragraph

Bun + Elysia on the VPS, public through Cloudflare Tunnel + Traefik, 256 MB.
Three bearer-guarded send routes render React Email templates through Resend.
A 5-minute scheduler pulls Resend history and the Proton `hello@` inbox (Bridge
on the homelab, tailnet IMAP, read-only, `BODY.PEEK`) into one `emails` table
with **full html/text bodies** and an FTS5 index over them. An LLM enriches
every row; Jev judges inbound rows and contact-form submissions in shadow mode
through a durable queue (`src/db/jev-queue.ts`). A zero-JS SSR admin at `/admin`
(Basic auth) and a bearer JSON API at `/api/*` read the store. Details:
`README.md`; the full code map that informed this design is summarised in
§Constraints.

## Target shape

```
                public hostname (tunnel)        tailnet hostname (DNS-only A record)
                        │                                   │
                  /fpp /sy-* /health                /app  /api  /mcp  /health
                        └──────────────┬────────────────────┘
                                  Elysia (one process)
        ┌──────────────┬──────────────┼──────────────┬───────────────┐
   send routes     client (SPA)   agent API (REST+MCP)   job runner   sync/IDLE
        │                              │                     │              │
        └────────── MailProvider port ─┴──────── jobs ───────┴──────────────┘
                 │              │              │
           Proton/Bridge     Gmail          Resend            SQLite (derived data only)
```

## Provider port

One interface, in `src/providers/port.ts`. Capabilities are declared, not
assumed: the Proton adapter reports what Bridge advertises at connect time, the
Resend adapter reports send-only.

```ts
interface MailProvider {
  readonly id: ProviderId; // "proton" | "gmail" | "resend"
  readonly account: string; // hello@…, me@gmail.com, resend domain
  capabilities(): Promise<Capabilities>; // { list, read, search, flag, move, send, idle }
  listMailboxes(): Promise<Mailbox[]>;
  list(mailbox: string, cursor: Cursor): Promise<Page<Envelope>>; // newest first, bounded
  read(ref: MessageRef): Promise<Message>; // headers + parsed body + attachment meta
  search(query: SearchQuery): Promise<MessageRef[]>; // provider-side, may lag
  setFlags(ref: MessageRef, flags: FlagChange): Promise<void>;
  move(ref: MessageRef, toMailbox: string): Promise<MessageRef>;
  send(draft: OutboundDraft): Promise<SentReceipt>;
  watch?(mailbox: string, onChange: () => void): Promise<Unsubscribe>; // IDLE / push
}
```

- `MessageRef` is provider-specific and opaque to callers: `{mailbox, uidValidity, uid}` for
  IMAP, `{id}` for Gmail and Resend.
- **Identity across mailboxes.** IMAP UIDs are per mailbox; a Proton archive
  is a move to a new UID. The stable key stays what `src/sync/imap-sync.ts`
  derives today: sha256 of the RFC Message-ID (fallback: size + internal date +
  content hash), now scoped per **account**, not per mailbox, so one message
  has one row and N locations.
- **Proton adapter** = today's `src/sync/imap-port.ts` grown to the full port
  with imapflow: `messageFlagsAdd/Remove/Set`, `messageMove`, `search`, `idle`.
  Bridge (gluon) advertises `IMAP4rev1 UNSELECT UIDPLUS MOVE ID IDLE STARTTLS`
  and **no CONDSTORE/QRESYNC**, so incremental sync stays UID-window based;
  IDLE replaces most polling. Archive/Spam/Trash are real folders with
  special-use attributes; labels appear as `Labels/<name>` folders.
- **Gmail adapter** (Decision 3) is the same IMAP adapter with an app
  password: `imap.gmail.com:993` over TLS, `X-GM-MSGID`/`X-GM-THRID`/
  `X-GM-LABELS`, CONDSTORE and MOVE advertised post-auth — so the adapter
  detects capabilities per account rather than assuming Bridge's set. Labels
  are folders (`[Gmail]/…`), so a move is a label change.
- **Resend adapter** is send + history only; it backs the send log and the
  template test-send.
- The read-only guarantee the README promises today becomes a **capability
  gate**: the client and the API expose flag/move/send actions only when the
  adapter and the decision in §Decisions allow them. Tests keep the fake
  adapters (`src/test/*`); nothing mocks modules.

## Lean store

SQLite, WAL, `${DATA_DIR}/email-gateway.sqlite`, migrations append-only. Rows
keyed by the stable message key. What each table is allowed to hold:

| Table               | Holds                                                                                                                    | Rebuildable from provider? |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `messages`          | key, account, direction, envelope (from, to, cc, subject, date, size, has_attachments), thread key, flags snapshot       | yes                        |
| `message_locations` | key → provider ref (mailbox, uidvalidity, uid / gmail id), last seen at                                                  | yes                        |
| `classifications`   | key → category, priority, action_required, summary, suggested_action, language, facts, model, plus the Jev columns       | no (derived, costs tokens) |
| `body_cache`        | key → html, text, fetched_at; bounded by row count and age, evicted LRU; the reading view's cache, never the truth       | yes                        |
| `send_log`          | one row per outbound send: template id, recipients, provider, provider message id, status/last event, requested by       | no (Resend keeps bodies)   |
| `submissions`       | unchanged: raw form JSON, LLM and Jev verdicts                                                                           | no                         |
| `templates`         | registered template id, name, preview props, last test-send                                                              | partly (code is the truth) |
| `jobs`              | see §Jobs                                                                                                                | n/a                        |
| `accounts`          | provider, address, mailbox list, cursor per mailbox, health (last success / error / warning), secrets **reference** only | yes                        |
| `messages_fts`      | FTS5 over subject, addresses, summary — **not** bodies                                                                   | yes                        |

- Body search runs through `provider.search()`; the FTS covers what the
  store owns. Bridge SEARCH works but lags its index by up to a minute for fresh
  mail; the API says so in the response.
- Today's `emails.html/text` columns and the FTS over `text` are the full
  mirror the vision rules out. What happens to them is Decision 4.
- Envelope metadata is a cache, not a mirror: it is what the inbox list needs
  to sort by "needs me" without an IMAP round trip per row.

## Jobs

`src/db/jev-queue.ts` already has the right semantics: atomic single-row claim
with a token, `complete`/`fail` guarded by that token, backoff
1m→5m→15m→1h→3h→6h→12h→24h, terminal `failed` after nine attempts, stale claims
taken over after 35 min (longer than the 30-min hang guard, so RollHook's
two-container overlap never double-runs). It generalises into one table:

```
jobs(id, kind, subject_key, status, attempts, next_attempt_at,
     claimed_at, claimed_by, payload_json, last_error, created_at, finished_at)
kind ∈ classify | jev_message | jev_submission | send | sync_tick | body_prefetch
status ∈ pending | done | failed        claimed_by = "<hostname>:<pid>"
```

- The enrichment queue (`email_enrichments.status/attempts/claimed_at`, no
  backoff, no token) and the in-memory `syncing`/`running` flags in
  `src/sync/index.ts`, `src/enrich/worker.ts`, `src/jev/worker.ts` all move
  onto it. A sync tick is a job with a lease, so two containers cannot sync at
  once.
- Sends become jobs: the route validates, records `send_log` + a `send` job,
  and returns. The contact-form routes keep their synchronous behaviour
  (caller deadline 7 s at FPP web) by running the first attempt inline and
  falling back to the queue only on provider failure.
- No wall-clock ceilings anywhere; the only liveness rule is the idle
  watchdog on LLM calls (`rules/agent-limits.md`). Research-gateway's
  `idle-watchdog.ts` is the pattern.
- Boot reaps jobs claimed by this host's previous pid (audio-gateway's
  `hostname:pid` pattern); another host's claims expire by staleness.

## Known gaps (Wave 4/5 implementation vs. this design)

Accepted for now — no live caller depends on any of these paths yet (no
client until Wave 6, no MCP until Wave 8, and Gmail itself has no live
caller until the app password lands and Wave 5's own live-verification step
runs) — but real design work, not a bug fix, closes them. Flagged here so a
later wave doesn't rediscover them by surprise.

- **Message identity doesn't survive a mailbox move.** §Provider port's
  "Identity across mailboxes" design keys a message by its RFC Message-ID,
  scoped per account. `src/sync/ingest.ts`'s envelope-only sync can't do that
  yet — envelope `list()` calls carry no Message-ID (only a full body
  `read()` does) — so its message key is scoped per **mailbox**
  (`sha256(account:provider:mailbox:uidValidity:uid)`). A `POST
/messages/:key/move` (`src/api/plugin.ts`) updates the location row
  correctly, but the _next_ sync tick still ingests the moved message under
  its new mailbox+uid as a brand-new key — a second `messages` row (and a
  second `classifications` row) for one physical email. Real fix: re-key by
  the Message-ID once it's known, at classify/read time.
- **Backfill never resumes once "done."** `src/sync/ingest.ts` runs a
  one-page head pass every tick (always the newest page) plus a bounded
  backfill pass that walks backward once and then stops permanently. If a
  mailbox accumulates more new mail between two ticks than fits in one head
  page (`LIST_PAGE_LIMIT`, 500 messages — e.g. the container was down that
  long), the excess older backlog is never picked up: nothing ever resumes a
  finished backfill. Real fix: the head pass itself needs to walk backward
  adaptively (keep paging while it keeps finding unknown messages, stop at
  the first already-known one) instead of always being exactly one page.
- **A CONDSTORE modseq bookmark can advance before its page is durably
  ingested (Wave 5).** `src/providers/imap/provider.ts`'s fast path advances
  its process-local `modseqByMailbox` bookmark as soon as the IMAP FETCH
  succeeds, inside `list()` itself — before `src/sync/ingest.ts`'s
  `ingestPage()` has durably written that page to `mail.sqlite`. If
  `ingestPage()` throws (a DB write failure mid-page), the next tick's
  `changedSince` call starts from the already-advanced bookmark and silently
  skips exactly the messages that failed to persist — never retried. Same
  failure shape as the accepted "one item's enqueueClassify failure" gap
  next to it in `ingest.ts`, one layer lower. Real fix: `list()` returns a
  candidate bookmark alongside the page instead of committing it, and the
  caller (`ingestMailbox`) commits it only after `ingestPage()` succeeds —
  mirroring how the backfill cursor itself is only ever persisted post-ingest.
- **A CONDSTORE fast-path fetch has no upper bound on payload size (Wave
  5).** `src/providers/imap/adapter.ts`'s `makeListChangedSince` issues one
  `FETCH 1:* ... CHANGEDSINCE` and only truncates the _result_ client-side
  (`found.slice(0, limit)`) after everything has already been fetched,
  parsed and sorted — a mailbox that accumulated a very large changed set
  (a long-downtime backlog, a bulk label/flag operation) can pull the whole
  thing into memory in one round trip, unlike every other list path in this
  adapter, which is bounded per FETCH (`LIST_WINDOW`, `MAX_LIST_WINDOWS`).
  IMAP's CONDSTORE extension has no server-side LIMIT, so a real fix needs a
  windowed changedSince strategy (e.g. paging by UID range with `changedSince`
  applied per window), not a client-side slice.
- **A `send` job that exhausts its nine attempts never writes back to
  `send_log` (Wave 7).** `src/jobs/send.ts`'s handler only calls
  `sendLog.recordProviderResult()` on success; a job the runner eventually
  marks terminally `failed` leaves the row's `status` at whatever it was
  (`null` for a fresh row) forever — `listReconcilable` also can't pick it up,
  since it requires `provider_message_id IS NOT NULL`, which a send that
  never reached Resend never gets. The Templates page's send log then shows a
  permanently-failed send as an indistinguishable "queued" badge. Real fix
  needs the job runner to expose a terminal-failure hook a handler can use to
  write domain-specific state, not something specific to `send_log`.
- **A renamed or removed template id leaves an orphaned `templates` row
  (Wave 7).** `syncTemplateRegistry()` only upserts every current
  `emailRegistry` entry on boot; it never deletes a row whose id is no longer
  in the registry. `GET /api/templates` (and the client's list page) reads
  the DB, so a stale row keeps showing up — and then 404s on
  preview/test-send, which resolve against the live registry, not the DB.
  Real fix: prune rows whose id isn't in the current registry as part of the
  same boot-time sync (a delete-then-upsert in one transaction), or have the
  list endpoint read the registry directly instead of the DB.
- **`reconcile_send_log`'s per-call timeout can't cancel the underlying
  request (Wave 7).** `resend@6.28.1`'s `emails.get(id)` takes no options at
  all — no `AbortSignal`, no fetch override — so `src/jobs/reconcile-send-log.ts`'s
  timeout only stops _awaiting_ a hung call; the socket stays open in the
  background past it. Bounded, not unbounded — `RECONCILE_BATCH_LIMIT` (25)
  caps how many can accumulate per 5-minute pass — but a sustained total
  outage to Resend's API would still leak sockets over many hours. Real fix:
  bypass the SDK with a raw, abortable `fetch()` against Resend's REST API for
  this one read, which is more surface than this job's read path has
  warranted so far.
- **`POST /api/templates/:id/test-send`'s three writes aren't atomic
  (Wave 7).** `insertSendLog` → `jobs.enqueue` → `recordTestSend` run as
  separate statements with no rollback; if either of the last two throws, the
  send_log row from the first write is left behind describing a send that
  never happened (and a retry mints a fresh row rather than reusing it).
  Mirrors the same accepted tension in Wave 4's submission-then-Jev-enqueue
  path — not fixed there either, for the same reason: wrapping a
  non-authoritative side effect in the same transaction as the row it
  describes risks rolling back state that's otherwise fine on its own.

## Client

Vite + React + basalt-ui SPA in `client/`, built into `client/dist`, served by
the same Elysia process at `/app`. Pattern: `argo/apps/dashboard` —
`basaltViteConfig` from `basalt-ui/vite`, TanStack Router (file routes) +
TanStack Query, Eden Treaty typed against the Elysia app, `BasaltProvider` with
the `.layer.css` import order.

- **Serving.** `@elysia/static` (1.4.11, the current scope; `@elysiajs/static`
  is the older alias) with `assets: 'client/dist'`, `prefix: '/app'`,
  `alwaysStatic: true`, plus an explicit `/app/*` catch-all returning
  `index.html` — the plugin's `indexHTML` only resolves directory indexes, not
  SPA routes. Hashed assets get long cache headers; `index.html` gets none.
- **Dev.** Vite dev server on its own `.test` port with `server.proxy['/api']`
  to the Elysia port; production is same-origin.
- **Auth.** The browser gets a session: `POST /app/login` with the owner
  password sets a signed, HttpOnly, `SameSite=Strict` cookie (Elysia core
  cookie, no plugin); mutations keep the same-origin check the SSR admin has.
  Agents keep the bearer. No token in `localStorage` — the app renders
  untrusted mail HTML (sandboxed iframe today, kept), so a JS-readable token is
  the wrong shape.
- **Pages, in order of replacement.** Inbox sorted by "needs me" → message
  view (live read through the port, body cache) → submissions → templates
  (preview, test-send, send log per template) → accounts/health. The SSR admin
  is deleted page by page; `/admin` redirects to `/app` once the last page is
  gone.

## Agent API

- **REST `/api/*`** stays the contract Hermes consumes (curl-based skills,
  bearer). It grows: `GET /api/messages?needs_me=1`, `GET /api/messages/:key`
  (live read), `GET /api/threads/:key`, `GET /api/search?q=` (provider search
  - FTS), `POST /api/messages/:key/flags`, `POST /api/messages/:key/move`,
    `POST /api/drafts` (a reply draft: text only until send-as-owner exists),
    `POST /api/sends` (template send, returns the job), `GET /api/jobs/:id`.
    Existing `/api/emails*` endpoints are kept as aliases until Hermes is
    switched, then removed.
- **MCP `/mcp`**: `@modelcontextprotocol/server` 2.0.0 via `createMcpHandler`
  exactly as `research-gateway/src/routes/mcp.ts` does (stateless per request,
  `responseMode: 'sse'`, bearer checked before the handler). Tools mirror the
  REST verbs: `search_mail`, `read_message`, `summarize_thread`, `needs_action`,
  `draft_reply`, `send_template`, `job_status`. Long calls are the exception
  here — reads are short — so `job_wait` exists only for sends.
- Both doors share one service layer; neither talks to SQLite or a provider
  directly.

## Deployment topology

Facts that bound the choice: the send routes must stay public (Vercel, Netlify
and the VPS analytics job call them); Bridge is on the homelab and exposes IMAP
on the tailnet only (no SMTP published — sending as the owner through Bridge
would need `1025` opened on the homelab); the VPS is "the mature always-running
stack" and audio-gateway already runs **tailnet-only on the VPS** through a
DNS-only A record to the VPS Tailscale IP; `/var/lib/email-gateway` has **no
backup** today; RollHook overlaps two containers per deploy.

| Option                                                                         | Pro                                                                                                                           | Con                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. One VPS container, two hostnames** (public send door + tailnet mail door) | One deployable, one SQLite, no homelab dependency added, mail surface never on a public hostname; the audio-gateway precedent | Mail data still lives on the VPS (encrypted disk, needs a backup either way); the app must refuse mail routes on the public Host                             |
| B. Reading side on the homelab, VPS as thin send relay                         | Mail data next to Bridge, off the VPS                                                                                         | Two services, two stores (send log on the VPS, classifications on the homelab), a second deploy path (homelab has no RollHook), Hermes/agents need two doors |

**Recommendation: A.** The split in the vision solves data residency at the
price of two of everything; the tailnet-only door on the VPS gets the security
property (no public hostname for personal mail) with one deployable. Revisit B
only if the mail store must leave the VPS.

Under A: Traefik router `email-gateway.<domain>` (tunnel) → only `/fpp*`,
`/sy-serendipity`, `/health`; router `mail.<domain>` (DNS-only A record →
Tailscale IP) → everything. The app additionally checks `Host` for the mail
surface. Secrets stay in `vps/apps/email-gateway/.env.tpl`; local dev moves from
Doppler to `secrets-run` + `.env.tpl` like the siblings. A nightly
`VACUUM INTO` + rsync of the SQLite file to the homelab closes the backup gap.

## Open decisions → Decisions

Put to the owner in Wave 1; answers recorded verbatim below.

### 1. Where it runs

Options A/B above. Recommendation A.

### 2. How far write access goes

| Stage                                     | Needs                                                                                                           | Recommendation                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Read-only mirror (today)                  | nothing                                                                                                         | baseline                                                                                |
| Flags + moves (read, archive, spam, star) | `SELECT` instead of `EXAMINE`, `messageFlagsAdd`, `messageMove`; Bridge has both                                | **do this** — it is what makes the inbox usable and Hermes's "needs me" list actionable |
| Sending as the owner                      | Bridge SMTP `1025` published on the homelab (homelab change) or Gmail send; From-address enforcement unverified | later, after Gmail; until then a "draft reply" is text the owner pastes                 |

### 3. Gmail access

| Option                  | Pro                                                                                                                                                                      | Con                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IMAP + app password** | Same adapter family as Proton; Gmail IMAP is richer than Bridge (CONDSTORE, MOVE, `X-GM-THRID` threads, `X-GM-LABELS`); no Google Cloud project; one secret in 1Password | App password needs 2SV and dies on password change; no push (IDLE per folder instead); Google calls it "not recommended"                                                                                                                                                                                                                                                                            |
| Gmail REST API + OAuth  | `history.list` deltas, Pub/Sub push, native labels                                                                                                                       | `gmail.readonly/modify` are **restricted** scopes: an External consent screen in _Testing_ expires refresh tokens every **7 days**; _In production_ without verification means the unverified-app screen and, with restricted scopes, a CASA assessment to be verified. Plus a Cloud project, Pub/Sub topic, and `@googleapis/gmail` (maintenance mode, Node-targeted, Bun unverified) or raw fetch |

**Recommendation: IMAP + app password first.** It reuses the IMAP adapter with
capability detection, which is exactly "a new mailbox means a new adapter". The
API earns its place only if push latency or labels-as-labels matter later.

### 4. Today's stored bodies

| Option                                                                   | Pro                                                                    | Con                                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Stop writing bodies now, purge in a later owner-gated step**           | Reversible until the purge; the reading view moves to live reads first | Two schema steps                                                                                |
| Drop `html`/`text` in the same migration that introduces the lean schema | One step                                                               | Irreversible on the VPS the moment it deploys; FTS over bodies vanishes with no live search yet |

**Recommendation: stop writing now, purge later.** Resend outbound bodies are
re-fetchable through `emails.get` while Resend retains them (retention not
verified); the send-log metadata is what we own.

## Decisions

Recorded verbatim from the owner, 2026-09-27. The four questions were put as
option lists with a recommendation each; the owner's answer is quoted, then
what it settles.

### D1 — Where it runs

> One VPS container, two hostnames (Recommended)

Option A. One container on the VPS deployed by RollHook; the public tunnel
hostname serves only the send routes and `/health`; a tailnet-only DNS-only A
record (audio-gateway pattern) serves `/app`, `/api`, `/mcp`. The app refuses
mail-surface requests on the public `Host`. A nightly SQLite backup to the
homelab is part of the topology wave. Option B (homelab reading side) is
closed unless the mail store must leave the VPS.

### D2 — Write access

> Flags + moves, no sending as me yet (Recommended)

The Proton adapter opens mailboxes with `SELECT`, exposes
`messageFlagsAdd/Remove/Set` and `messageMove`; the client and API get mark
read/unread, star, archive, spam, trash. Sending as the owner is out of scope
for this chain: it would need Bridge SMTP `1025` published on the homelab and a
new decision. Hermes's "draft reply" returns text.

### D3 — Gmail access

> Hmm not sure what is better here but also Argo has some stuff build whihc we
> meaybe actually drop there and move to this service, right?

Checked: argo (`apps/api/src/clients/google.ts`, `routes/gmail.ts`,
`routes/oauth.ts`) has a read-only Gmail REST client — raw fetch, no library,
no DB, no tests — sharing one OAuth grant (`gmail.readonly` +
`calendar.readonly`, client in `op://common/google-oauth`) with Calendar; the
refresh token sits in `/var/lib/argo/data/oauth-tokens.json`, the consent
screen is in "Testing", so it expires every 7 days (argo's own AGENTS.md blames
this for recurring 503s). Hermes reads Gmail through `argo-api`
(`skills/argo-api/SKILL.md`, `references/schedule.md`). Put back to the owner
with the two auth paths; the answer:

> IMAP + app password (Recommended)

**Gmail joins through the IMAP adapter with an app password** (2SV on the
Google account; `imap.gmail.com:993`, TLS; secret in 1Password). Argo's Gmail
routes are deleted once email-gateway serves the same reads; argo keeps
Calendar and its OAuth client. Hermes's `argo-api` skill is repointed to
email-gateway's `/api`. The Gmail REST API is closed for this chain.

Wave 5 prepared the argo half as a draft PR:
[jkrumm/argo#20](https://github.com/jkrumm/argo/pull/20) — deletes
`routes/gmail.ts` and the Gmail half of `clients/google.ts`, keeps Calendar +
OAuth, gate green (1038 tests). **Not merged** — merging is an owner gate tied
to email-gateway actually reading Gmail live, which needs the app password
(still pending as of this wave).

### D4 — Today's stored bodies

> Yeah we dont need to build any of this without downtime its only me so we can
> just pause and drop and recreate everything cleanly etc.

Downtime is acceptable and the store is disposable. The lean schema is built
fresh, not migrated: the migration wave stops the service, moves the old SQLite
file aside, creates the new schema and re-syncs from the providers. Nothing is
carried over by default. The Resend send log rebuilds from Resend history; the
one table that cannot be rebuilt is `submissions` (the record of suppressed
contact-form mail) — the migration wave imports it with a one-shot script
because it is cheap, and drops it if it is not. This relaxes "`master` is
deployable at every commit" for the **mail** surface only: the three public
send routes still have third-party callers and must work again the moment the
service is back.

## Constraints the design honours

- **Live callers.** `POST /fpp` (FPP web, 7 s abort), `POST /fpp-daily-analytics`
  (fpp-analytics, 30 s), `POST /sy-serendipity` (Netlify, 10 s): paths, body
  schemas, `SECRET_KEY` bearer and the 2xx-on-suppress behaviour are frozen.
- **Env names** are wired in `vps/apps/email-gateway/compose.yml` and
  `.env.tpl`; `DATA_DIR=/data`, file name `email-gateway.sqlite`, `/health`.
- **Data that exists nowhere else**: `submissions`, the Resend send log rows
  (`provider='resend'`, `source`, `last_event`), classifications and Jev
  decisions. Migrations stay append-only (`user_version` 6 today).
- **IMAP**: STARTTLS, cert pinning (`IMAP_TLS_CERT`), `BODY.PEEK` for reads;
  the 256 MB container drives the 5 MB / 10 MB / 50-message / 500-per-run
  bounds.
- **Two containers, one SQLite** during every deploy — every queue needs a
  claim token and stale takeover.
- **Fail-open gate**: never 500 after delivery; DB errors on the submission
  path are logged, not thrown.

## Research facts this design relies on (2026-09-27)

| Fact                                                                                                       | Source                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Bridge 3.27.0; gluon capabilities `IMAP4rev1 UNSELECT UIDPLUS MOVE ID IDLE STARTTLS`, no CONDSTORE/QRESYNC | ProtonMail/gluon `session.go`        |
| Bridge SMTP is `1025`, STARTTLS, Bridge credentials; the homelab publishes IMAP only                       | `homelab/docs/proton-bridge.md`      |
| imapflow 2.0.8 (repo on 2.0.6): `messageFlagsSet/Add/Remove`, `messageMove`, `search`, `idle`              | imapflow.com                         |
| nodemailer 10.0.11, `tls.rejectUnauthorized:false` + `servername` for an IP host                           | nodemailer.com                       |
| Gmail scopes: `gmail.readonly/modify` restricted, `gmail.send` sensitive; Testing → 7-day refresh tokens   | developers.google.com/identity       |
| Gmail IMAP: app passwords need 2SV, revoked on password change; `X-GM-EXT-1` extensions                    | support.google.com/accounts          |
| Gmail API: `history.list` 404 on stale id → full sync; `users.watch` renew ≤ 7 days                        | developers.google.com/gmail          |
| `@googleapis/gmail` 22.0.1, maintenance mode, `engines.node >=22`, Bun unverified                          | npm                                  |
| Elysia 1.4.30; `@elysia/static` 1.4.11 — `indexHTML` is not an SPA fallback                                | elysia-static tests, issue #22       |
| Vite 8.3.1 (Rolldown); `@elysia/eden` 1.4.10; cookies in Elysia core, `@elysiajs/cookie` dead              | npm, elysiajs.com                    |
| MCP: research-gateway runs `@modelcontextprotocol/server` 2.0.0 `createMcpHandler`, SSE mode               | `research-gateway/src/routes/mcp.ts` |
