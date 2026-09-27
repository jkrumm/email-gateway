# Vision

**email-gateway is the one door to all of my email.** Every mailbox I own
(Proton Mail, Gmail) and every mail my apps send (Resend) sits behind one API
and one UI. It classifies what arrives, shows me what matters, and hands the
same data to Hermes and any other agent or app.

Renamed from `bun-email-api` on 2026-09-27 to match `research-gateway` and
`audio-gateway`. The name describes the target, not the current state.

## Where it stands

| Area     | Today                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send     | Resend with React Email templates, one route per caller: `/fpp`, `/fpp-daily-analytics`, `/sy-serendipity`                                                     |
| Receive  | Read-only IMAP sync of Proton (`hello@`) through Proton Mail Bridge on the homelab over the tailnet. Resend inbound/outbound history comes from the Resend API |
| Classify | LLM spam gate on contact forms, LLM enrichment of inbound mail, Jev in shadow mode as a durable retried queue                                                  |
| Store    | SQLite (`bun:sqlite`) in a VPS volume                                                                                                                          |
| UI       | Zero-JS SSR admin at `/admin` (Basic auth) using basalt-ui tokens                                                                                              |
| API      | `/api/*` behind a bearer token: emails, stats, submissions, sync                                                                                               |

## Target

**The providers stay the source of truth.** Proton (through Bridge) and Gmail
own the mail. The gateway reads through them live and keeps only what they
don't have: classifications, the send log, templates and job state. There is
no full mirror. If the gateway's store is wiped, nothing is lost that a
re-read cannot rebuild.

- **Providers as ports.** Proton (Bridge IMAP/SMTP), Gmail and Resend each
  sit behind one provider interface covering list, read, search, flag and
  send. A new mailbox means a new adapter, not a new code path.
- **A lean store.** Rows are keyed by provider message ID and hold only
  derived data: category, spam probability, importance, summary, and the
  model that decided it. Bodies stay with the provider, with at most a short
  cache for the reading view. That volume is small enough that SQLite is
  enough. Postgres earns its place only if another app has to query the data
  directly.
- **Durable jobs.** Classification, Jev and outbound sends run as persisted
  jobs with claim, backoff and a terminal state. The Jev queue already works
  this way, so it becomes the template.
- **Classification that earns attention.** The inbox sorts by "needs me"
  rather than by date. The LLM and Jev stay side by side until Jev's agreement
  rate justifies promoting it.
- **Templates managed in the dashboard.** Templates can be previewed and
  test-sent from the UI, and every send is recorded against its template.
- **A real client.** A React + basalt-ui SPA built with Vite and served by the
  Elysia server itself, so it stays one deployable. It replaces the SSR admin.
- **An API for agents.** Typed endpoints (and likely an MCP surface) for
  Hermes: search, read, summarize a thread, list what needs action, draft a
  reply.

## Decisions still open

- **Where it runs.** Leaning: the reading side belongs on the homelab next to
  Bridge, tailnet-only, because a personal mailbox has no business behind a
  public hostname. The VPS keeps only the public, stateless send routes
  (`/fpp`, `/sy-serendipity`, …). That split is either one service deployed
  twice with feature flags or a thin public relay; decide it before the client
  is built.
- **Mirror or mail client?** Today's sync is read-only. Marking mail read,
  archiving or replying from the dashboard needs write access (IMAP
  flags/moves through Bridge, the Gmail API). Leaning: read-only first, then
  flags and moves, and sending as me last.
- **Gmail access.** The Gmail API with OAuth gives push, labels and history
  IDs. IMAP with an app password is simpler and fits the existing IMAP port.
  Leaning: the Gmail API.
- **What happens to today's stored mail.** The current SQLite holds full
  bodies of synced mail. Under the lean model it shrinks to derived data plus
  the Resend send log, which exists nowhere else.
