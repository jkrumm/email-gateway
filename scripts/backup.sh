#!/usr/bin/env bash
# email-gateway backup — VACUUM INTO snapshot (scripts/backup.ts, run inside the
# production container) + rsync to the homelab backup target, mirroring
# warden/scripts/warden-backup.sh. Runs on the VPS HOST via cron — see
# docs/vps-cutover.md for the ready-to-apply cron entry — never from a dev
# checkout, since both the running container and the bind-mounted
# /var/lib/email-gateway only exist there.
#
# NOT YET WIRED: the rsync leg needs an SSH grant this repo cannot add on its
# own — the tailnet ACL today only allows VPS -> homelab tcp:443/1143/2376
# (dotfiles-private/tailscale-acl.jsonc), no tcp:22. See docs/vps-cutover.md
# for the exact grant to request before enabling this script's cron entry.
set -euo pipefail

# The host side of vps/apps/email-gateway/compose.yml's
# `/var/lib/email-gateway:/data` bind mount — src/env.ts's DATA_DIR default
# is the container-side path (/data in prod); this is the same directory
# viewed from the host, so a change to either mount path must update both.
DATA_DIR="/var/lib/email-gateway"
DEST="homelab:/mnt/hdd/backups/email-gateway/"

# Single-instance lock — same shape as warden-backup.sh: a concurrent second
# run (a manual retry overlapping cron) racing this one would let its sweep
# of stale .tmp files delete the other's in-progress snapshot mid-VACUUM.
# `mkdir` is atomic and cannot half-exist the way a bare PID file can. Under
# $DATA_DIR (not world-writable /tmp) since that directory already belongs
# solely to this backup process on the VPS host.
LOCK_DIR="${EMAIL_GATEWAY_BACKUP_LOCK_DIR:-$DATA_DIR/.backup.lock}"
# Accepted, matching warden-backup.sh's identical shape rather than
# engineered around here: a narrow empty-pid-file window right after mkdir
# (a concurrent run sees no holder yet and could misjudge a live lock as
# abandoned), the rm-rf+mkdir reclaim not being atomic, and a reused PID
# after a reboot making `kill -0` succeed forever. All near-impossible on a
# once-daily cron with no long-running overlap; a `flock`-based lock would
# close them for real if this job's blast radius ever grows.
# Both "skip" branches below exit 0, identical to a real success — matches
# warden-backup.sh, which is fine there because nothing pings a monitor on
# exit code alone. Whoever wires the Uptime Kuma push monitor noted in
# docs/vps-cutover.md §5 must gate the ping on the "backup synced" log line
# (or a distinct signal), not on this script's exit code, or an indefinite
# lock-skip loop would read as healthy.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [[ -n "$HOLDER" ]] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "another backup (pid $HOLDER) is still running — skipping this run" >&2
    exit 0
  fi
  echo "reclaiming an abandoned lock (pid ${HOLDER:-unknown})" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || { echo "lost the race for $LOCK_DIR — skipping this run" >&2; exit 0; }
fi
printf '%s' "$$" >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# The bind-mounted volume is shared by every container for this service
# regardless of which one (old or new, during a brief RollHook deploy
# overlap) runs the snapshot — so any one running instance works. Selected by
# the compose service label rather than a hardcoded container name, since
# Compose's default naming isn't stable across how the project is invoked.
CONTAINER=$(docker ps --filter "label=com.docker.compose.service=email-gateway" --format "{{.Names}}" | head -n1)
if [[ -z "$CONTAINER" ]]; then
  echo "no running email-gateway container — skipping backup" >&2
  exit 1
fi

# Runs scripts/backup.ts from whatever image RollHook most recently deployed
# into $CONTAINER — never from this script's own on-host checkout. The
# checkout backing THIS file only needs to be refreshed (`git pull`) to pick
# up changes to backup.sh itself; it never diverges from what actually
# snapshots the databases.
docker exec "$CONTAINER" bun run scripts/backup.ts

# Refuse to mirror an empty/missing source onto the offsite copy with
# --delete. Safe today by construction — backup.ts above already throws
# (aborting this script under `set -e`) when it finds no database at all —
# but that's a different failure mode from DATA_DIR drifting out of sync
# with the container's actual bind-mount path, which would leave THIS
# host-side view of "$DATA_DIR/backups" empty even though the container's
# own backup just succeeded. This guard is what actually catches that case.
if ! compgen -G "$DATA_DIR/backups/"*.db >/dev/null; then
  echo "no snapshot files under $DATA_DIR/backups — refusing to rsync --delete (would wipe the offsite copy)" >&2
  exit 1
fi

# --delete mirrors local retention (backup.ts's KEEP=7 per database) onto
# homelab — accepted, not engineered around: warden's own backup script
# (the pattern this mirrors) has the identical shape and the identical
# tradeoff. An outage in the tailnet link longer than KEEP daily runs would
# let local pruning drop snapshots this rsync never shipped, and the next
# successful run's --delete then removes homelab's now-orphaned older
# copies too — a real but bounded retention-window risk, not an unbounded
# data-loss one (restic's own daily/weekly/monthly/yearly retention on the
# homelab side, homelab/docs/backups.md, is the actual long-term archive).
/usr/bin/rsync -az --delete \
  --exclude='*-wal' \
  --exclude='*-shm' \
  "$DATA_DIR/backups/" "$DEST"

echo "backup synced to $DEST"
