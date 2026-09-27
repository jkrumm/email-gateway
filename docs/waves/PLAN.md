# email-gateway maturation

**Goal:** email-gateway is the one door to all of the owner's mail — Proton
(through Bridge) and Gmail read live through provider ports, Resend for app
sends — with a lean derived-data store, durable jobs, a React + basalt-ui client
served by the server, and a typed agent API for Hermes. The architecture it runs
on was settled with the owner in Wave 1, not assumed.

**Gate:** `/check` on this repo (format:check, typecheck, `bun test`, fallow) —
green before any wave closes. `/review` on every wave that changed code.

**Source of direction:** `docs/vision.md`. The owner's own words are the
authority: _stay lean, don't replicate; Proton/Bridge and Gmail stay the source
of truth; unsure about the future, maybe homelab for reading and the VPS "just
as a server"._ Wave 1 turns that into decisions; nothing after Wave 1 may
contradict `docs/architecture.md` without going back to the owner.

**Models:** Wave 1 runs on Fable (architecture judgment, owner dialogue) —
spawned with `RD_WAVE_MODEL=fable`. Implementation waves run on the `rd wave`
default (Sonnet); the finishing wave passes `RD_WAVE_MODEL` only if the next
wave's header says so. Inside a wave, settled edits go to
`mcp__sideclaw__dispatch` (tier `implement`) or `@implementer`; the wave agent
orchestrates, it does not grind.

**Hard lines for every wave:** production runs on the VPS today
(RollHook deploys on every push to `master`), so every push ships. Keep `master`
deployable at every commit: `/fpp`, `/fpp-daily-analytics` and
`/sy-serendipity` are live callers (FPP web on Vercel, fpp-analytics on the VPS,
sy-serendipity on Netlify) and must keep working. Destructive data changes (dropping
stored mail bodies, moving the SQLite file, changing hosting) are outward-facing
steps: stop and hand back to the owner.

## Wave 1 — Architecture, settled with the owner <!-- status: active -->

- [ ] Read `docs/vision.md`, `README.md`, and the code map (`src/sync`,
      `src/db`, `src/enrich`, `src/jev`, `src/spam`, `src/admin`, `src/api`) via
      `Explore`. Read the sibling gateways for house patterns
      (`~/SourceRoot/research-gateway`, `~/SourceRoot/audio-gateway`: AGENTS.md,
      job queue, deploy shape) and `~/SourceRoot/dotfiles/docs/architecture.md`.
- [ ] Draft `docs/architecture.md`: the provider port (list/read/search/flag/send
      over Bridge IMAP/SMTP, Gmail, Resend), the lean store (what is persisted,
      keyed how, what is only cached), the job model (generalise the Jev queue),
      the client (Vite SPA served by Elysia, auth), the agent API (REST and/or
      MCP), and the deployment topology. Each open decision gets 2 options with
      tradeoffs and a recommendation. Use `/research` for Gmail API / Bridge /
      library facts — never from memory.
- [ ] Put the open decisions to the owner **in this pane**, batched into one
      message of at most four questions, each with a recommendation. At minimum:
      where it runs (homelab reading side + VPS send relay vs. one VPS service),
      read-only mirror vs. flags/moves vs. sending as the owner, Gmail API vs.
      IMAP, and what happens to the full bodies already in SQLite. Wait for the
      answers; record them verbatim in `docs/architecture.md` §Decisions.
- [ ] Add `AGENTS.md` (+ `CLAUDE.md` = `@AGENTS.md` shim) for this repo, matching
      the sibling gateways: purpose, stack, commands, env, deploy, the
      architecture link. Keep it dense.
- [ ] Rewrite Waves 2+ below into concrete waves (3–6 steps each) that follow
      the settled architecture. The provisional outline below is a starting
      point, not a contract — reorder, split, merge or drop freely.
      **Left behind:**

## Wave 2 — Provider port + Proton adapter <!-- status: pending -->

_Provisional._ Extract a provider interface from `src/sync/imap-*`; Proton via
Bridge implements it; live read/search endpoints go through it; the existing
sync keeps working behind it.

## Wave 3 — Lean store + durable jobs <!-- status: pending -->

_Provisional._ Derived-data schema keyed by provider message ID; a generic job
table modelled on `src/db/jev-queue.ts` for classification, Jev and sends;
migration plan for today's stored bodies (the drop itself is an owner-gated
step).

## Wave 4 — Client shell <!-- status: pending -->

_Provisional._ Vite + React + basalt-ui SPA served by Elysia (follow
`argo/apps/dashboard` and the basalt-ui consumer rules); auth; inbox list
sorted by "needs me"; replaces the SSR admin page by page.

## Wave 5 — Reading view + templates <!-- status: pending -->

_Provisional._ Thread/detail view reading live through the provider port;
template management (preview, test-send, send log per template).

## Wave 6 — Gmail adapter <!-- status: pending -->

_Provisional._ Second provider behind the same port; OAuth/secrets through
1Password per the settled decision.

## Wave 7 — Agent API <!-- status: pending -->

_Provisional._ Typed endpoints (and MCP if decided) for Hermes: search, read,
summarize thread, needs-action list, draft reply; document for Hermes.

## Wave 8 — Topology cutover <!-- status: pending -->

_Provisional, owner-gated._ Move to the settled deployment topology (e.g. the
reading side on the homelab next to Bridge, the VPS as the public send relay).
Every step here is outward-facing — prepare, then hand back to the owner.
