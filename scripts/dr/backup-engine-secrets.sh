#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-engine-secrets.sh — the one thing that lives on only one disk
#
# Everything the platform needs to be rebuilt is reproducible EXCEPT the
# engine's server/.env: the Supabase service role, the internal API key, the
# TURN auth secret, the alert webhook secret. Code comes from GitHub, schema
# and chips from Supabase, but these secrets exist only on the Hetzner engine
# box (verified 2026-09-01: not in any repo, not in Vercel, not in the DB).
# If that disk dies, a rebuilt engine cannot connect to anything.
#
# This pulls server/.env over SSH and stores it AES-256 encrypted under
# ~/Documents/club-arena/.dr-backups/ (gitignored). The passphrase lives in
# the macOS login keychain (service `dr-engine-env-pass`), so the ciphertext
# is useless on its own. Run it after any secret rotation; a scheduled
# LaunchAgent or a manual habit both work. Restore instructions:
#   docs/dr/RESTORE-RUNBOOK.md, "Engine box is gone".
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
DIR="$HOME/Documents/club-arena/.dr-backups"
KEY="${ENGINE_SSH_KEY:-$HOME/.ssh/hetzner_engine_key}"
HOST="${ENGINE_HOST:-engine.smarter.poker}"
mkdir -p "$DIR"; chmod 700 "$DIR"

PASS=$(security find-generic-password -a smarter-poker -s dr-engine-env-pass -w 2>/dev/null || true)
if [ -z "$PASS" ]; then
  PASS=$(openssl rand -hex 32)
  security add-generic-password -a smarter-poker -s dr-engine-env-pass -w "$PASS" -U
  echo "created a new backup passphrase in the login keychain (service dr-engine-env-pass)"
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "root@$HOST" 'cat /opt/club-arena/server/.env' > "$TMP"
N=$(grep -cE '^[A-Z_]+=' "$TMP" || echo 0)
if [ "$N" -lt 8 ]; then echo "refusing: only $N keys read, that is not the real .env" >&2; exit 1; fi

openssl enc -aes-256-cbc -pbkdf2 -salt -in "$TMP" -out "$DIR/engine.env.enc" -pass pass:"$PASS"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$DIR/engine.env.enc.stamp"
echo "backed up $N engine secrets, encrypted -> $DIR/engine.env.enc (stamped $(cat "$DIR/engine.env.enc.stamp"))"
