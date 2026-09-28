# VPS topology cutover (Wave 9)

Every change below is **ready to apply, not applied** — Wave 9's own rule
(`docs/waves/PLAN.md`): a wave never pushes outside this repo, never publishes
a hostname, and never edits another repo's deploy path. This doc is the
handover; the owner applies it.

## 1. Tailnet ACL grant (`dotfiles-private/tailscale-acl.jsonc`)

`scripts/backup.sh` (§4 below) needs `tag:vps → tag:homelab` SSH to rsync
snapshots to `homelab:/mnt/hdd/backups/email-gateway/`. Today's grant (verified
2026-09-28) is:

```jsonc
{
  // VPS → Homelab: argo → garmin-collector via Caddy (443),
  // argo → docker-socket-proxy-claude (2376),
  // email-gateway → proton-bridge IMAP (1143)
  "src": ["tag:vps"],
  "dst": ["tag:homelab"],
  "ip":  ["tcp:443", "tcp:1143", "tcp:2376"],
},
```

Add `tcp:22`:

```jsonc
"ip":  ["tcp:22", "tcp:443", "tcp:1143", "tcp:2376"],
```

Apply with `dotfiles/scripts/tailscale-acl-sync.sh` (or however that repo's
own workflow pushes ACL changes) and confirm `ssh homelab` works **from the
VPS host**, not just from the Mac, before relying on the backup cron.

## 2. DNS record (Cloudflare)

A **DNS-only** (grey cloud, not proxied) A record, matching the `hyperdx`/
`argo` precedent in `vps/compose.monitoring.yml` and `vps/Makefile`:

| Name             | Type | Target                                                     | Proxy    |
| ---------------- | ---- | ---------------------------------------------------------- | -------- |
| `mail.${DOMAIN}` | A    | `${VPS_TAILSCALE_IP}` (`op://vps/config/VPS_TAILSCALE_IP`) | DNS only |

The VPS's CGNAT tailnet IP (100.x.x.x) is unreachable from the public
internet, same reasoning as `hyperdx.${DOMAIN}`. **This is not "DNS is the
access control" on its own** — that phrasing (copied from the existing
`hyperdx`/`argo` comments) undersells the actual enforcement: Traefik's
`websecure` entrypoint is published as `${VPS_TAILSCALE_IP}:443:443`
(`vps/compose.networking.yml`, verified 2026-09-28 for this wave), **not**
`0.0.0.0:443` — so the mail router is unreachable even by a client that knows
the tailnet IP and forges `Host`/SNI, unless it can actually route packets to
that CGNAT address (i.e. is a tailnet member). Public apps reach Traefik only
via cloudflared's outbound tunnel connection, which this record deliberately
bypasses. Two independent layers (non-routable target + listener not bound to
any publicly reachable interface), not one. Use the `cloudflare` skill against
the `vps` zone, `op_account_for_cwd` resolving to `tkrumm`.

## 3. `vps/apps/email-gateway/compose.yml`

Add `MAIL_HOST` to `environment:` and a second Traefik router for the mail
surface on the tailnet-only hostname, alongside the existing public router
(send routes + `/health` stay on `email-gateway.${DOMAIN}`, ungated — Wave 6's
`MAIL_HOST` code already 404s `/app`/`/api`/`/mcp` on any Host that doesn't
match, so the public router reaching the same service/port is safe):

```yaml
environment:
  # ...existing vars unchanged...
  MAIL_HOST: mail.${DOMAIN}
  RESEND_ADMIN_API_KEY: ${EMAIL_GATEWAY_RESEND_ADMIN_API_KEY}
  IMAP_TLS_CERT: ${EMAIL_GATEWAY_IMAP_TLS_CERT}
  GMAIL_IMAP_USER: ${EMAIL_GATEWAY_GMAIL_IMAP_USER}
  GMAIL_IMAP_APP_PASSWORD: ${EMAIL_GATEWAY_GMAIL_IMAP_APP_PASSWORD}
  GMAIL_IMAP_MAILBOXES: ${EMAIL_GATEWAY_GMAIL_IMAP_MAILBOXES}
```

```yaml
labels:
  # ...existing public router (email-gateway.${DOMAIN}) unchanged, plus
  # an explicit service name so both routers can point at it...
  - "traefik.http.routers.email-gateway.service=email-gateway"
  # Mail surface — reachable only over the tailnet: the A record (DNS-only/
  # grey cloud) resolves to the VPS's CGNAT tailnet IP, and Traefik's
  # websecure entrypoint is itself published only on that same IP
  # (compose.networking.yml), not 0.0.0.0 — a forged Host/SNI header from
  # the public internet has no route to hit this router at all.
  - "traefik.http.routers.email-gateway-mail.rule=Host(`mail.${DOMAIN}`)"
  - "traefik.http.routers.email-gateway-mail.entrypoints=websecure"
  - "traefik.http.routers.email-gateway-mail.tls.certresolver=letsencrypt"
  - "traefik.http.routers.email-gateway-mail.service=email-gateway"
```

`IMAP_TLS_INSECURE: "true"` can come out once `IMAP_TLS_CERT` is set and
verified (Bridge's pinned cert takes over — see `AGENTS.md` §Invariants "IMAP
sync stays read-only").

## 4. `vps/apps/email-gateway/.env.tpl`

Add, matching the existing `EMAIL_GATEWAY_<VAR>=op://vps/email-gateway/<VAR>`
convention:

```
# Gmail IMAP ingest — app password lands separately (docs/waves/PLAN.md Wave 5
# "Open item for the delivery lead"). Unset user -> Gmail ingest disabled.
EMAIL_GATEWAY_GMAIL_IMAP_USER=op://vps/email-gateway/GMAIL_IMAP_USER
EMAIL_GATEWAY_GMAIL_IMAP_APP_PASSWORD=op://vps/email-gateway/GMAIL_IMAP_APP_PASSWORD
EMAIL_GATEWAY_GMAIL_IMAP_MAILBOXES=op://vps/email-gateway/GMAIL_IMAP_MAILBOXES

# Full-access Resend key for send-log reconciliation (reconcile_send_log job).
EMAIL_GATEWAY_RESEND_ADMIN_API_KEY=op://vps/email-gateway/RESEND_ADMIN_API_KEY

# Pinned Bridge server certificate (PEM, literal "\n" — see src/utils/pem.ts),
# replacing IMAP_TLS_INSECURE once verified.
EMAIL_GATEWAY_IMAP_TLS_CERT=op://vps/email-gateway/IMAP_TLS_CERT
```

Refresh with the existing `make email-gateway-env` target — no new Makefile
target needed.

## 5. Backup cron (VPS host, not a container)

`scripts/backup.sh` + `scripts/backup.ts` VACUUM-INTO snapshot both SQLite
files and rsync them to `homelab:/mnt/hdd/backups/email-gateway/` — a new
subdirectory under the path homelab's restic container already walks to B2
(`homelab/docs/backups.md`), so it needs no homelab-side change once §1's ACL
grant lands. `scripts/backup.ts`'s snapshot/prune logic is unit-tested
(`scripts/backup.test.ts`, including the per-database isolation and integrity
checks below); `scripts/backup.sh`'s own shell logic (container discovery,
the empty-source guard, the rsync invocation) is not — this repo has no
shell-test harness — so it was smoke-tested by hand with `docker`/`rsync`
replaced by stub scripts on `PATH`, not against a real container; dry-run it
against the real thing before trusting the cron job unattended.

`scripts/backup.sh` mirrors an accepted, bounded tradeoff from
`warden/scripts/warden-backup.sh`, the pattern it follows: `rsync --delete`
mirrors local retention (`backup.ts`'s `KEEP=7` per database) onto homelab,
so a tailnet outage longer than 7 daily runs would let local pruning drop a
snapshot this rsync never shipped, and the next successful run's `--delete`
then removes homelab's now-orphaned older copy too. A real but bounded
retention-window risk, not unbounded data loss — restic's own
daily/weekly/monthly/yearly retention on the homelab side
(`homelab/docs/backups.md`) is the actual long-term archive. What the script
_does_ guard explicitly: an empty/wrong host-side `$DATA_DIR` (a mount-path
drift distinct from "no database found," which `backup.ts` already catches)
refuses to run `rsync --delete` against nothing, and a single-instance lock
(warden's `mkdir`-based pattern) stops two overlapping runs from racing each
other's snapshot files.

`scripts/backup.sh` runs `docker exec "$CONTAINER" bun run scripts/backup.ts`
— that always executes **whatever image RollHook most recently deployed**
into the running container, never a separately-checked-out copy. The only
reason a host-side checkout of this repo is needed at all is that
`scripts/backup.sh` itself (the outer wrapper: container discovery + rsync)
has to live somewhere on the VPS host for cron to invoke — it is not a second
deployment path for the backup logic, only for the wrapper, and that wrapper
changes rarely. Mirrors how `vps/cron/pg-backup` runs against
`/home/jkrumm/vps`, a checkout of that repo:

```bash
# One-time, on the VPS host:
git clone https://github.com/jkrumm/email-gateway.git /home/jkrumm/email-gateway
```

Cron entry (`/etc/cron.d/email-gateway-backup`, matching `vps/cron/pg-backup`'s
shape):

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

10 3 * * * jkrumm /bin/bash -c 'cd /home/jkrumm/email-gateway && git pull --ff-only && ./scripts/backup.sh' >> /home/jkrumm/email-gateway-backup.log 2>&1
```

03:10 matches warden's own backup slot rationale (`warden/scripts/warden-backup.sh`
header) — before homelab's 03:30 restic sweep. No Uptime Kuma push monitor is
wired yet; add one (`email-gateway Backup - Push`, `uptime-kuma/monitors.yaml`)
once the cron entry is live, matching `Warden Backup - Push`'s shape. Not a
blocker for the cron entry itself.

## 6. Owner's checklist

1. Apply §1 (ACL grant) and §2 (DNS record).
2. Apply §3/§4 to the `vps` repo, run `make email-gateway-env` then `make
email-gateway-up` to recreate the container with the new env + labels.
3. Clone this repo on the VPS host and install the §5 cron entry.
4. Once Gmail's app password is in 1Password (`op://vps/email-gateway/
GMAIL_IMAP_USER`/`GMAIL_IMAP_APP_PASSWORD`) and a sync has run
   successfully against it in prod: **revoke argo's Gmail OAuth scope** (the
   argo `/gmail/*` deletion PR from Wave 5,
   [jkrumm/argo#20](https://github.com/jkrumm/argo/pull/20), stays unmerged
   until this step — merging it first would cut Gmail reads with nothing yet
   replacing them).
5. Once the mail surface (`https://mail.${DOMAIN}`) is confirmed reachable
   and `/app` login works: **delete `email-gateway.sqlite`**
   (`/var/lib/email-gateway/email-gateway.sqlite` on the VPS) — the fresh
   store (`mail.sqlite`) is authoritative and `scripts/import-legacy.ts`
   already migrated the one thing it couldn't rebuild (`submissions`). Not
   automated by any wave (D4).
6. Merge the Hermes repoint PR
   ([jkrumm/hermes-agent#3](https://github.com/jkrumm/hermes-agent/pull/3))
   once `https://mail.${DOMAIN}/mcp` is reachable and bearer-tested.
