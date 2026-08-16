#!/usr/bin/env bash
#
# install-engine-supervisor.sh — idempotent installer for the host-side engine
# supervisor. Run on the Hetzner box as root. Safe to re-run; the deploy
# workflow re-runs it on every deploy so the unit can never drift out of the
# repo.
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/club-arena}"
SUPERVISOR="$REPO_DIR/server/scripts/engine-supervisor.sh"

[ -f "$SUPERVISOR" ] || { echo "FATAL: $SUPERVISOR not found"; exit 1; }
chmod +x "$SUPERVISOR" "$REPO_DIR/server/scripts/engine-up.sh"
mkdir -p /var/lib/club-arena

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
ExecStart=$REPO_DIR/server/scripts/verify-recovery-stack.sh
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
