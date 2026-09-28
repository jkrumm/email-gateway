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

## Wave 2 — Provider port + Proton and Resend adapters <!-- status: done -->

Follows `docs/architecture.md` §Provider port and D2. No schema change, no
behaviour change for callers: the existing sync keeps working behind the port.

- [x] Add `src/providers/port.ts`: `MailProvider`, `Capabilities`, `MessageRef`,
      `Envelope`, `Message`, `SearchQuery`, `FlagChange`, `OutboundDraft`,
      `SentReceipt`, `Mailbox`, `Page`/`Cursor`, exactly as sketched in
      `docs/architecture.md` (adjust names only if a type is unrepresentable).
      Capabilities are declared per adapter instance, never assumed.
- [x] Grow `src/sync/imap-port.ts` into `src/providers/imap/` (adapter +
      config): keep STARTTLS, cert pinning, timeouts, `BODY.PEEK` reads and the
      batch/size bounds; add `capabilities()` from the server's CAPABILITY
      response, `listMailboxes()` (special-use attributes), `list()` (UID
      windows, newest first), `read()`, `search()` (imapflow `search` — `body`
      / `text` / `from` / `since` keys), `setFlags()` (`messageFlagsAdd/Remove/Set`),
      `move()` (`messageMove`), `watch()` (`idle`). Mailboxes open with
      `SELECT` only when a write is requested. Bump `imapflow` to 2.0.8 (pin
      exact). Bridge advertises no CONDSTORE — do not depend on it.
- [x] Add `src/providers/resend/`: `send()` (wrapping `src/utils/send-mail.ts` + `src/utils/resend.ts`) and the history reads `src/sync/resend-sync.ts`
      uses; capabilities `{ send, list }` only.
- [x] Fakes in `src/test/`: an in-memory `MailProvider` for both adapters
      (replacing `createFakeImap`), tests through the port only; the imapflow
      adapter keeps its fake-client tests for the wire details.
- [x] Relocate `src/sync/imap-sync.ts`'s low-level dependency from
      `src/sync/imap-port.ts` to `src/providers/imap/adapter.ts`, with
      byte-identical stored rows and behaviour (existing tests prove it) —
      **not** a migration onto the generic `list()`/`read()` port, which
      would lose the batched multi-UID FETCH the 256 MB container depends on;
      see **Left behind**. Update `AGENTS.md` (file map, invariants:
      "read-only" becomes "writes only through the port's flag/move") and
      `README.md` §IMAP ingest.
      **Left behind:** `src/providers/port.ts` (`MailProvider` + friends,
      `MessageRef`'s IMAP variant carries `account` so two same-kind adapter
      instances — e.g. two Gmail accounts, Wave 8 — can't accept each other's
      refs); `src/providers/imap/adapter.ts` (low-level session/mailbox
      primitives, unchanged behaviour — `src/sync/imap-sync.ts` still consumes
      these directly, not the generic `list()`/`read()`, since the sync
      algorithm's batched multi-UID FETCH, oversized-headers-only and
      held-message-retry semantics don't map onto the generic port's
      per-message shape without losing the 256 MB container's batching; the
      generic wrapper is additive, not yet wired into sync — nothing in this
      repo calls it outside tests) + `src/providers/imap/provider.ts`
      (`createImapProvider`: UIDVALIDITY + cross-account ref checks before any
      mailbox I/O, `readOnly` SELECT-gating for `setFlags`/`move` — omitted
      from the handle entirely rather than merely checked, `move()` refuses to
      call `messageMove` at all without both MOVE and UIDPLUS so a message is
      never relocated without a way to name it in the destination, `list()`
      cursors encode `uidValidity:uid` and reject a cursor from a recreated
      mailbox, a bounded window-scan budget so a sparse/huge mailbox can't
      turn one page into an unbounded FETCH loop) + `config.ts`;
      `src/providers/imap/address.ts` (shared to/cc address-list mapping) +
      `src/providers/resend/` (`adapter.ts` + `client.ts` — `ResendClient`
      moved out of the deleted `admin/types.ts` so `providers/` depends on
      nothing in `admin/` or `sync/`); `src/utils/date.ts` gained
      `toIsoTimestamp` (moved out of `resend-sync.ts`, now shared with the
      Resend provider so `Envelope.date` is the same ISO shape from either
      provider, fixed to force UTC on a value with no timezone designator and
      to never mistake a date-only value's day-of-month for one).
      `sendMail()` is now injectable (`resendClient`/`emails` params,
      defaulting to the singletons) and returns `{ id, from }` instead of
      `void`, tested directly for the first time. `imapflow` stays pinned at
      2.0.6 — the bump to 2.0.8 is blocked by the repo's `minimumReleaseAge`
      cooldown (259200 s); revisit after 2026-10-01 or get an explicit owner
      override. `watch()` (IDLE) is deliberately unimplemented — `capabilities()`
      always reports `idle: false` regardless of what the server advertises,
      since `disableAutoIdle: true` is load-bearing for the sync tick and a
      real IDLE loop needs its own connection lifecycle; Wave 4 is the first
      wave that actually calls it, so it implements and verifies IDLE against
      a live connection there instead of shipping an untested stub now.
      `/review` (sideclaw) ran eight rounds against this diff — each found a
      genuinely real bug or a legitimate gap (stale/cross-account IMAP refs,
      `move()`'s destination UIDVALIDITY, a Resend-vs-IMAP date-format
      mismatch, `sendMail` silently bypassing its injected client, an
      unbounded pagination scan, a cursor that couldn't express "empty page,
      but still more below", a shallow attachment-tree check, `read()` not
      running its Date header through the same validation `list()` does) —
      all fixed, each with a regression test; `/check` and the eighth
      `/review` pass are both green. Still open, judged not worth another
      round: per-call IMAP session creation on `list`/`read`/`search`/
      `setFlags`/`move` has no pooling (fine — nothing calls these outside
      tests yet; decide a pooling strategy before Wave 4+ exposes them behind
      a route); `resend-sync.ts`'s pre-existing `syncOutbound`/`syncInbound`
      duplication and complexity (fallow-flagged, present before this wave,
      untouched by this diff's logic — only its `toIsoTimestamp` import
      moved); the three unused `@fontsource-variable/*` deps (pre-existing,
      unrelated to mail).

## Wave 3 — Jobs module, schema-neutral <!-- status: done -->

Follows §Jobs, narrowed per the 2026-09-28 validation: the `jobs` table is
**not** a migration on the live `email-gateway.sqlite` — it would live for
exactly one wave and risks a prod deploy running a double queue mid-cutover.
This wave ships the module and proves it against an in-memory database only;
Wave 4 is the first wave that creates the table for real, in its fresh schema,
and is also where every consumer (enrichment, both Jev queues, the sync tick,
sends) actually moves onto it.

- [x] `src/db/jobs.ts` generalised from `src/db/jev-queue.ts` (same claim-token,
      backoff ladder, 35-min stale takeover, nine attempts), generic over
      `kind`/`subject_key`/`payload_json`. The module owns its own
      `CREATE TABLE IF NOT EXISTS jobs (...)` DDL and issues it against
      whatever `Database` it is given — it is **not** registered in
      `src/db/migrations.ts` and never runs against
      `${DATA_DIR}/email-gateway.sqlite`. `claimed_by = "<hostname>:<pid>"`
      and a boot reap of this host's stale claims. Backoff carries jitter
      (up to +20%) so a burst failing in lockstep doesn't re-batch on the
      same `next_attempt_at`; `fail()` also takes a `rateLimited` flag that
      parks and reschedules on the first backoff rung **without** spending
      one of the nine attempts — root-caused during this wave (2026-09-28
      delivery-lead investigation): `src/db/jev-queue.ts`'s current
      all-failures-count-an-attempt semantics let a 429 burst burn 17
      submissions to `jev_attempts=8` in 24h. The caller decides what counts
      as rate-limited; jobs.ts stays domain-agnostic.
- [x] `src/llm/jev.ts`: set `maxRetries: 0` on the `evaluate()` call — the
      durable queue owns retries, so the AI SDK's own default (2 retries, 3
      HTTP requests per judge attempt) was tripling the request volume a 429
      burst produced. Live fix, independent of the jobs module cutover.
- [x] `src/jobs/runner.ts`: one loop, kinds registered as handlers; idle
      watchdog on LLM calls modelled on `research-gateway/src/lib/idle-watchdog.ts`
      (no wall clock, per `rules/agent-limits.md`).
- [x] Tests only, against `openDatabase(":memory:")` running the module's own
      DDL: claim/complete/fail, backoff ladder to terminal `failed`, stale
      takeover, boot reap, runner dispatch by kind, jitter bounds, and
      `rateLimited` never spending an attempt regardless of how many times it
      recurs; `src/llm/jev.test.ts` covers `maxRetries: 0` the only way it's
      observable — a rejecting fake model is called exactly once.
- [x] README/`AGENTS.md`: note the jobs module exists and is tested but not yet
      wired to any consumer or to the production schema; point the "two
      containers, one SQLite" invariant at `src/db/jobs.ts` for the future —
      today's queues (`src/db/jev-queue.ts`, the enrichment column-queue, the
      in-memory sync lock) stay authoritative until Wave 4 cuts them over.
      README §Jev shadow mode gets a line on the `maxRetries: 0` fix and the
      429 incident.
      **Left behind:** `/review` ran four rounds against this diff.
      Genuinely real bugs it caught, each fixed with a regression test: a
      completion-write failure retrying already-succeeded work (the write
      moved outside the handler's own try/catch, mirroring
      `src/jev/worker.ts`'s `drainQueue`); claims never renewed, so any
      handler outliving `JOB_STALE_CLAIM_MS` lost its claim mid-run (added
      `renewClaim` + a runner-side lease-renewal interval); a single corrupt
      `payload_json` row aborting an entire drain pass (parsing moved inside
      `claimNext`'s own guarded loop); `next_attempt_at`/`finished_at`
      computed from claim time instead of actual completion time for a
      long-running handler (the post-handler write now reads a fresh clock);
      every DB write in the runner left unguarded against `SQLITE_BUSY`
      during the documented two-container deploy overlap (renewal, fail,
      complete, and the corrupt-payload fail are all try/catch, log-and-
      continue now); `claimNext({ kinds: [] })` silently matching any kind
      instead of none; a missing `renewIntervalMs` sanity check against
      `JOB_STALE_CLAIM_MS`; the idle watchdog not arming until the caller's
      first `arm()` call, missing a hang before any progress signal.
      `src/jobs/runner.ts`'s `runOnce` grew complex enough from these guards
      that fallow flagged it (cyclomatic 10, 96 lines) — extracted
      `startClaimRenewal`/`recordOutcome`/`claimForHandlers` as named helpers,
      no behaviour change, complexity finding cleared. One finding
      (`escapeLikePattern` allegedly not escaping its matched character) was
      raised by three separate review rounds and is **false** — verified
      directly against `bun:sqlite` with a real `LIKE ... ESCAPE` query
      matching only the intended rows; kept as-is. Still open, judged
      Wave-4-scoped rather than Wave-3 bugs: splitting the pure backoff/jitter
      functions into their own module ahead of the `jev-queue.ts` dedup;
      typing job payloads per kind (zod is already in the stack); whether a
      permanently rate-limited job should ever escalate past its 1-minute
      floor; and `reapOwnStaleClaims`'s hostname-only matching, which is why
      Wave 4's header below makes hostname uniqueness a named prerequisite.

## Wave 4 — Lean store cutover <!-- status: done -->

Follows §Lean store and D4. The new store is a **new file**
`${DATA_DIR}/mail.sqlite` with its own migrations from version 1; the old
`email-gateway.sqlite` is left untouched for the owner to delete (that deletion
is outward-facing, never done by a wave). The SSR admin's mail pages go away
here; the API stays up. One wave of no inbox UI is accepted (D4).

**Before any code in this wave:** three things carried over from Wave 2's
"left open" list and Wave 3's `/review` must be settled — this wave is the
first to put IMAP reads behind a route and the first to actually boot
`src/db/jobs.ts`'s reap-on-boot against a real deploy, and all three are
load-bearing for that:

1. **IMAP session pooling strategy.** Today `list`/`read`/`search`/`setFlags`/
   `move` each open a session per call (Wave 2, deliberate — nothing called
   them outside tests yet). A route calling these per-request risks Bridge's
   connection limit. Decide and verify a pooling/reuse approach before wiring
   the API v2 routes below.
2. **`watch()` / IDLE.** Deliberately unimplemented in Wave 2
   (`capabilities()` always reports `idle: false`). This wave is the first
   caller — implement and verify a real IDLE loop against a live Bridge
   connection (own connection lifecycle; `disableAutoIdle: true` stays
   load-bearing for the sync tick's own connection) before relying on it to
   kick ticks. **How to reach Bridge (verified 2026-09-28):** the tailnet ACL
   grants only VPS → homelab `tcp:1143`; the mini cannot connect, and the
   homelab host does not expose the port on localhost either. Verify from
   inside the running production container instead: `ssh vps`, then
   `docker cp` a read-only probe script (EXAMINE + IDLE, or the pooling
   scenario) into the container and run it with `docker exec … bun <script>`
   — the container carries bun 1.4.2, the source at `/app`, and the IMAP env
   already set. Never print or persist the credentials; the probe is
   read-only and runs against the live inbox.
3. **Hostname uniqueness across a RollHook deploy overlap.** `src/db/jobs.ts`'s
   `reapOwnStaleClaims` matches `claimed_by` by hostname prefix with no
   claim-age check, so it can only run once at boot. If the old and new
   container during the brief two-container overlap share the same hostname
   (rather than Docker's default per-container random id), the new
   container's boot reap would release the still-draining old container's
   claims immediately — a second worker could then pick up a row mid-handler.
   **Verified 2026-09-28:** `vps/apps/email-gateway/compose.yml` sets no
   `hostname:`, so each container's hostname is Docker's per-container id
   (the running one reports a 12-hex id) — distinct across the overlap, the
   hostname-prefix reap is safe as written. Leave a one-line note next to
   `reapOwnStaleClaims` that this assumption holds only while compose sets
   no `hostname:`.

Also in scope: bump `imapflow` 2.0.6 → 2.0.8 (pin exact) — the
`minimumReleaseAge` cooldown on 2.0.8 lifts 2026-09-30, no owner override
needed; do this once the cooldown has actually lifted, not before.

- [x] Schema per the §Lean store table: `accounts`, `messages`,
      `message_locations`, `classifications` (LLM + Jev columns),
      `body_cache` (bounded, LRU by `fetched_at`), `send_log`, `submissions`,
      `templates`, `jobs` (real migration this time — `src/db/jobs.ts` from
      Wave 3 runs its DDL against `mail.sqlite`), `messages_fts` (subject,
      addresses, summary — no bodies). Stable message key = sha256(Message-ID)
      scoped per account, fallback as today.
- [x] Rate-limit signal from handler to queue: `src/jobs/runner.ts`'s `runOnce`
      always calls `fail()` without `rateLimited`, so no handler can reach
      Wave 3's park-without-spending-an-attempt path yet. Add a typed signal
      (a `RateLimitedError` the runner maps to `fail({ rateLimited: true })`,
      or an equivalent handler outcome); the Jev handlers classify the
      gateway's 429 / `rate_limit_exceeded` / "high demand" as rate-limited
      and everything else as a normal failure. Tests in repo style. The
      gateway-side route (provider `digitalocean`) is the owner's; Jev stays
      shadow mode.
- [x] Cut every consumer over to `src/db/jobs.ts` (deferred from Wave 3 to land
      together with the schema that actually carries the table): enrichment
      (`classify`), both Jev queues (`jev_message`, `jev_submission`) and the
      sync tick (`sync_tick`, a leased job so two containers never sync at
      once) all move onto it; delete the in-memory locks in `src/sync/index.ts`,
      `src/enrich/worker.ts`, `src/jev/worker.ts`, the enrichment column-queue
      in `src/db/emails.ts`, and `src/db/jev-queue.ts` itself once nothing
      calls it. The `jev_message`/`jev_submission` handlers classify a caught
      error (429 / `GatewayRateLimitError` / `rate_limit_exceeded`) and call
      `jobs.fail({ ..., rateLimited: true })` for it — replacing
      `jev-queue.ts`'s current all-failures-count-an-attempt behaviour with
      Wave 3's jitter + non-terminal-rate-limit semantics (2026-09-28 429
      incident). `POST /api/sync` enqueues and returns the job id (409 stays
      while a tick holds the lease). Sends become `send` jobs: the
      contact-form routes run the first attempt inline (caller deadline) and
      enqueue only on provider failure; `GET /api/jobs/:id`.
- [x] Ingest through the port: envelope-only sync into `messages` +
      `message_locations` with a flags snapshot; IDLE (`watch()`) kicks a tick;
      classification jobs fetch the body live via `read()`, never from the
      store; `body_cache` fills on read and on a `body_prefetch` job for
      "needs me" rows.
- [x] API v2 on the new tables: `GET /api/messages?needs_me=1`,
      `GET /api/messages/:key` (live read + cache), `GET /api/threads/:key`,
      `GET /api/search?q=` (provider `search()` + FTS, response says which),
      `POST /api/messages/:key/flags`, `POST /api/messages/:key/move`,
      `GET /api/submissions`, `GET /api/stats` (queue by kind). Keep
      `GET /api/emails*` as aliases over the new tables until Wave 8 repoints
      Hermes.
- [x] `scripts/import-legacy.ts`: one-shot copy of `submissions` (and nothing
      else) from `email-gateway.sqlite` into `mail.sqlite`; the Resend send log
      rebuilds from Resend history on first sync.
- [x] Remove the SSR admin's Overview/Inbox/detail pages and their tests; keep
      Submissions and Templates (they do not touch mail tables) until Wave 6.
      README §Storage/§Sync/§API rewritten (Jev shadow mode → jobs, queue
      sections point at `src/db/jobs.ts`); `AGENTS.md` file map, invariants
      ("rows are insert-only" → "bodies are never stored", "two containers,
      one SQLite" → `src/db/jobs.ts`).
      **Left behind:** All three prerequisites landed and were verified for
      real, not just built: IMAP session pooling (one reused connection per
      provider instance, serialized, idle-closed, one reconnect-and-retry for
      read-only calls only — a mutating call whose connection dies mid-flight
      is never replayed); `watch()`/IDLE on its own dedicated connection,
      verified live against production Bridge (`ssh vps` + a throwaway
      `docker cp` probe — connects, negotiates IDLE, enters/exits/re-enters
      cleanly, no credentials logged, cleaned up after); the hostname-reap
      assumption confirmed against the running container's actual 12-hex id
      and noted in code. `imapflow` stays pinned at 2.0.6 — the 2.0.8 cooldown
      lifts 2026-09-30, after this wave closed; bump it in Wave 5 or later.
      **Four full `/check`+`/review` rounds ran against this diff** (this
      wave's Gate, `/review` "on every wave that changed code" — the scale
      warranted more than the usual one pass). Round 1 (8 blocking): a
      non-atomic submission-insert-then-enqueue, a UID-derived `messages.key`
      that update-on-conflict — contradicting the old insert-only invariant,
      now rewritten in AGENTS.md to describe why it's safe (the key isn't
      attacker-influenced, unlike the old Message-ID-derived one); an
      unguarded `poll()` letting overlapping `drain()` calls race
      `accounts.cursors`; `/api/stats` ignoring its own `since` filter; a
      repo factory touching `mailDb`'s lazy Proxy at construction time,
      opening the file on mere import; an IMAP reconnect loop that never
      stops if the very first connect fails; a non-idempotent `send` job
      risking a duplicate customer email; `import-legacy.ts` opening the
      legacy file read-write and masking a missing path as "imported 0".
      Round 2 (8 more): the eager-open bug resurfaced through
      `src/jobs/queue.ts` (fixed for real with a lazy Proxy matching
      `mailDb`'s own); `classify`/`jev_message` racing a full-row
      classification replace (split into column-scoped
      `saveEnrichment`/`saveJevClassification`, no read-merge-write left);
      `accounts.updateCursor`'s hand-built JSON path breaking on mailbox
      names with `.`/`[`/`]`; a stripped IMAP error listener that could crash
      the process; `sync/composition.ts` not actually isolating a
      provider/mailbox failure as documented; a legacy-import re-enqueue gate
      missing "pending with a recorded error" rows; a bare `"429"` rate-limit
      pattern risking a permanent non-terminal retry loop on an unrelated
      error. Round 3 (8 more, smaller/subtler): the JSON-path fix still broke
      on a literal backslash — replaced with `json_patch(cursors,
json_object(?, ?))`, no hand-built path string at all, verified against
      `.`/`[`/`]`/`"`/`\`; a same-mailbox move deleting the location it just
      wrote; a null-provider-date message drifting to "now" on every re-sight
      forever (fixed via `COALESCE`/`CASE` in the upsert SQL, not a JS-level
      substitution); `messages_fts`'s DELETE+INSERT pair not transactional
      under concurrent classify/jev writers; and — a genuine judgment
      reversal — round 1's fix wrapping the submission insert and the Jev
      enqueue in one transaction was **undone**: AGENTS.md's own fail-open
      invariant ("the gate never 500s after delivery... Jev is optional")
      means the non-authoritative, shadow-only Jev enqueue must never be able
      to roll back an already-delivered, authoritative submission row: the
      enqueue is best-effort again, logged and moved on if it fails. Round 4
      (5 more): `send_log`'s plain `INSERT` risking a UNIQUE violation on a
      legitimate retry (now `INSERT OR IGNORE`); the `/api/emails*` legacy
      alias's comment overclaiming byte-compatibility with the old shape —
      narrowed to accurately list what's dropped, after confirming directly
      against the hermes-agent repo that nothing calls this alias today (it
      reads Gmail through argo, not email-gateway, until Wave 8's repoint) so
      the gap has zero live blast radius; re-raised the atomicity question
      from round 3 as a tension with no reconciliation scan — deliberately
      NOT re-added, since AGENTS.md's own stated principle already settles it
      in favour of never discarding a delivered submission. Two design gaps
      surfaced across these rounds are accepted, not fixed, and documented in
      `docs/architecture.md`'s new "Known gaps" section (zero live callers
      before Wave 6/8 either way): moving a message across mailboxes doesn't
      reconcile identity for the next sync (mints a second row under the new
      mailbox+uid); a mailbox's backfill never resumes once marked "done", so
      a backlog larger than one page (500 messages) accumulating after
      extended downtime needs the head pass to walk adaptively instead of
      always exactly one page — a real design change, not a bug fix.
      `fallow`'s remaining findings (unused type exports that are legitimate
      public repo-interface surface; the pre-existing `@fontsource-variable/*`
      deps; a `SYSTEM_PROMPT` name collision between two unrelated prompts;
      ~391 lines of deliberate duplication between `mail-submissions.ts` and
      the frozen legacy `submissions.ts`, which exists only for
      `import-legacy.ts` and is not worth a shared-base extraction before
      it's eventually deleted; complexity scores on the new deep-module
      repos, inherent to replacing `emails.ts`/`submissions.ts` with
      something equally real) are judged not worth another round, matching
      this plan's own Wave 2/3 precedent for triaging `fallow` output rather
      than chasing every flag to zero.

## Wave 5 — Gmail through the IMAP adapter <!-- status: done -->

Moved up from Wave 8 (validation 2026-09-28): reading Gmail ranks above UI and
template polish for the owner, and the client (next wave) should be built
against two accounts from day one rather than retrofitted for multi-account
later. Follows D3. Gmail IMAP facts are in the `docs/architecture.md` research
table; verify the authenticated CAPABILITY line at runtime, never assume it.

**The Gmail app password arrives later and does NOT block this wave** (owner
2026-09-28): build multi-account config, capability detection, fakes,
sync/classification wiring and tests fully with the gate green; live
verification against a real Gmail mailbox is not a checkbox step of this wave
— it is a named open item the delivery lead pulls in once the password is in
1Password, so the chain never stalls on it.

- [x] Multi-account config: `accounts` rows from env (`MAIL_ACCOUNTS` JSON or
      per-account `GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD` — pick one, document
      it) with secrets referenced, never stored; `/health` lists every account.
- [x] IMAP adapter capability detection per account: CONDSTORE `changedSince`
      fast path when advertised (Gmail), UID-window fallback (Bridge);
      `X-GM-THRID` as the thread key and `X-GM-LABELS` as labels when
      `X-GM-EXT-1` is present; `[Gmail]/…` folder mapping for archive/spam/trash.
- [x] Sync + classification for the second account end to end, reachable
      through the API — there is no client yet (Wave 6 builds the inbox
      against both accounts from the start instead of retrofitting it); fakes
      cover the Gmail capability set.
- [x] Retire argo Gmail for real, not as a patch file (owner approval
      2026-09-28): in `~/SourceRoot/argo` create a branch and a **draft** PR
      that deletes `apps/api/routes/gmail.ts` and the Gmail half of
      `clients/google.ts`, keeping Calendar + OAuth; gate green there; record
      the PR URL in `docs/architecture.md`. **Never merge, deploy, or apply
      it** — until email-gateway reads Gmail live, argo is the only Gmail
      source; applying stays an owner gate tied to Gmail-live.
      **Left behind:** Per-account env: `GMAIL_IMAP_USER`/
      `GMAIL_IMAP_APP_PASSWORD`/`GMAIL_IMAP_MAILBOXES` (named vars, not a
      `MAIL_ACCOUNTS` blob — matches `IMAP_*` naming, keeps `.env.tpl` one
      line per secret). `ImapConfig` gained `tls: "starttls" | "implicit"`
      (Gmail is implicit TLS on `993`, no cert pinning — a public CA).
      **Deviation from this step's literal text:** account listing did **not**
      land on `/health` — that endpoint is unauthenticated on the public
      tunnel, and listing real mail addresses there is a PII leak (caught by
      `/review`). It lives on bearer-protected `GET /api/accounts` instead
      (covers both env-configured-but-never-synced accounts and ones already
      in `mail.sqlite`, unlike `/api/stats`'s DB-only `accounts`); `/health`
      stays a plain `{ "ok": true }`.

      Capability detection: `X-GM-EXT-1` adds `X-GM-THRID` to the fetch as
      `Envelope.threadKey`; `[Gmail]/…` folders map via RFC 6154 special-use
      attributes (never hardcoded — Gmail localizes folder names). **Gap,
      accepted:** raw `X-GM-LABELS` capture is not implemented — no `labels`
      field exists anywhere in the port/schema/API, and this wave is
      schema-neutral, so folder/special-use move is the in-scope label
      operation instead.

      CONDSTORE fast path: a process-local `modseqByMailbox` bookmark
      (`mailbox:UIDVALIDITY` keyed, so a mailbox recreation can't read a
      stale bookmark as "nothing changed") backs an incremental `changedSince`
      head call once a prior full scan seeded it; a changed set larger than
      one page, or no CONDSTORE, falls back to the byte-identical UID-window
      scan. `list()` gained `ListOptions.skipFastPath` so `ingest.ts` can force
      a real, truncation-based cursor on exactly the one call that's about to
      seed backfill progress from it (the fast path's `cursor` is always
      `undefined`, ambiguous with "genuinely nothing older").

      **`/review` ran three rounds against this diff** (two sideclaw passes
      plus the dispatch worker's own build-time pass), each catching a real,
      independently-reachable bug in the CONDSTORE bookmark/mailbox-recreation
      path: round 1 — the bookmark not scoped by UIDVALIDITY (a recreation
      read a stale bookmark as "nothing changed", silently dropping mail
      forever) and the bookmark advancing even when a truncated fast-path
      fallback's UID-window scan didn't cover the whole changed set (fixed:
      scope by UIDVALIDITY, never re-bookmark from a fallback once one already
      existed) — plus the unauthenticated `/health` PII leak (fixed, see
      above). Round 2 — `skipFastPath`'s ambiguous-cursor fix landed, but
      forcing `bookmarked = undefined` locally also fooled the cold-start
      guard into re-bootstrapping an *already-precise* bookmark with a
      coarser one a forced UID-window scan doesn't actually back up (fixed:
      track "bookmark exists" against the map directly, not the
      option-suppressed local — regression test asserts the bookmark stays
      exact even when the mailbox's live `HIGHESTMODSEQ` has since moved on).
      Also applied from round 2: a silent-degradation log line on the
      truncated-fallback path, `wireImapIdle` now runs every provider's IDLE
      setup concurrently (`Promise.allSettled`, with its own rejection
      logging) instead of one slow account delaying every account after it,
      `modseqByMailbox` prunes a mailbox's stale UIDVALIDITY entries on
      recreation instead of growing unboundedly, `accountIdFor` reused
      instead of a third inline copy of the `<provider>:<account>` format,
      `.dockerignore` broadened to exclude every `*.test.ts` and `src/test/`
      (not just `scripts/*.test.ts`) from the prod image, and a shared
      `splitMailboxes` util replacing duplicated CSV-parsing between `env.ts`
      and `config.ts`. `imapList` was extracted into `resolveBookmark`/
      `bootstrapBookmarkIfColdStart` helpers once fallow flagged it past the
      complexity threshold from these fixes, matching this plan's Wave 3
      precedent.

      **Accepted as known gaps, documented in `docs/architecture.md`§Known
      gaps** (zero live callers before the Gmail app password lands, matching
      this plan's own precedent for Wave 4's comparable gaps): (1) a CONDSTORE
      bookmark can still advance in-memory before `ingestMailbox` durably
      persists the corresponding page — a DB write failure mid-page could
      skip up to one page of changes on retry; real fix needs `list()` to
      return a candidate bookmark for the caller to commit post-ingest,
      mirroring how the backfill cursor itself is only ever persisted
      post-ingest. (2) a mailbox whose backfill already reached "done" before
      a UIDVALIDITY change never re-seeds under the new identity — a
      manifestation of the existing "backfill never resumes once done" gap
      via a different trigger, same real fix (adaptive head-pass backfill).
      (3) `makeListChangedSince`'s CONDSTORE fetch has no server-side bound,
      unlike every other list path in the adapter — IMAP's CONDSTORE
      extension has no LIMIT, so a real fix needs a windowed changedSince
      strategy, not a client-side slice.

      `fallow`'s remaining findings — the pre-existing unused
      `resetConfiguredProvidersForTest` export and `@fontsource-variable/*`
      deps (both from Wave 4), and `src/api/plugin.ts`'s two pre-existing,
      deliberately-duplicated query-schema clone groups (the file's own
      comment explains why) — are judged not worth another round, matching
      this plan's Wave 2/3/4 precedent for triaging `fallow` rather than
      chasing every flag to zero. `/check` is green: format, typecheck, 407
      tests, fallow audit exit 0.

      **A priority live-incident fix landed first, as its own commit**
      (`678f7d4`, before this wave's own diff): a rate-limited job always
      rescheduled on the backoff ladder's first (1-minute) rung regardless of
      how many times it had already been rate-limited, so the 2026-09-28 Jev
      429 storm kept every parked job retrying every ~1 minute — replaying
      roughly its own request volume back at the still-throttling gateway,
      plus ~40k log lines/hour from logging the full error object on every
      attempt. Fixed with `jobs.rate_limits`'s own escalating ladder (1m → 5m
      → 15m → capped 1h, never terminal, resets on success/other failure,
      never spends an `attempts`), an idempotent `ensureJobsSchema` `ALTER`
      for the live table (this module owns the jobs DDL outside the versioned
      `mail-migrations.ts` path), and a one-line rate-limited log instead of
      the full error object. Unrelated to Gmail; see that commit for detail.

      **Open item for the delivery lead:** live verification against a real
      Gmail mailbox, once the app password is in 1Password — not a blocker,
      per this wave's own header.

## Wave 6 — Client shell + the tailnet host gate <!-- status: done -->

Moved down from Wave 5 (validation 2026-09-28) so the inbox is built against
both Proton and Gmail from the start. Follows §Client. Pattern:
`argo/apps/dashboard` + the basalt-ui consumer rules in `~/.claude/CLAUDE.md`.
Vite 8, `@elysia/static` 1.4.11, `@elysia/eden` 1.4.10 (research table in
`docs/architecture.md`; re-verify with `/research` before pinning).

This wave also pulls forward the in-repo half of Wave 9's host gate: the mail
surface (`/app`, `/api`, and later `/mcp`) sits behind a `MAIL_HOST` check the
moment the client exists, instead of staying reachable on the public tunnel
hostname for three more waves. Only the code moves — the tailnet DNS record,
the second Traefik router and publishing the hostname stay Wave 9
(outward-facing, another repo's deploy path).

- [x] `MAIL_HOST` env: the app serves `/app`, `/api` (and `/mcp` once it
      exists, Wave 8) only when `Host` matches it, and serves the send routes + `/health` on any host; tests for both doors. Unset in dev and in prod
      until Wave 9 sets it, so this is a no-op until then.
- [x] `client/` Vite + React + basalt-ui app: `basaltViteConfig` from
      `basalt-ui/vite`, TanStack Router (file routes) + TanStack Query, Eden
      Treaty typed against the Elysia app, `BasaltProvider` with the
      `.layer.css` import order; a `.test` port in `dotfiles/config/Caddyfile`
      (own commit there is outward-facing → note it, do not push dotfiles).
- [x] Serve `client/dist` from Elysia at `/app` (`@elysia/static`,
      `alwaysStatic`, explicit `/app/*` catch-all → `index.html`; hashed assets
      long-cached, `index.html` not); Dockerfile gains the client build stage.
- [x] Session auth: `POST /app/login` with `ADMIN_PASSWORD` → signed HttpOnly
      `SameSite=Strict` cookie (Elysia core cookie), same-origin check on
      mutations, logout; `/api` and later `/mcp` stay bearer.
- [x] Pages: Inbox sorted by "needs me", merged across both accounts with an
      account chip (category, priority, action_required, unread) with filters;
      Message view (live read, sandboxed HTML iframe, classification panel,
      mark read/unread, star, archive, spam, trash via the flag/move
      endpoints); Submissions; Accounts/health (sync state per account, queue
      by kind, IMAP health).
- [x] Delete the remaining SSR admin (`src/admin/`), `/admin` → 302 `/app`;
      README §Admin UI → §Client, `MAIL_HOST` documented; `AGENTS.md` stack +
      file map.
      **Left behind:** Built across four in-place `mcp__sideclaw__dispatch`
      episodes plus two rounds of hand fixes (the fastest lane the `/wave`
      skill names still needed real iteration here — a new subproject with a
      typed cross-package client is a different risk profile than the
      schema/backend waves before it). Three `/review` rounds ran: round 1
      (5 blocking) caught the Eden-typed-client premise being broken at three
      layers at once — `createApp`'s `AnyElysia` widening threw away `App`'s
      route types, `client/`'s own separate `elysia` install made
      `treaty<App>()` structurally fail even at the same version (no
      workspace relationship to root), and the client was never typechecked
      anywhere so neither was caught — plus a session cookie with no
      server-side expiry and an empty-`COOKIE_SECRET` edge case that desynced
      `/app` and `/api` auth. Round 2 (5 more) was mostly round 1's own
      fallout: `src/web/plugin.ts` built its routes as separate statements
      instead of one chained expression (Elysia route methods return a new
      typed instance per call, so `webRoutes` still carried zero route types
      into `App` even after the `createApp` fix), the client's route tree
      (`routeTree.gen.ts`, gitignored) isn't generated before a bare `tsc`
      run on a clean checkout, no Bun ambient types for the client's
      transitive server imports, a bare `React.FormEvent` UMD reference, and
      — the one with real security weight — `MAIL_HOST`'s new `.min(1)`
      validation never actually fired, because `parseEnv()` strips every
      empty-string env var to "unset" _before_ schema validation (deliberate,
      for Compose's `${VAR}`→`""` interpolation of unset vars), so a
      Compose-interpolated empty `MAIL_HOST=` still silently disabled the
      host gate exactly as the added comment claimed it wouldn't; fixed by
      special-casing `MAIL_HOST=""` in `parseEnv` ahead of the generic strip.
      Round 3 came back `actionable` (not `needs-human` — the structural
      Eden-typing fix held) with 5 more findings, two fixed by hand after the
      round: Inbox defaulted `needsMe` to `true`, filtering the list down to
      only action-required mail instead of the plan's actual ask ("sorted by
      needs me" — the comparator already ranked it first, the default just
      needed to flip to `false`); and `/api`'s `configured` guard only
      checked `apiKey !== undefined`, so a deployment with `ADMIN_PASSWORD`/
      `COOKIE_SECRET` set but no agent `API_KEY` could log into `/app` and
      then get a 404 on every `/api` read the SPA makes — fixed to
      `apiKey !== undefined || session !== undefined` (and the resulting
      `apiKey: string | undefined` passed into `timingSafeEqualStrings`,
      which takes `string`, needed an explicit guard once `configured` could
      be true with `apiKey` still unset).

      Three findings from round 3 are accepted as known gaps, matching this
      plan's own pattern (Wave 4/5's "Known gaps" in `docs/architecture.md`)
      rather than open-ended this wave further — each was already flagged as
      a **design decision**, not a regression, back in round 1's discussions:
      (1) Inbox/Submissions fetch a flat `limit: 100`/`50` page and never
      follow `nextCursor`, so an account whose matching set exceeds that is
      silently truncated with no "more below" indicator — needs a
      cursor-pagination or infinite-scroll design, not a one-line fix.
      (2) Message-view move targets (`Archive`/`Spam`/`Trash`) are literal
      IMAP paths; Gmail's are localized (`[Gmail]/…`, per `src/env.ts`'s own
      comment), so moving a Gmail message today targets a folder that
      doesn't exist — needs a special-use mapping or deriving targets from
      the account's own mailbox list. (3) `POST /app/login` has no rate
      limiting, and `sessionSecret` falls back to signing cookies with the
      same `ADMIN_PASSWORD` when `COOKIE_SECRET` is unset — a successful
      brute force both authenticates and lets the attacker mint session
      cookies. Not a regression (the retired SSR admin's Basic auth had the
      same unthrottled exposure on the same public-tunnel hostname), and
      `MAIL_HOST` moving this surface off the tunnel is explicitly Wave 9's
      job — worth adding a throttle (the existing `jobs`-rate-limit machinery
      is queue-shaped, not request-shaped, so this needs its own design) no
      later than Wave 9, sooner if the mail surface stays on the tunnel
      longer than expected.

      Also accepted, not fixed: several `/review` "improvements" votes for
      tightening the Eden client further (drop the `as unknown as X` double
      casts in `client/src/lib/api.ts` once trusting Eden's own narrowing;
      reuse the server's exported types instead of the small remaining
      hand-duplicated ones in `client/src/lib/types.ts`), missing `onError`
      handlers on the flag/move mutations (silent failure, no UI feedback),
      and the Dockerfile's runner-stage comment claiming a slim runtime that
      Bun's workspace hoisting doesn't actually produce (client deps still
      land in the one shared `node_modules` the runner copies — correct
      behaviourally, misleading comment). None block the surface working
      correctly today; picked up whenever someone is next in these files.

      `fallow`'s residual findings — the two pre-existing, in-code-documented
      duplicate query-schema clone groups in `src/api/plugin.ts`
      (`messagesListQuery`/`emailsListQuery`, `/flags`/`/move` validation,
      unchanged by this wave) and moderate (cyclomatic 5-7) complexity on the
      four route-page components (`InboxPage`, `AccountsPage`,
      `SubmissionsPage`, `MessagePage`, all well under the CRITICAL threshold
      the first fixup round brought `MessagePage` down from) — are triaged as
      not worth another round, matching every prior wave's own precedent in
      this plan (Wave 2/3/4/5) for `fallow` output specifically. `/check` is
      green on format, typecheck (now covering the client too — new since
      this wave), and `bun test` (416 pass).

## Wave 7 — Templates and the send log <!-- status: done -->

- [x] `templates` table seeded from `src/emails/registry.ts` (id, name, preview
      props); the routes' `source` ids come from the registry, not hand-typed
      strings (drift test).
- [x] `send_log` rows for every send (template id, recipients, provider id,
      status/last event, requested by: route / test-send / agent), filled in
      by Resend history sync.
- [x] `POST /api/templates/:id/test-send` (to the owner's address, `send` job);
      `GET /api/templates`, `GET /api/templates/:id/preview?width=`.
- [x] Client pages: Templates (preview at 375/600, test-send) and Send log per
      template; README §Endpoints/§Templates; `AGENTS.md` file map.
      **Left behind:** A priority fix landed first, as its own commit
      (`00ca5b4`, before this wave's own diff): a clean `cd client && bun run
build` failed because basalt-ui 1.30.2 imports `motion/react` eagerly
      (its own bundled docs: "motion is required, not optional") while
      `client/package.json` never declared it as a dependency — it only built
      in the Wave 6 checkout by accident (a stale local `node_modules`).
      Verified independently (grepped basalt-ui's own comment, confirmed the
      dep was absent, rebuilt clean before and after) before applying the fix.

      Built across two in-place `mcp__sideclaw__dispatch` episodes (backend,
      then client) plus one round of hand fixes. `TEMPLATE_IDS` in
      `src/emails/registry.ts` is the drift-proof source of truth for every
      template id — `findTemplateEntry`/`renderTemplateElement` (also new)
      are the one shared lookup/render every caller (`src/api/plugin.ts`,
      `src/jobs/send.ts`) now goes through instead of three separate copies.
      `syncTemplateRegistry()` (new `src/emails/sync-registry.ts`) pushes the
      registry into `templates` on every boot, wrapped in try/catch in
      `src/index.ts` so a boot-time DB hiccup there can't take
      `startJobSystem()` down with it. `send_log` reconciliation is a new
      `reconcile_send_log` job (`src/jobs/reconcile-send-log.ts`) riding the
      same 5-minute timer as `sync_tick`: `sendLogRepo.listReconcilable()`
      (new) finds rows still short of a terminal Resend `last_event`, re-reads
      `emails.get()` per row under a 10s timeout, and touches `updated_at` on
      failure too so a permanently-failing row (e.g. `RESEND_ADMIN_API_KEY`
      unset in prod today) rotates to the back of the queue instead of
      starving every newer row forever. A new migration (version 2 —
      version 1 already shipped, so this is additive, not an edit) adds
      `idx_send_log_provider_updated_at` for that query. Four new API routes
      (`GET /api/templates`, `GET /api/templates/:id/preview` — now sends
      `Content-Security-Policy: sandbox` so it's safe to load directly, not
      just through the client's sandboxed iframe — `POST
      /api/templates/:id/test-send`, `GET /api/send-log`) and two new client
      pages (`templates.tsx`, `templates.$id.tsx`: a 375/600 width toggle, a
      test-send button with real error surfacing, and the per-template send
      log with a truncation note past 50 rows) round it out.

      **Two `/review` rounds ran**, each catching real bugs the other missed.
      Round 1 (2 blocking): `reconcile_send_log`'s per-row catch never
      advanced the failing row's `updated_at`, so a stuck row (guaranteed in
      prod today, since `RESEND_ADMIN_API_KEY` is unwired) would occupy every
      future batch forever — fixed by touching `updated_at` on failure too,
      in its own nested try/catch so a DB error there can't abort the rest of
      the batch; and up to 25 sequential, un-timeboxed Resend calls could
      stall the job system's single serial drain loop indefinitely — fixed
      with a 10s per-call timeout. Round 2 (1 blocking, applied where
      fixable): the timeout wrapper never cleared its losing timer (now
      does, and `unref()`s it) — but genuinely **cannot** cancel the
      underlying HTTP request, since `resend@6.28.1`'s `emails.get(id)` has
      no options parameter at all, no `AbortSignal`; documented as an
      accepted, SDK-constrained gap (bounded by `RECONCILE_BATCH_LIMIT`, not
      unbounded) rather than bypassing the SDK with a raw `fetch()` for one
      job's read path. Also fixed from round 2: the "Open raw HTML" link
      bypassed the iframe's `sandbox=""` on direct navigation (fixed via the
      CSP header above, which protects the endpoint regardless of how it's
      reached); `findTemplateEntry`/`renderTemplateElement` extracted to kill
      a 3-way duplicate; `satisfies SendJobPayload` on the test-send job
      payload; the client's nested ternaries flattened into small
      early-return components (`PreviewFrame`, `SendLogSection`); the send-log
      URL now goes through one `encodeURIComponent`-safe helper; a missing
      `["send-log", id]` query invalidation on test-send success (4 reviewers
      independently caught this one); the "queued" badge → Mantine's
      `loading` prop and real error-message surfacing on the test-send
      button; an `aria-label` on the width `SegmentedControl`; a missing
      `suppressed` case in `listReconcilable`'s terminal-status test and the
      README's prose (Resend's `last_event` union has 12 values, not the 11
      first assumed). `src/db/mail-client.test.ts`'s hardcoded
      `user_version` expectation bumped from 1 to 2 for the new migration.

      Three findings judged genuine design gaps rather than this wave's bugs,
      documented in `docs/architecture.md`'s Known gaps section instead of
      fixed (matching Wave 4/5's own precedent): a `send` job that exhausts
      its nine attempts never writes back to `send_log`, so a permanently
      failed send renders as an indistinguishable "queued" badge; a renamed
      or removed template id leaves an orphaned `templates` row that 404s on
      click; and `test-send`'s three writes (`insertSendLog` →
      `jobs.enqueue` → `recordTestSend`) aren't atomic, mirroring the same
      accepted tension in Wave 4's submission-then-Jev-enqueue path. Also
      accepted, not fixed: splitting `src/api/plugin.ts`'s templates/send-log
      routes into their own module (two reviewers + fallow flagged the
      file's growth; Wave 6's own history shows a careless Elysia route-chain
      split breaks Eden's type inference, and this is quality, not a bug) and
      the pre-existing cross-file `send-log.ts`/`mail-submissions.ts`/
      `messages.ts`/`submissions.ts` repo-boilerplate duplication fallow
      flags a fourth copy of. `fallow`'s remaining findings — the
      pre-existing unused type exports and `MAIL_MIGRATIONS` export
      (repo-interface surface, same triage as every prior wave), the `motion`
      "unused dependency" (a false positive: basalt-ui imports it internally,
      confirmed by rebuilding without it and watching the build fail), the
      pre-existing `plugin.ts` auth-guard complexity and
      `messagesListQuery`/`emailsListQuery` clone (Wave 6), and CRAP-score
      complexity flags on two small client functions (`statusColor`,
      `SendLogSection`) that are an artifact of this project having zero
      client-side test infrastructure, not a real design problem — are judged
      not worth another round, matching this plan's Wave 2–6 precedent.
      `/check` is green: format, typecheck (server + client), 432 tests,
      client build. `RESEND_ADMIN_API_KEY` remains unwired in prod (AGENTS.md)
      — the delivery lead should wire it before `reconcile_send_log`'s first
      real pass, or every row will fail with a restricted-key error (handled
      gracefully, but reconciliation is a no-op until then).

## Wave 8 — Agent API: REST v2 complete + MCP + Hermes <!-- status: done -->

Follows §Agent API. `@modelcontextprotocol/server` 2.0.0 via `createMcpHandler`
exactly as `research-gateway/src/routes/mcp.ts`.

- [x] Finish REST v2: `GET /api/threads/:key/summary` (LLM job, cached on the
      thread), `POST /api/drafts` (reply draft as text — D2: no send-as-owner),
      `POST /api/sends` (template send → job), `GET /api/needs-action`.
- [x] `/mcp`: tools `search_mail`, `read_message`, `summarize_thread`,
      `needs_action`, `draft_reply`, `send_template`, `job_status`; bearer
      checked before the handler; stateless, `responseMode: 'sse'`.
- [x] Remove the `/api/emails*` aliases; `docs/agent-api.md` for Hermes
      (curl examples, the MCP client config) modelled on research-gateway's
      README "Clients" section.
- [x] Build the Hermes repoint as a real branch + **draft** PR in
      `~/SourceRoot/hermes-agent` (`skills/argo-api/SKILL.md` +
      `references/schedule.md`, Gmail reads → email-gateway), gate green
      there, PR URL in `docs/agent-api.md`. **Never merge/apply** — owner
      gate.
      **Left behind:** Built across three `mcp__sideclaw__dispatch` episodes
      (REST v2 + the shared `src/services/agent-api.ts` service layer, a
      review fix-up round, then `/mcp`) plus a small manual dedup pass
      (`extractBearerToken` in `src/auth.ts`, `splitCsv` in
      `src/utils/csv.ts`, shared between `src/api/plugin.ts` and the new
      `src/mcp/plugin.ts`). Three `/review` rounds ran, each catching real,
      independently-verified bugs: round 1 (3 blocking) — an omitted
      `templateProps` on `POST /api/sends` silently mailed a template's
      _preview_ content to a real recipient (fixed: the field is now
      required, `t.Record` not `t.Unknown`); `sendTemplate`'s `send_log`
      insert and `jobs.enqueue` were two independent non-transactional
      writes, risking an orphaned, unreconcilable `send_log` row on a crash
      between them (fixed: one shared `enqueueTemplateSend` helper,
      `db.transaction()`-wrapped, also adopted by the pre-existing
      `POST /api/templates/:id/test-send`); `getThreadSummary` fetched
      thread rows with a fixed `limit: 100` and cached on `messageCount ===
rows.length`, so a thread past 100 messages could never invalidate its
      cache again (fixed in round 3, see below — round 1 only raised it).
      Round 2 (after `/mcp` landed, 5 blocking) — MCP tool errors forwarded
      raw upstream LLM/provider error text where REST sanitized it through
      an `agentErrorStatus` mapping (fixed: MCP now routes through the same
      shared mapping, exported from `src/services/agent-api.ts`); MCP
      success responses serialized the full `{ ok: true, ... }` service
      envelope instead of the flat shape REST returns for the same call,
      contradicting `docs/agent-api.md`'s "identical payload" claim, and
      `send_template` was missing the `enqueued` field entirely (fixed:
      every one of the 7 tools now unwraps to match its REST counterpart
      field-for-field); the `getThreadSummary` cache-staleness bug from
      round 1 was re-confirmed here by an independent reviewer angle and
      fixed for real this time — invalidation moved from a capped row count
      to the thread's newest message key (`thread_summaries.latest_key`,
      migration v4), so a thread under the 100-message summarization cap is
      never permanently stale (the cap on what gets _summarized_ is
      unrelated and still a known gap, see below); `draft-reply.ts` and
      `thread-summary.ts` both embedded `JSON.stringify(payload)` directly
      between their `<email>`/`<thread>` untrusted-data delimiters with no
      escaping, so a subject or body containing a literal `</email>` or
      `</thread>` could close the block early and forge trusted-looking
      content past it — fixed with a shared `serializeUntrusted` helper
      (`src/utils/prompt.ts`) that escapes `<`/`>` to their JSON `\u` form;
      `draftReplyForMessage`'s live provider read + `saveBody` write weren't
      wrapped in try/catch, so a throw there escaped the route's error-code
      mapping entirely and could surface raw text via Elysia's default
      500 handler (fixed: wrapped, returns a mapped `read_failed`). Round 3
      confirmed green with no new findings. `fallow`'s residual findings —
      the pre-existing unused `MAIL_MIGRATIONS`/`ThreadSummary`/
      `SaveThreadSummaryInput` exports, the pre-existing `motion` client
      dep, the pre-existing flags/move route duplication, and one small
      7-line guard duplicate between `getThreadSummary`/`draftReplyForMessage`
      — are judged not worth another round, matching every prior wave's own
      triage precedent. `/check` is green: format, typecheck (server +
      client), 473 tests, `bun run build` from a clean `client/dist` all
      pass.

      Known gaps newly documented in `docs/architecture.md`: `POST
      /api/sends` has no rate limit or recipient allowlist (any bearer-key
      holder, and now any MCP-driven agent, can send as the owner to an
      arbitrary address); `templateProps` has no per-template zod schema;
      `getThreadSummary`'s cache is still not content-sensitive (a
      re-sighted message whose content changed but isn't a new thread
      arrival serves a stale summary) and a thread over 100 messages is
      still summarized from its newest 100 only (the invalidation bug is
      fixed, the page-size cap is not); and `src/enrich/enrich-email.ts` has
      the same pre-existing unescaped-delimiter exposure this wave's fix
      addressed in its own two new prompt builders — flagged, not fixed,
      since the file predates this wave and touching it is out of scope.

      The Hermes repoint PR
      ([jkrumm/hermes-agent#3](https://github.com/jkrumm/hermes-agent/pull/3))
      was built in an isolated `git worktree` (not sideclaw dispatch —
      hermes-agent's dispatch policy caps at `investigate`, below what a
      branch+PR needs) so the repo's own significant pre-existing
      uncommitted work was never touched. It rewrites Gmail reads against
      email-gateway's real contract and explicitly calls out two capability
      gaps versus argo's old proxy (no native unread/important/starred
      filter — derive from each message's `flags`; no per-field
      `from:`/`to:`/`subject:` search, free-text FTS only) rather than
      inventing parameters that don't exist. **Not merged** — gated on both
      this API actually being reachable in production (Wave 9) and argo's
      own pending `/gmail/*` deletion PR
      ([jkrumm/argo#20](https://github.com/jkrumm/argo/pull/20), from Wave
      5, also still unmerged).

## Wave 9 — Topology cutover <!-- status: done -->

Follows D1. Every step here touches production or another repo's deploy path:
**prepare everything, verify locally, then hand back to the owner** — no push
outside this repo, no hostname published by a wave. The `MAIL_HOST` code
itself already shipped in Wave 6; this wave is what makes it live.

- [x] Local dev off Doppler: `.env.tpl` + `secrets-run` like the siblings,
      `make dev/check/…` Makefile, `doppler.yaml` deleted; README §Local
      Development.
- [x] Backup: `scripts/backup.sh` (`VACUUM INTO` + rsync to the homelab backup
      target, warden's pattern) and the cron entry as a ready-to-apply snippet
      for the `vps` repo.
- [x] Ready-to-apply changes for `vps/apps/email-gateway/compose.yml` (second
      Traefik router on the tailnet hostname, `MAIL_HOST`, the DNS-only A
      record note) and `.env.tpl` (Gmail secrets, `RESEND_ADMIN_API_KEY`,
      `IMAP_TLS_CERT`) written to `docs/vps-cutover.md`, plus the owner's
      checklist: apply, deploy, delete `email-gateway.sqlite`, revoke argo's
      Gmail scope.
      **Left behind:** `.env.tpl` + `Makefile` (`dev`/`check`/`build`/`help`)
      replace Doppler; `package.json`'s `start`/`dev` now run through
      `secrets-run --env-file=.env.tpl`, reading the same `op://vps/
email-gateway/*` vault the VPS deploy does (solo project, no separate
      dev secret set). Proton IMAP stays deliberately unreachable from local
      dev — the tailnet ACL only grants VPS → homelab, not the mini — so
      `.env.tpl` leaves `IMAP_HOST` unset and documents verifying
      IMAP-touching changes against the live container instead (Wave 4/5's
      `ssh vps` + `docker exec` pattern). `scripts/backup.ts` (VACUUM INTO to
      a `.tmp` path, `PRAGMA integrity_check`, then an atomic rename; prune
      to `KEEP=7` per database) is unit-tested (`scripts/backup.test.ts`,
      14 tests). `scripts/backup.sh` (container discovery via the compose
      service label, an empty-source guard before `rsync --delete`, a
      warden-style `mkdir` single-instance lock under `$DATA_DIR`) is
      smoke-tested by hand with `docker`/`rsync` stubbed on `PATH` — this
      repo has no shell-test harness, so it still needs a real dry-run on the
      VPS before the cron job is trusted unattended. `docs/vps-cutover.md`
      is the full handover: the tailnet ACL grant the backup rsync still
      needs (`tag:vps → tag:homelab tcp:22`, absent today — verified against
      `dotfiles-private/tailscale-acl.jsonc`), the DNS-only A record, the
      exact `compose.yml`/`.env.tpl` diffs (matching the `hyperdx`/`argo`
      tailnet-only precedent in `vps/compose.monitoring.yml`), the cron
      entry, and the owner's 6-step checklist (ACL + DNS → vps repo changes
      → cron install → revoke argo's Gmail scope → delete the legacy SQLite
      file → merge the Hermes repoint PR). Verified, not assumed: Traefik's
      `websecure` entrypoint is published as `${VPS_TAILSCALE_IP}:443:443`
      (`vps/compose.networking.yml`), not `0.0.0.0` — so the proposed
      `mail.${DOMAIN}` router is unreachable from the public internet by
      construction (non-routable CGNAT target _and_ a listener bound to
      nothing public), not merely "DNS is the access control" as the
      `hyperdx`/`argo` comments it was modelled on understate.

      Three `/review` (sideclaw) rounds ran, each catching real, independently-
      verified issues. Round 1 (2 blocking): an unguarded `VACUUM INTO`
      writing straight to its final path, so a process killed mid-write
      (OOM, a RollHook deploy tearing the container down) could leave a
      truncated file that's filename-indistinguishable from a good snapshot
      and gets rsynced offsite as one — fixed with a `.tmp` path + integrity
      check + atomic rename; and an adversary-angle claim that the tailnet
      router was reachable from the public internet — investigated and
      found **false** (see "Verified, not assumed" above), so the doc was
      corrected to state the real enforcement mechanism precisely rather
      than either accept the false finding or leave the original
      understated claim as-is. Round 2 (3 blocking, on the fixes above): a
      broken local `DATA_DIR` claim from the adversary angle — investigated
      and found **false** (`src/env.ts`'s real default is the relative
      `./data`, auto-created by `openDatabase`'s `mkdirSync`, not the
      Dockerfile's prod-only `/data`); an unguarded `rsync --delete` that
      could wipe the entire offsite copy on a host/container `DATA_DIR`
      path drift — fixed with an explicit empty-source guard; and local
      `KEEP` rotation outrunning the rsync during an extended tailnet
      outage, silently shrinking offsite retention — documented as an
      accepted, bounded tradeoff already present in `warden-backup.sh`
      (restic's own long-term retention on the homelab side is the actual
      archive), not engineered around. Also fixed from round 2: per-database
      isolation in `runBackup` (one DB's failure no longer skips the rest,
      new test), `tmpOut` cleanup on an integrity-check failure, and a
      warden-style `mkdir` single-instance lock closing an overlapping-run
      race. Round 3 (1 blocking, investigated and found **false**: the lock
      PID file write was claimed to write a literal `"$"` instead of the
      PID — verified directly against real bash, `printf '%s' "$$"` does
      expand to the actual PID): fixed the surrounding, genuinely real
      findings instead — the lock's default path moved off world-writable
      `/tmp` to `$DATA_DIR` (owned solely by this backup process), a bare
      `as` cast on `PRAGMA integrity_check`'s result replaced with
      bun:sqlite's typed `.query<T, Params>()`, a stale `AGENTS.md` pointer
      in `.env.tpl`'s header fixed to the real location
      (`~/.claude/CLAUDE.md`), and a `keep: 0` regression test locking in
      round 1's negative-zero fix (`.slice(0, -keep)` silently pruning
      nothing at `keep === 0`; now `Math.max(0, files.length - keep)`).
      Three residual lock races (an empty-pid-file window right after
      `mkdir`, the `rm -rf`+`mkdir` reclaim not being atomic, a reused PID
      after reboot defeating `kill -0`) are accepted and documented inline
      in `scripts/backup.sh` — all three are present identically in
      `warden-backup.sh`, the pattern this wave was asked to mirror, and
      none are reachable outside a once-daily cron with no long-running
      overlap. `fallow`'s one finding — `client/package.json`'s `motion`
      dependency — is the same pre-existing false positive triaged in
      Waves 6/7/8 (basalt-ui imports it internally; confirmed there by
      rebuilding without it and watching the build fail); not touched here
      either, matching precedent. `/check` is green: format, typecheck
      (server + client), 484 tests (up from 473 at Wave 8's close), fallow
      audit clean on changed files.

      **Nothing outward-facing was applied** — no push to `vps`,
      `dotfiles-private`, or any other repo; no DNS record created; no ACL
      grant added; the cron entry is not installed. `docs/vps-cutover.md` is
      the complete handover for the owner to apply by hand.

      **This closes the wave chain** — Wave 9 was the last wave in this
      plan and its own header requires handing back to the owner rather
      than spawning a successor regardless of gate state. No Wave 10
      exists; `rd wave` should not be invoked from here.
