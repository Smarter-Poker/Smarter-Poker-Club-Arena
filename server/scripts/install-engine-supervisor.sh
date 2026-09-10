#!/usr/bin/env bash
#
# install-engine-supervisor.sh — idempotent installer for the host-side engine
# supervisor. Run on the Hetzner box as root. Safe to re-run; the deploy
# workflow re-runs it on every deploy so the unit can never drift out of the
# repo.
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/club-arena}"
SOURCE_DIR="${ENGINE_CONTROL_SOURCE_DIR:-$REPO_DIR/server/scripts}"
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
CONTROL_PARENT="$(dirname "$CONTROL_DIR")"
GENERATION_ROOT="$CONTROL_PARENT/engine-control-generations"
SUPERVISOR="$CONTROL_DIR/engine-supervisor.sh"
LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"

fsync_paths() {
  python3 - "$@" <<'PY'
import os
import sys

for path in sys.argv[1:]:
    flags = os.O_RDONLY
    if os.path.isdir(path):
        flags |= getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

for file in engine-supervisor.sh engine-up.sh engine-release-seal.py verify-recovery-stack.sh; do
  [ -f "$SOURCE_DIR/$file" ] || { echo "FATAL: $SOURCE_DIR/$file not found"; exit 1; }
done

# Serialize the control-plane swap with every engine mutation. The supervisor
# takes this same lock non-blocking, so no timer can execute a mixed generation
# while these files are staged or activated.
exec 9>"$LOCK_FILE"
flock -w 180 9 || { echo "FATAL: could not acquire $LOCK_FILE for control-plane refresh"; exit 1; }

# This path did not exist before the seal rollout. Refuse to replace an
# unexpected physical directory: renaming a directory away and creating a
# symlink leaves a crash window with no control plane at all.
if [ -e "$CONTROL_DIR" ] && [ ! -L "$CONTROL_DIR" ]; then
  echo "FATAL: $CONTROL_DIR exists and is not the managed generation symlink"
  exit 1
fi

# The recovery authority must survive `git reset --hard` of the application
# checkout. Install a complete immutable generation, validate it, then replace
# one symlink atomically. Copying live files one-by-one can expose new
# supervisor bytes with an old seal (or the reverse) if the installer dies.
install -d -m 0755 "$CONTROL_PARENT" "$GENERATION_ROOT"
GENERATION_ID="${ENGINE_RELEASE_RUN_ID:-manual}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
case "$GENERATION_ID" in (*[!A-Za-z0-9._-]*) echo "FATAL: unsafe control generation id"; exit 1;; esac
GENERATION_DIR="$GENERATION_ROOT/$GENERATION_ID"
[ ! -e "$GENERATION_DIR" ] || { echo "FATAL: control generation already exists: $GENERATION_DIR"; exit 1; }
install -d -m 0755 "$GENERATION_DIR"
install -m 0755 \
  "$SOURCE_DIR/engine-supervisor.sh" \
  "$SOURCE_DIR/engine-up.sh" \
  "$SOURCE_DIR/engine-release-seal.py" \
  "$SOURCE_DIR/verify-recovery-stack.sh" \
  "$GENERATION_DIR/"
for script in engine-supervisor.sh engine-up.sh verify-recovery-stack.sh; do
  bash -n "$GENERATION_DIR/$script"
done
python3 -c 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")' \
  "$GENERATION_DIR/engine-release-seal.py"
install -d -m 0700 /var/lib/club-arena

# One-time migration for an already-serving host. Bootstrap from the running
# container's immutable image ID and baked full SHA, never from :current or the
# mutable repository checkout. Once present, bootstrap-running is a no-op.
"$GENERATION_DIR/engine-release-seal.py" bootstrap-running \
  --container "${CONTAINER:-club-arena-engine}" \
  --run-id "${ENGINE_RELEASE_RUN_ID:-0}" \
  --run-url "${ENGINE_RELEASE_RUN_URL:-https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/0}" \
  --actor "${ENGINE_RELEASE_ACTOR:-installer}" \
  --reason "${ENGINE_RELEASE_REASON:-install durable engine release authority}"

# Make the complete generation and its directory entries durable before it can
# become active. The two parent-directory syncs around the rename make the
# symlink swap atomic across power loss, not merely atomic to live readers.
fsync_paths \
  "$GENERATION_DIR/engine-supervisor.sh" \
  "$GENERATION_DIR/engine-up.sh" \
  "$GENERATION_DIR/engine-release-seal.py" \
  "$GENERATION_DIR/verify-recovery-stack.sh" \
  "$GENERATION_DIR" \
  "$GENERATION_ROOT" \
  "$CONTROL_PARENT"
NEXT_LINK="$CONTROL_PARENT/.engine-control.next.$$"
rm -f "$NEXT_LINK"
ln -s "$GENERATION_DIR" "$NEXT_LINK"
fsync_paths "$CONTROL_PARENT"
mv -Tf "$NEXT_LINK" "$CONTROL_DIR"
fsync_paths "$CONTROL_PARENT"

cat > /etc/systemd/system/club-arena-supervisor.service <<UNIT
[Unit]
Description=Club Arena engine supervisor (guarantees the engine is up and serving)
After=docker.service
Requires=docker.service
# The supervisor is the recovery mechanism — it must not be rate-limited into
# uselessness by systemd if it has to act several times in a row. This key
# belongs in [Unit], not [Service]; systemd 255 warns and ignores it there.
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=$SUPERVISOR
Environment=ENGINE_CONTROL_DIR=$CONTROL_DIR
UNIT

cat > /etc/systemd/system/club-arena-supervisor.timer <<'UNIT'
[Unit]
Description=Run the Club Arena engine supervisor every 60s

[Timer]
# Fire 90s after boot so Docker has settled, then every 60s.
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=club-arena-supervisor.service

[Install]
WantedBy=timers.target
UNIT

# ── Daily recovery-stack verification ────────────────────────────────────────
# The recovery stack is entirely passive: every layer sits idle until something
# breaks, so every layer can rot silently for months and only reveal itself
# during the incident it existed to prevent. (Precedent: the Docker HEALTHCHECK
# was believed to be self-healing for a full release cycle before anyone checked
# that plain Docker never restarts an unhealthy container.) This asserts the
# wiring daily and publishes the result for Prometheus to alert on.
cat > /etc/systemd/system/club-arena-verify.service <<UNIT
[Unit]
Description=Verify the Club Arena recovery stack is still wired up
After=docker.service

[Service]
Type=oneshot
ExecStart=$CONTROL_DIR/verify-recovery-stack.sh
Environment=ENGINE_CONTROL_DIR=$CONTROL_DIR
UNIT

cat > /etc/systemd/system/club-arena-verify.timer <<'UNIT'
[Unit]
Description=Daily Club Arena recovery-stack verification

[Timer]
OnCalendar=*-*-* 09:17:00 UTC
Persistent=true
RandomizedDelaySec=120
Unit=club-arena-verify.service

[Install]
WantedBy=timers.target
UNIT

# ── Operator SSH keys, declaratively ────────────────────────────────────────
# The host's authorized_keys was rewritten three times on 2026-08-16 by different
# automation, twice locking the operator out mid-incident while CI kept working,
# so the lockout stayed invisible until someone tried to inspect the box. Keys in
# infra/security/operator_keys.pub are ensured present on every deploy.
#
# APPEND-ONLY BY DESIGN: it never removes a line, so it cannot lock out CI or
# anyone else, and it is not authoritative for revocation. These are public keys;
# the private halves never leave the operator's machine.
KEYFILE="$REPO_DIR/infra/security/operator_keys.pub"
if [ -f "$KEYFILE" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  ADDED=0
  while IFS= read -r key; do
    case "$key" in ''|\#*) continue ;; esac
    if ! grep -qxF "$key" /root/.ssh/authorized_keys 2>/dev/null; then
      printf '%s\n' "$key" >> /root/.ssh/authorized_keys
      ADDED=$((ADDED + 1))
    fi
  done < "$KEYFILE"
  if [ "$ADDED" -gt 0 ]; then echo "  authorized_keys: added $ADDED operator key(s)"; else echo "  authorized_keys: all operator keys present"; fi
fi

# ── fail2ban: stop banning our own operators ────────────────────────────────
# The sshd jail was installed with `mode = aggressive`, which counts pre-auth
# disconnects as failures. That is what banned the GitHub Actions runners on
# 2026-08-15 (ssh-keyscan opens five parallel probes) and what banned the
# operator's own workstation twice on 2026-08-16 during normal admin work —
# port 22 goes from "Permission denied" to "Connection refused" and stays that
# way for 24h.
#
# PasswordAuthentication is off on this host, so brute force cannot succeed
# regardless. `mode = normal` still catches real failed authentications; it just
# stops counting the benign preauth chatter that legitimate tooling produces.
# ADMIN_ALLOW_IPS (space-separated, optional) is unbanned and permanently
# allowlisted on every deploy so an operator can never lock themselves out.
if command -v fail2ban-client >/dev/null 2>&1; then
  if [ -f /etc/fail2ban/jail.local ] && grep -q '^mode *= *aggressive' /etc/fail2ban/jail.local; then
    sed -i 's/^mode *= *aggressive/mode     = normal/' /etc/fail2ban/jail.local
    echo "  fail2ban: sshd jail aggressive -> normal (password auth is off; aggressive only banned us)"
  fi
  # Self-configuring safety net: any address that has COMPLETED public-key
  # authentication in the last 24h is, by definition, not a brute-forcer. This
  # needs no secret, no repo variable, and no operator action — it simply undoes
  # bans against people who have already proven they hold a valid key. It is what
  # stops an operator being locked out of the box they are trying to fix.
  journalctl -u ssh --since '-24 hours' --no-pager 2>/dev/null \
    | grep -oE 'Accepted publickey for [^ ]+ from [0-9.]+' \
    | awk '{print $NF}' | sort -u | while read -r ip; do
        fail2ban-client set sshd unbanip "$ip" >/dev/null 2>&1 && echo "  fail2ban: unbanned $ip (has completed key auth)"
      done

  if [ -n "${ADMIN_ALLOW_IPS:-}" ]; then
    mkdir -p /etc/fail2ban/jail.d
    printf '[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 %s\n' "$ADMIN_ALLOW_IPS" > /etc/fail2ban/jail.d/01-admin-allowlist.local
    for ip in $ADMIN_ALLOW_IPS; do fail2ban-client set sshd unbanip "$ip" >/dev/null 2>&1 || true; done
    echo "  fail2ban: admin IPs allowlisted and unbanned: $ADMIN_ALLOW_IPS"
  fi
  fail2ban-client reload >/dev/null 2>&1 || systemctl reload fail2ban >/dev/null 2>&1 || true
fi

# ── Let Prometheus actually reach node-exporter ──────────────────────────────
# UFW defaults to DROP on INPUT. node-exporter runs with host networking, so a
# scrape from the docker bridge hits INPUT and is dropped — while the engine on
# :8080 stays reachable, because Docker publishes that through FORWARD. The
# result is a monitoring stack that looks entirely healthy and receives nothing.
# Scoped to the docker monitoring subnet; :9100 is never exposed to the internet.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q active; then
  SUB=$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -i monitoring | head -1 \
        | xargs -r -I{} docker network inspect {} -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)
  if [ -n "$SUB" ] && ! ufw status 2>/dev/null | grep -q "9100/tcp.*$SUB"; then
    ufw allow from "$SUB" to any port 9100 proto tcp \
      comment 'prometheus -> node-exporter (docker bridge only)' >/dev/null 2>&1 \
      && echo "  ufw: allowed $SUB -> :9100"
  fi
fi

systemctl daemon-reload
systemctl enable --now club-arena-supervisor.timer
systemctl enable --now club-arena-verify.timer
# Also ensure Docker itself comes back after a host reboot — without this the
# container restart policy never gets a chance to run.
systemctl enable docker >/dev/null 2>&1 || true

echo "installed. next runs:"
systemctl list-timers 'club-arena-*' --no-pager | head -4
