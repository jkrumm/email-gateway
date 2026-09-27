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

- **Providers as ports.** Proton (Bridge IMAP/SMTP), Gmail, and Resend each
  sit behind one provider interface for sync, send, and flag changes. A new
  mailbox means a new adapter, not a new code path.
- **Postgres, own schema.** Move from SQLite to the shared VPS Postgres under
  an `email_gateway` schema with its own least-privilege role, following the
  `argo` pattern (`vps/scripts/sync-pg-schema-from-vps.sh SCHEMA=…`).
- **Durable jobs.** Sync, enrichment, Jev and outbound sends all run as
  Postgres-backed jobs with claim, backoff and a terminal state. The Jev queue
  already works this way, so it becomes the template.
- **Classification that earns attention.** Each mail gets a category, a spam
  probability and an importance score. The inbox sorts by "needs me" rather
  than by date. The LLM and Jev stay side by side until Jev's agreement rate
  justifies promoting it.
- **Templates managed in the dashboard.** Templates can be previewed and
  test-sent from the UI, and every send is recorded against its template.
- **A real client.** A React + basalt-ui SPA built with Vite and served by the
  Elysia server itself, so it stays one deployable. It replaces the SSR admin.
- **An API for agents.** Typed endpoints (and likely an MCP surface) for
  Hermes: search, read, summarize a thread, list what needs action, draft
  a reply.

## Decisions still open

- **Mirror or mail client?** Today's sync is read-only. Marking mail read,
  archiving or replying from the dashboard needs write access to the mailbox
  (IMAP flags/moves through Bridge, the Gmail API). That changes the security
  model more than any other choice here. Leaning: read-only first, then flags
  and moves, and sending as me last.
- **Where it runs.** The whole personal mailbox would live on the public VPS
  behind Cloudflare. The Bridge is already on the homelab, so a homelab or
  mini deployment behind the tailnet, with only the Resend send routes public,
  is worth weighing before the Postgres move pins it down.
- **Gmail access.** The Gmail API with OAuth gives push, labels and history
  IDs. IMAP with an app password is simpler and fits the existing IMAP port.
  Leaning: the Gmail API.
- **Env prefix.** `BEA_*` survives the rename on purpose. It goes when
  `env.ts` is rebuilt for Postgres, at the same point the callers
  (FPP `BEA_BASE_URL`, sy-serendipity) move to the new hostname.
