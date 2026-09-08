#!/usr/bin/env bash
#
# Install the one logging-only Caddy repair required by the engine WebSocket
# transport. Browsers carry the bearer token in Sec-WebSocket-Protocol during
# an upgrade; Caddy includes request headers in upstream-error records unless
# this field is explicitly removed by the global log encoder.
#
# This script deliberately does NOT copy a repository Caddyfile over the live
# one. The live file contains operator-managed routes and a real basic-auth
# password hash. We insert one marked global option, validate a candidate,
# atomically install it, and roll the exact prior file back if reload fails.
# Re-running is a validated config no-op followed by a graceful reload, which
# proves the in-memory server adopted the filter too.

set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
CADDY_BIN="${CADDY_BIN:-caddy}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
FLOCK_BIN="${FLOCK_BIN:-flock}"
LOCK_FILE="${CADDY_REDACTION_LOCK_FILE:-/var/lock/caddy-websocket-redaction.lock}"

if [[ ${EUID:-$(id -u)} -ne 0 && "${CADDY_INSTALL_ALLOW_NON_ROOT:-0}" != "1" ]]; then
  echo "[caddy-log-redaction] FATAL: must run as root"
  exit 1
fi
if [[ ! -f "$CADDYFILE" ]]; then
  echo "[caddy-log-redaction] FATAL: live config not found: $CADDYFILE"
  exit 1
fi
if [[ -L "$CADDYFILE" ]]; then
  echo "[caddy-log-redaction] FATAL: refusing to replace symlinked config: $CADDYFILE"
  exit 1
fi
# Monitoring bootstrap deliberately writes but does not reload its template
# until the operator replaces this value. Never let this installer become a
# back door that activates an unusable placeholder credential.
if grep -q 'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT' "$CADDYFILE"; then
  echo "[caddy-log-redaction] FATAL: live config still contains the monitoring password placeholder; refusing to reload it"
  exit 1
fi
for executable in "$CADDY_BIN" "$SYSTEMCTL_BIN" "$PYTHON_BIN" "$FLOCK_BIN"; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "[caddy-log-redaction] FATAL: required executable not found: $executable"
    exit 1
  fi
done

# deploy-monitoring and an operator may invoke this at the same time. Serialise
# candidate/backup/install so two individually safe runs cannot interleave.
exec 9>"$LOCK_FILE"
if ! "$FLOCK_BIN" -w 60 9; then
  echo "[caddy-log-redaction] FATAL: could not acquire installer lock: $LOCK_FILE"
  exit 1
fi

has_redaction() {
  grep -Eq \
    '^[[:space:]]*request>headers>Sec-Websocket-Protocol[[:space:]]+delete[[:space:]]*$' \
    "$1"
}

# Idempotence includes validation: "the line exists" is not proof that Caddy
# can load the file around it. Reload even on the no-op path: a previous run
# may have installed the file and then been interrupted before Caddy adopted
# it, and file equality alone cannot prove the in-memory config is redacting.
if has_redaction "$CADDYFILE"; then
  "$CADDY_BIN" validate --adapter caddyfile --config "$CADDYFILE" >/dev/null
  if ! "$SYSTEMCTL_BIN" reload caddy || ! "$SYSTEMCTL_BIN" is-active --quiet caddy; then
    echo "[caddy-log-redaction] FATAL: redaction is present on disk but Caddy did not reload it"
    exit 1
  fi
  echo "[caddy-log-redaction] already installed, valid and reloaded"
  exit 0
fi

config_dir=$(dirname "$CADDYFILE")
candidate=$(mktemp "$config_dir/.Caddyfile.websocket-redaction.candidate.XXXXXX")
staged=""
backup=""
cleanup() {
  if [[ -n "$candidate" ]]; then rm -f "$candidate"; fi
  if [[ -n "$staged" ]]; then rm -f "$staged"; fi
  return 0
}
trap cleanup EXIT
cp -p "$CADDYFILE" "$candidate"

"$PYTHON_BIN" - "$candidate" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
inner = """    # BEGIN SMARTER POKER WEBSOCKET CREDENTIAL LOG REDACTION
    log {
        format filter {
            request>headers>Sec-Websocket-Protocol delete
        }
    }
    # END SMARTER POKER WEBSOCKET CREDENTIAL LOG REDACTION
"""
outer = "{\n" + inner + "}\n\n"

lines = text.splitlines(keepends=True)
first_code = next(
    (
        index
        for index, line in enumerate(lines)
        if line.strip() and not line.lstrip().startswith("#")
    ),
    None,
)

if first_code is not None and lines[first_code].strip() == "{":
    # Preserve an existing global option block. Candidate validation below
    # rejects a conflicting default logger before the live file is touched.
    lines.insert(first_code + 1, inner)
    patched = "".join(lines)
else:
    patched = outer + text

path.write_text(patched)
PY

if ! has_redaction "$candidate"; then
  echo "[caddy-log-redaction] FATAL: candidate does not contain the redaction rule"
  exit 1
fi
if ! "$CADDY_BIN" validate --adapter caddyfile --config "$candidate" >/dev/null; then
  echo "[caddy-log-redaction] FATAL: candidate validation failed; live config untouched"
  exit 1
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$CADDYFILE.pre-websocket-redaction.$timestamp.$$"
cp -p "$CADDYFILE" "$backup"

staged=$(mktemp "$config_dir/.Caddyfile.websocket-redaction.install.XXXXXX")
cp -p "$candidate" "$staged"
mv -f "$staged" "$CADDYFILE"
staged=""

rollback() {
  local restore
  restore=$(mktemp "$config_dir/.Caddyfile.websocket-redaction.rollback.XXXXXX")
  cp -p "$backup" "$restore"
  mv -f "$restore" "$CADDYFILE"
  if ! "$SYSTEMCTL_BIN" reload caddy; then
    echo "[caddy-log-redaction] CRITICAL: old config restored on disk but Caddy reload also failed"
  elif ! "$SYSTEMCTL_BIN" is-active --quiet caddy; then
    echo "[caddy-log-redaction] CRITICAL: old config restored and reloaded but Caddy is not active"
  else
    echo "[caddy-log-redaction] previous config restored, reloaded and active"
  fi
}

if ! "$SYSTEMCTL_BIN" reload caddy; then
  echo "[caddy-log-redaction] ERROR: reload failed; rolling back"
  rollback
  exit 1
fi
if ! "$SYSTEMCTL_BIN" is-active --quiet caddy; then
  echo "[caddy-log-redaction] ERROR: Caddy is not active after reload; rolling back"
  rollback
  exit 1
fi

echo "[caddy-log-redaction] installed, validated and reloaded; backup: $backup"
