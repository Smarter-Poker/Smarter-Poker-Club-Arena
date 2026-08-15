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

systemctl daemon-reload
systemctl enable --now club-arena-supervisor.timer
# Also ensure Docker itself comes back after a host reboot — without this the
# container restart policy never gets a chance to run.
systemctl enable docker >/dev/null 2>&1 || true

echo "installed. next run:"
systemctl list-timers club-arena-supervisor.timer --no-pager | head -3
