# email-gateway maturation

**Goal:** email-gateway is the one door to all of the owner's mail — Proton
(through Bridge) and Gmail read live through provider ports, Resend for app
sends — with a lean derived-data store, durable jobs, a React + basalt-ui client
served by the server, and a typed agent API for Hermes. The architecture it runs
on was settled with the owner in Wave 1, not assumed.

**Gate:** `/check` on this repo (format:check, typecheck, `bun test`, fallow) —
green before any wave closes. `/review` on every wave that changed code.

**Source of direction:** `docs/architecture.md` is authoritative — its
§Decisions are the owner's words (2026-09-27). `docs/vision.md` is the intent
behind it. Nothing after Wave 1 may contradict `docs/architecture.md` without
going back to the owner.

**Models:** Wave 1 ran on Fable (architecture judgment, owner dialogue).
Implementation waves run on the `rd wave` default (Sonnet); the finishing wave
passes `RD_WAVE_MODEL` only if the next wave's header says so. Inside a wave,
settled edits go to `mcp__sideclaw__dispatch` (tier `implement`) or
`@implementer`; the wave agent orchestrates, it does not grind.

**Hard lines for every wave:** production runs on the VPS (RollHook deploys on
every push to `master`), so every push ships. `/fpp`, `/fpp-daily-analytics` and
`/sy-serendipity` have third-party callers (FPP web on Vercel, fpp-analytics on
the VPS, sy-serendipity on Netlify) and must work at every commit. The **mail**
surface may pause (Decision D4: "only me", downtime is fine, the store is
disposable) — but a wave never deletes the old SQLite file, never publishes a
hostname, never edits another repo's deploy path: those are outward-facing
steps that stop and hand back. Every wave reads `AGENTS.md` first and updates
it plus `README.md` in the same commit as the code it describes.

## Wave 1 — Architecture, settled with the owner <!-- status: done -->

- [x] Read `docs/vision.md`, `README.md`, and the code map (`src/sync`,
      `src/db`, `src/enrich`, `src/jev`, `src/spam`, `src/admin`, `src/api`) via
      `Explore`. Read the sibling gateways for house patterns
      (`~/SourceRoot/research-gateway`, `~/SourceRoot/audio-gateway`: AGENTS.md,
      job queue, production layout) and `~/SourceRoot/dotfiles/docs/architecture.md`.
- [x] Draft `docs/architecture.md`: the provider port (list/read/search/flag/send
      over Bridge IMAP/SMTP, Gmail, Resend), the lean store (what is persisted,
      keyed how, what is only cached), the job model (generalise the Jev queue),
      the client (Vite SPA served by Elysia, auth), the agent API (REST and/or
      MCP), and the deployment topology. Each open decision gets 2 options with
      tradeoffs and a recommendation. Use `/research` for Gmail API / Bridge /
      library facts — never from memory.
- [x] Put the open decisions to the owner **in this pane**, batched into one
      message of at most four questions, each with a recommendation. At minimum:
      where it runs (homelab reading side + VPS send relay vs. one VPS service),
      read-only mirror vs. flags/moves vs. sending as the owner, Gmail API vs.
      IMAP, and what happens to the full bodies already in SQLite. Wait for the
      answers; record them verbatim in `docs/architecture.md` §Decisions.
- [x] Add `AGENTS.md` (+ `CLAUDE.md` = `@AGENTS.md` shim) for this repo, matching
      the sibling gateways: purpose, stack, commands, env, production setup, the
      architecture link. Keep it dense.
- [x] Rewrite Waves 2+ below into concrete waves (3–6 steps each) that follow
      the settled architecture.
      **Left behind:** `docs/architecture.md` with D1–D4 verbatim (one VPS
      container with a public send door and a tailnet mail door; flags + moves,
      no send-as-owner; Gmail via IMAP + app password, argo's Gmail moves here;
      fresh store, downtime OK, old file left aside for the owner to delete).
      `AGENTS.md`/`CLAUDE.md` describe today. No code changed. Research facts
      (versions, Bridge/Gmail capabilities) are tabled at the end of
      `docs/architecture.md`; waves cite them instead of re-researching. Known
      gaps for later waves: no VPS backup of `/var/lib/email-gateway`; local dev
      still on Doppler; `imapflow` 2.0.6 → 2.0.8 pending; the enrichment queue
      has no token/backoff; fpp-analytics env-name drift (`BEA_*` vs
      `EMAIL_GATEWAY_*`) unverified in prod.

## Wave 2 — Provider port + Proton and Resend adapters <!-- status: active -->

Follows `docs/architecture.md` §Provider port and D2. No schema change, no
behaviour change for callers: the existing sync keeps working behind the port.

- [ ] Add `src/providers/port.ts`: `MailProvider`, `Capabilities`, `MessageRef`,
      `Envelope`, `Message`, `SearchQuery`, `FlagChange`, `OutboundDraft`,
      `SentReceipt`, `Mailbox`, `Page`/`Cursor`, exactly as sketched in
      `docs/architecture.md` (adjust names only if a type is unrepresentable).
      Capabilities are declared per adapter instance, never assumed.
- [ ] Grow `src/sync/imap-port.ts` into `src/providers/imap/` (adapter +
      config): keep STARTTLS, cert pinning, timeouts, `BODY.PEEK` reads and the
      batch/size bounds; add `capabilities()` from the server's CAPABILITY
      response, `listMailboxes()` (special-use attributes), `list()` (UID
      windows, newest first), `read()`, `search()` (imapflow `search` — `body`
      / `text` / `from` / `since` keys), `setFlags()` (`messageFlagsAdd/Remove/Set`),
      `move()` (`messageMove`), `watch()` (`idle`). Mailboxes open with
      `SELECT` only when a write is requested. Bump `imapflow` to 2.0.8 (pin
      exact). Bridge advertises no CONDSTORE — do not depend on it.
- [ ] Add `src/providers/resend/`: `send()` (wrapping `src/utils/send-mail.ts` + `src/utils/resend.ts`) and the history reads `src/sync/resend-sync.ts`
      uses; capabilities `{ send, list }` only.
- [ ] Fakes in `src/test/`: an in-memory `MailProvider` for both adapters
      (replacing `createFakeImap`), tests through the port only; the imapflow
      adapter keeps its fake-client tests for the wire details.
- [ ] Route `src/sync/imap-sync.ts` through the IMAP adapter's `list()`/`read()`
      with byte-identical stored rows (existing tests prove it). Update
      `AGENTS.md` (file map, invariants: "read-only" becomes "writes only through
      the port's flag/move") and `README.md` §IMAP ingest.
      **Left behind:**

## Wave 3 — One job table <!-- status: pending -->

Follows §Jobs. Existing schema stays; only queue state moves.

- [ ] Migration: `jobs` table (id, kind, subject_key, status, attempts,
      next_attempt_at, claimed_at, claimed_by, payload_json, last_error,
      created_at, finished_at) + indexes; `src/db/jobs.ts` generalised from
      `src/db/jev-queue.ts` (same claim-token, backoff ladder, 35-min stale
      takeover, nine attempts) with `claimed_by = "<hostname>:<pid>"` and a
      boot reap of this host's stale claims.
- [ ] `src/jobs/runner.ts`: one loop, kinds registered as handlers; idle
      watchdog on LLM calls modelled on `research-gateway/src/lib/idle-watchdog.ts`
      (no wall clock, per `rules/agent-limits.md`).
- [ ] Move enrichment (`classify`), both Jev queues (`jev_message`,
      `jev_submission`) and the sync tick (`sync_tick`, a leased job so two
      containers never sync at once) onto it; delete the in-memory locks in
      `src/sync/index.ts`, `src/enrich/worker.ts`, `src/jev/worker.ts` and the
      enrichment column-queue in `src/db/emails.ts`. `POST /api/sync` enqueues
      and returns the job id (409 stays while a tick holds the lease).
- [ ] Sends as `send` jobs: the contact-form routes run the first attempt inline
      (caller deadline) and enqueue only on provider failure; `GET /api/jobs/:id`.
- [ ] `/api/stats` reports the queue by kind; README §Jev shadow mode → §Jobs;
      `AGENTS.md` invariants updated (the "two containers, one SQLite" rule now
      points at `src/db/jobs.ts`).
      **Left behind:**

## Wave 4 — Lean store cutover <!-- status: pending -->

Follows §Lean store and D4. The new store is a **new file**
`${DATA_DIR}/mail.sqlite` with its own migrations from version 1; the old
`email-gateway.sqlite` is left untouched for the owner to delete (that deletion
is outward-facing, never done by a wave). The SSR admin's mail pages go away
here; the API stays up. One wave of no inbox UI is accepted (D4).

- [ ] Schema per the §Lean store table: `accounts`, `messages`,
      `message_locations`, `classifications` (LLM + Jev columns),
      `body_cache` (bounded, LRU by `fetched_at`), `send_log`, `submissions`,
      `templates`, `jobs`, `messages_fts` (subject, addresses, summary — no
      bodies). Stable message key = sha256(Message-ID) scoped per account,
      fallback as today.
- [ ] Ingest through the port: envelope-only sync into `messages` +
      `message_locations` with a flags snapshot; IDLE (`watch()`) kicks a tick;
      classification jobs fetch the body live via `read()`, never from the
      store; `body_cache` fills on read and on a `body_prefetch` job for
      "needs me" rows.
- [ ] API v2 on the new tables: `GET /api/messages?needs_me=1`,
      `GET /api/messages/:key` (live read + cache), `GET /api/threads/:key`,
      `GET /api/search?q=` (provider `search()` + FTS, response says which),
      `POST /api/messages/:key/flags`, `POST /api/messages/:key/move`,
      `GET /api/submissions`, `GET /api/stats`. Keep `GET /api/emails*` as
      aliases over the new tables until Wave 7 repoints Hermes.
- [ ] `scripts/import-legacy.ts`: one-shot copy of `submissions` (and nothing
      else) from `email-gateway.sqlite` into `mail.sqlite`; the Resend send log
      rebuilds from Resend history on first sync.
- [ ] Remove the SSR admin's Overview/Inbox/detail pages and their tests; keep
      Submissions and Templates (they do not touch mail tables) until Wave 5.
      README §Storage/§Sync/§API rewritten; `AGENTS.md` file map, invariants
      ("rows are insert-only" → "bodies are never stored").
      **Left behind:**

## Wave 5 — Client shell <!-- status: pending -->

Follows §Client. Pattern: `argo/apps/dashboard` + the basalt-ui consumer rules
in `~/.claude/CLAUDE.md`. Vite 8, `@elysia/static` 1.4.11, `@elysia/eden`
1.4.10 (research table in `docs/architecture.md`; re-verify with `/research`
before pinning).

- [ ] `client/` Vite + React + basalt-ui app: `basaltViteConfig` from
      `basalt-ui/vite`, TanStack Router (file routes) + TanStack Query, Eden
      Treaty typed against the Elysia app, `BasaltProvider` with the
      `.layer.css` import order; a `.test` port in `dotfiles/config/Caddyfile`
      (own commit there is outward-facing → note it, do not push dotfiles).
- [ ] Serve `client/dist` from Elysia at `/app` (`@elysia/static`,
      `alwaysStatic`, explicit `/app/*` catch-all → `index.html`; hashed assets
      long-cached, `index.html` not); Dockerfile gains the client build stage.
- [ ] Session auth: `POST /app/login` with `ADMIN_PASSWORD` → signed HttpOnly
      `SameSite=Strict` cookie (Elysia core cookie), same-origin check on
      mutations, logout; `/api` and later `/mcp` stay bearer.
- [ ] Pages: Inbox sorted by "needs me" (category, priority, action_required,
      unread) with filters; Message view (live read, sandboxed HTML iframe,
      classification panel, mark read/unread, star, archive, spam, trash via
      the flag/move endpoints); Submissions; Accounts/health (sync state,
      queue by kind, IMAP health).
- [ ] Delete the remaining SSR admin (`src/admin/`), `/admin` → 302 `/app`;
      README §Admin UI → §Client; `AGENTS.md` stack + file map.
      **Left behind:**

## Wave 6 — Templates and the send log <!-- status: pending -->

- [ ] `templates` table seeded from `src/emails/registry.ts` (id, name, preview
      props); the routes' `source` ids come from the registry, not hand-typed
      strings (drift test).
- [ ] `send_log` rows for every send (template id, recipients, provider id,
      status/last event, requested by: route / test-send / agent), filled in
      by Resend history sync.
- [ ] `POST /api/templates/:id/test-send` (to the owner's address, `send` job);
      `GET /api/templates`, `GET /api/templates/:id/preview?width=`.
- [ ] Client pages: Templates (preview at 375/600, test-send) and Send log per
      template; README §Endpoints/§Templates; `AGENTS.md` file map.
      **Left behind:**

## Wave 7 — Agent API: REST v2 complete + MCP + Hermes <!-- status: pending -->

Follows §Agent API. `@modelcontextprotocol/server` 2.0.0 via `createMcpHandler`
exactly as `research-gateway/src/routes/mcp.ts`.

- [ ] Finish REST v2: `GET /api/threads/:key/summary` (LLM job, cached on the
      thread), `POST /api/drafts` (reply draft as text — D2: no send-as-owner),
      `POST /api/sends` (template send → job), `GET /api/needs-action`.
- [ ] `/mcp`: tools `search_mail`, `read_message`, `summarize_thread`,
      `needs_action`, `draft_reply`, `send_template`, `job_status`; bearer
      checked before the handler; stateless, `responseMode: 'sse'`.
- [ ] Remove the `/api/emails*` aliases; `docs/agent-api.md` for Hermes
      (curl examples, the MCP client config) modelled on research-gateway's
      README "Clients" section.
- [ ] Prepare the Hermes repoint: a ready-to-apply patch for
      `hermes-agent/skills/argo-api/SKILL.md` + `references/schedule.md` (Gmail
      reads → email-gateway) written to `docs/hermes-repoint.patch`. Applying it
      in `hermes-agent` is outward-facing → hand back.
      **Left behind:**

## Wave 8 — Gmail through the IMAP adapter <!-- status: pending -->

Follows D3. Gmail IMAP facts are in the `docs/architecture.md` research table;
verify the authenticated CAPABILITY line at runtime, never assume it.

- [ ] Multi-account config: `accounts` rows from env (`MAIL_ACCOUNTS` JSON or
      per-account `GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD` — pick one, document
      it) with secrets referenced, never stored; `/health` and the Accounts page
      list every account.
- [ ] IMAP adapter capability detection per account: CONDSTORE `changedSince`
      fast path when advertised (Gmail), UID-window fallback (Bridge);
      `X-GM-THRID` as the thread key and `X-GM-LABELS` as labels when
      `X-GM-EXT-1` is present; `[Gmail]/…` folder mapping for archive/spam/trash.
- [ ] Sync + classification + client for the second account end to end; the
      inbox merges accounts with an account chip; fakes cover the Gmail
      capability set.
- [ ] Prepare argo's retirement of its Gmail routes: a patch for
      `argo/apps/api` (delete `routes/gmail.ts`, the Gmail half of
      `clients/google.ts`, keep Calendar + OAuth) in `docs/argo-gmail-retire.patch`.
      Applying it deploys argo → outward-facing, hand back.
      **Left behind:**

## Wave 9 — Topology cutover <!-- status: pending -->

Follows D1. Every step here touches production or another repo's deploy path:
**prepare everything, verify locally, then hand back to the owner** — no push
outside this repo, no hostname published by a wave.

- [ ] In this repo: `MAIL_HOST` env (the tailnet hostname); the app serves
      `/app`, `/api`, `/mcp` only when `Host` matches it and serves the send
      routes + `/health` on any host; tests for both doors.
- [ ] Local dev off Doppler: `.env.tpl` + `secrets-run` like the siblings,
      `make dev/check/…` Makefile, `doppler.yaml` deleted; README §Local
      Development.
- [ ] Backup: `scripts/backup.sh` (`VACUUM INTO` + rsync to the homelab backup
      target, warden's pattern) and the cron entry as a ready-to-apply snippet
      for the `vps` repo.
- [ ] Ready-to-apply changes for `vps/apps/email-gateway/compose.yml` (second
      Traefik router on the tailnet hostname, `MAIL_HOST`, the DNS-only A
      record note) and `.env.tpl` (Gmail secrets, `RESEND_ADMIN_API_KEY`,
      `IMAP_TLS_CERT`) written to `docs/vps-cutover.md`, plus the owner's
      checklist: apply, deploy, delete `email-gateway.sqlite`, revoke argo's
      Gmail scope.
      **Left behind:**
