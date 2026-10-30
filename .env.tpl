# Local dev secrets template — consumed via `secrets-run` (drop-in `op run`
# shim; see ~/.claude/CLAUDE.md "Headless secrets" — the mini is not
# interactively signed in, so a bare `op read`/`op run` hangs). Safe to
# commit: only op:// references or non-secret plain values, no secrets.
# Verify exact vault/item paths with `/secrets` before relying on a new one.
#
# Only the model keys come from 1Password. Everything prod-only is a local
# placeholder, so the mini's secrets cache never holds a key that can send real
# mail or open the live /app. The SES credentials are dummies: local sends fail
# and land on the job queue's retry ladder instead of reaching anyone.

SECRET_KEY=local-dev-secret-key
SES_REGION=eu-central-1
SES_ACCESS_KEY_ID=local-dev-dummy
SES_SECRET_ACCESS_KEY=local-dev-dummy
SES_CONFIGURATION_SET=local-dev-dummy
RECEIVER_EMAIL=dev@example.com
SY_SERENDIPITY_RECEIVER_EMAIL=dev-charter@example.com

# Spam filter — shared IU endpoint creds (same item research-gateway and argo use).
LLM_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
LLM_API_KEY=op://common/anthropic/API_KEY
LLM_MODEL=gpt-6-luna

# Shadow decision lane ("Jev"). DECISION_PROVIDER=ue (default) sends
# `pplx-decider-v1-27b` to IU's decision API (systemone, via @ai-sdk/typesafe-ai)
# on the origin of LLM_BASE_URL with LLM_API_KEY; `openrouter` uses the key below with an OpenRouter model id.
# Missing creds -> disabled.
# DECISION_PROVIDER=ue
# DECISION_MODEL=pplx-decider-v1-27b
# DECISION_BASE_URL=<ue-origin>/decisions/v1
# DECISION_PROVIDER=openrouter
# DECISION_MODEL=cloudflare/clef
OPENROUTER_API_KEY=op://common/openrouter/API_KEY

# /app session login (basic password auth, signed HttpOnly cookie); /app 404s
# when unset.
ADMIN_PASSWORD=local-dev-password

# /api/* + /mcp bearer key; both 404 when unset.
API_KEY=local-dev-api-key

# GET /sy-serendipity/requests bearer key (read-only SY Serendipity admin feed);
# 404 when unset, min 32 chars. Prod: op://vps/email-gateway/SY_SERENDIPITY_READ_KEY.
SY_SERENDIPITY_READ_KEY=local-dev-sy-serendipity-read-key-0123

# IMAP ingest (Proton Mail Bridge on the homelab) is deliberately left UNSET
# here: the tailnet ACL grants only VPS -> homelab tcp:1143 (verified
# 2026-09-28, docs/waves/PLAN.md Wave 4) — the mini cannot reach Bridge
# directly, so local dev always runs with Proton ingest disabled. Verify
# IMAP-touching changes against the live production container instead (Wave
# 4/5's `ssh vps` + `docker exec` probe pattern), never against this env.

# Gmail IMAP (imap.gmail.com, public internet — no tailnet restriction).
# Unset until the app password is in 1Password (docs/waves/PLAN.md Wave 5
# "Open item for the delivery lead"); uncomment once it lands.
# GMAIL_IMAP_USER=op://vps/email-gateway/GMAIL_IMAP_USER
# GMAIL_IMAP_APP_PASSWORD=op://vps/email-gateway/GMAIL_IMAP_APP_PASSWORD

# Host gate for /app, /api, /mcp (src/host-gate.ts). Left unset in dev, same
# as prod until Wave 9's cutover sets it — see docs/vps-cutover.md.
# MAIL_HOST=
