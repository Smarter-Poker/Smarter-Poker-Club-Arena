#!/usr/bin/env bash
# Authorized offline disaster-recovery backup only. This is not a release,
# deploy, watcher, scheduler, or alternate runtime credential path. It cannot
# discover credentials from a repository or workstation env file and it has no
# default SSH host or key. See docs/dr/RESTORE-RUNBOOK.md.
set -euo pipefail
umask 077

if [ "${1:-}" != "--authorized-offline-backup" ]; then
  echo "refusing: this sealed DR operation requires --authorized-offline-backup" >&2
  exit 2
fi

: "${DR_ENGINE_HOST:?set DR_ENGINE_HOST from the authorized DR record}"
: "${DR_ENGINE_SSH_KEY_FILE:?set DR_ENGINE_SSH_KEY_FILE to the authorized DR key path}"
: "${DR_ENGINE_HOST_KEY:?set DR_ENGINE_HOST_KEY to the pinned known_hosts line}"

if [ ! -f "$DR_ENGINE_SSH_KEY_FILE" ]; then
  echo "refusing: DR_ENGINE_SSH_KEY_FILE is not a regular file" >&2
  exit 2
fi

BACKUP_DIR="${DR_BACKUP_DIR:-$HOME/Documents/club-arena/.dr-backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

PASS=$(security find-generic-password -a smarter-poker -s dr-engine-env-pass -w 2>/dev/null || true)
if [ -z "$PASS" ]; then
  echo "refusing: the authorized DR passphrase is absent from the login keychain" >&2
  exit 2
fi

DR_TMP_DIR=$(mktemp -d)
trap 'rm -rf "$DR_TMP_DIR"' EXIT
printf '%s\n' "$DR_ENGINE_HOST_KEY" > "$DR_TMP_DIR/known_hosts"
chmod 600 "$DR_TMP_DIR/known_hosts"

ssh -i "$DR_ENGINE_SSH_KEY_FILE" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$DR_TMP_DIR/known_hosts" \
  "root@$DR_ENGINE_HOST" \
  'cat /opt/club-arena/server/.env' > "$DR_TMP_DIR/engine.env"

KEY_COUNT=$(grep -cE '^[A-Z_]+=' "$DR_TMP_DIR/engine.env" || true)
if [ "${KEY_COUNT:-0}" -lt 8 ]; then
  echo "refusing: the remote response did not satisfy the engine env contract" >&2
  exit 1
fi

openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$DR_TMP_DIR/engine.env" \
  -out "$DR_TMP_DIR/engine.env.enc" \
  -pass pass:"$PASS"

mv "$DR_TMP_DIR/engine.env.enc" "$BACKUP_DIR/engine.env.enc"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$BACKUP_DIR/engine.env.enc.stamp"
chmod 600 "$BACKUP_DIR/engine.env.enc" "$BACKUP_DIR/engine.env.enc.stamp"
echo "sealed engine DR backup refreshed and stamped; no credential values were printed"
