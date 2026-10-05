# Local dev secrets template — consumed via `secrets-run` (drop-in `op run`
# shim; see ~/.claude/CLAUDE.md "Headless secrets" — the mini is not
# interactively signed in, so a bare `op read`/`op run` hangs). Safe to
# commit: only op:// references or non-secret plain values, no secrets.
# Verify exact vault/item paths with `/secrets` before relying on a new one.
#
# Same vault the VPS deploy reads (vps/apps/email-gateway/.env.tpl) — a solo
# project has no separate dev secret set.

SECRET_KEY=op://vps/email-gateway/SECRET_KEY
RESEND_API_KEY=op://vps/email-gateway/RESEND_API_KEY
RECEIVER_EMAIL=op://vps/email-gateway/RECEIVER_EMAIL
SY_SERENDIPITY_RECEIVER_EMAIL=op://vps/email-gateway/SY_SERENDIPITY_RECEIVER_EMAIL

# Spam filter — shared IU endpoint creds (same item research-gateway and argo use).
LLM_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
LLM_API_KEY=op://common/anthropic/API_KEY
LLM_MODEL=gpt-6-luna

# Shadow decision lane ("Jev", Clef via OpenRouter Decisions API). Unset -> disabled.
OPENROUTER_API_KEY=op://common/openrouter/API_KEY

# Usage/cost reporting to Argo (src/usage/argo.ts). Unset -> no-op; prod posts
# to argo-api over the VPS proxy network.
# ARGO_USAGE_URL=https://argo.<your-domain>/api/usage/records
# ARGO_API_SECRET=op://common/api/SECRET
# MACHINE=mini

# /app session login (basic password auth, signed HttpOnly cookie); /app 404s
# when unset.
ADMIN_PASSWORD=op://vps/email-gateway/ADMIN_PASSWORD

# /api/* + /mcp bearer key; both 404 when unset.
API_KEY=op://vps/email-gateway/API_KEY

# Full-access Resend key for send-log reconciliation (src/jobs/reconcile-send-log.ts).
# Unset in prod today (README §Jev shadow mode / AGENTS.md) — uncomment once it's in 1Password.
# RESEND_ADMIN_API_KEY=op://vps/email-gateway/RESEND_ADMIN_API_KEY

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
