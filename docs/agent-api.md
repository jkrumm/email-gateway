# Agent API

The contract Hermes (and any other agent) uses to read and act on the owner's
mail. Two doors onto the **same service layer** (`src/services/agent-api.ts`):
a bearer JSON REST API at `/api/*` and an MCP endpoint at `/mcp`.

Both are **bearer-only** — `Authorization: Bearer $API_KEY` (min 16 chars,
`API_KEY` in the environment). Unset `API_KEY` 404s the whole `/api` and `/mcp`
prefixes. A wrong or missing token is `401`. The `/app` session cookie never
opens `/api` to an agent, and never opens `/mcp` at all: MCP is agent-only.

Both doors sit behind the `MAIL_HOST` gate (a mismatching `Host` 404s them) and
are reached at `https://mail.<domain>`. All examples below use that host.

## REST `/api/*`

Responses are JSON. List endpoints are keyset-paginated (`limit`, `cursor`,
`nextCursor`); a malformed `cursor` is a `400 { "error": "invalid_cursor" }`.

### Accounts and health

```bash
# Every configured account (id, provider, address) — no connection made.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/accounts"

# Message/queue/account stats (default window: last 30 days).
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/stats?since=2026-09-01T00:00:00.000Z"
```

### Reading mail

```bash
# Message list — newest first, keyset-paginated.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/messages?needs_me=1&limit=25"

# Same list, filtered by account / direction / category / date window.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/messages?account=gmail:me@gmail.com&direction=inbound&since=2026-09-01T00:00:00.000Z"

# One message: envelope + locations + classification. Add include=body for the
# cached html/text (never triggers a live provider read). 404 if unknown.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/messages/<key>?include=body"

# Every message sharing the key's threadKey, newest first.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/threads/<key>"

# Cached LLM thread summary (2-4 sentences). 404 if unknown,
# 503 if the LLM is unconfigured.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/threads/<key>/summary"

# Full-text search over envelopes (subject, addresses, classification
# summaries — never bodies).
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/search?q=invoice&limit=25"

# Messages the classifier flagged as needing action, newest first.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/needs-action?limit=25"
```

### Acting on mail

```bash
# Draft a reply as the owner would write it (plain text; this never sends).
# 404 if unknown, 503 if the LLM is unconfigured, 502 with
# {"error":"message_unavailable"} when the body isn't cached and no provider
# resolves for the message, or 502 with {"error":"read_failed"} when the live
# provider read fails.
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"key":"<key>","instructions":"be brief"}' \
  "https://mail.<domain>/api/drafts"

# Enqueue a registered template send. templateProps is required (there is no
# preview-props fallback). Returns { enqueued, sendLogId, jobId }; poll
# GET /api/jobs/:id for it. 404 if templateId is unknown.
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"templateId":"fpp-sender","to":"jane@example.com","templateProps":{"name":"Jane"}}' \
  "https://mail.<domain>/api/sends"

# Add/remove/set IMAP flags for a message in a given mailbox.
# 501 if the provider's capabilities report flag: false.
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mailbox":"INBOX","add":["\\Seen"]}' \
  "https://mail.<domain>/api/messages/<key>/flags"

# Move a message between mailboxes. 501 if the provider reports move: false.
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mailbox":"INBOX","toMailbox":"Archive"}' \
  "https://mail.<domain>/api/messages/<key>/move"

# Trigger a sync tick (async — returns immediately).
curl -X POST -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/sync"

# One job's status/attempts/error, by the id an enqueuing call returned.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/jobs/<jobId>"
```

### Submissions, templates and the send log

```bash
# Contact-form submissions (verdict/source/delivered filters).
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/submissions?verdict=spam&limit=25"

# Every registered template (id, name, preview props, last test-send).
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/templates"

# A template rendered with its registry preview props, as raw text/html.
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/templates/<id>/preview?width=375"

# Send a template to the owner's own address (RECEIVER_EMAIL).
curl -X POST -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/templates/<id>/test-send"

# Send history, newest first (optional templateId filter).
curl -H "Authorization: Bearer $API_KEY" \
  "https://mail.<domain>/api/send-log?templateId=<id>&limit=25"
```

## MCP `/mcp`

Point an MCP client at the endpoint; it authenticates with the same bearer key:

```json
{
  "type": "http",
  "url": "https://mail.<domain>/mcp",
  "headers": { "Authorization": "Bearer ${API_KEY}" }
}
```

No `timeout` override is needed — every tool call resolves synchronously
against the service layer (`createMcpHandler` in `src/mcp/plugin.ts`), unlike
an agent job system where a call may block for minutes.

| Tool               | Wraps                           | Arguments                                                   |
| ------------------ | ------------------------------- | ----------------------------------------------------------- |
| `search_mail`      | `GET /api/search`               | `q`, `account?`, `limit?`                                   |
| `read_message`     | `GET /api/messages/:key`        | `key`, `includeBody?`                                       |
| `summarize_thread` | `GET /api/threads/:key/summary` | `key`                                                       |
| `needs_action`     | `GET /api/needs-action`         | `account?`, `since?`, `until?`, `limit?`, `cursor?`         |
| `draft_reply`      | `POST /api/drafts`              | `key`, `instructions?` (text only — never sends)            |
| `send_template`    | `POST /api/sends`               | `templateId`, `to`, `templateProps`, `subject?`, `replyTo?` |
| `job_status`       | `GET /api/jobs/:id`             | `jobId`                                                     |

A tool call that hits a service `{ ok: false, error }` returns an MCP error
result (`isError: true`) whose text names the error code; a successful call
returns the same payload as `structuredContent`.

Because REST and MCP are two thin wrappers over the one
`src/services/agent-api.ts` service layer — neither talks to SQLite or a mail
provider directly — behavior is identical whichever door you use. The paths
above and the MCP tools are one implementation, not two; pick whichever fits
the client.
