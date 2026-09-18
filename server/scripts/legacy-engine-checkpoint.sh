#!/usr/bin/env bash
# One first-install checkpoint inside the existing, locked release operation.
# No image replacement, maintenance override, flag assignment or retry here.
set -euo pipefail
CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
CONTAINER="${CONTAINER:-club-arena-engine}"
LEGACY_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5
LEGACY_IMAGE=sha256:3796b874331fee7d3b0824472df65e9fe613306a5175d3a211fdf8158bdab852

die() { echo "[legacy-engine-checkpoint] $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'root-owned release required'
[ "$#" = 1 ] || die 'expected owning run key'
RUN_ID="$1"
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'invalid run key'
# /var/lock is a symlink to /run/lock on the engine host. Compare the held
# descriptor's file identity, not a resolved path against its configured alias.
[ "/proc/$$/fd/9" -ef "${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}" ] \
  || die 'owning engine lock descriptor missing'
flock -n 9 || die 'owning engine lock unavailable'
mapfile -t REQUEST < "$REQUEST_ROOT/$RUN_ID.request"
[ "${#REQUEST[@]}" = 6 ] && [ "${REQUEST[3]}" = "$CONTROL_DIR" ] \
  && [ "${REQUEST[4]}" = "$(cat "$CONTROL_DIR/control-sha")" ] \
  || die 'immutable operation generation mismatch'
[ "$(date +%s)" -lt "${REQUEST[5]}" ] || die 'owning operation expired'
[ "$(timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-sha)" = "$LEGACY_SHA" ] \
  && [ "$(timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-image-id)" = "$LEGACY_IMAGE" ] \
  || die 'sealed predecessor is not the qualified legacy image'
IDENTITY="$(timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}}' "$CONTAINER")"
read -r CONTAINER_ID IMAGE RUNNING <<< "$IDENTITY"
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] && [ "$IMAGE" = "$LEGACY_IMAGE" ] \
  && [ "$RUNNING" = true ] || die 'serving predecessor identity mismatch'
timeout 3s docker exec "$CONTAINER_ID" node -e '
const fs = require("node:fs");
const args = fs.readFileSync("/proc/1/cmdline", "utf8").split("\0").filter(Boolean);
if (process.version !== "v22.23.2" ||
    JSON.stringify(args) !== JSON.stringify(["node", "dist/index.js"]) ||
    /--(?:inspect|debug)/.test(process.env.NODE_OPTIONS ?? "") ||
    process.env.GIT_COMMIT_SHA !== "2f4e33560bcd23bfb5cc731f31816b2c2e2847e5") process.exit(1);
' || die 'predecessor runtime or loopback inspector configuration refused'

INSTANCE="$(curl -sS --max-time 2 http://127.0.0.1:8080/health | python3 -c '
import json,re,sys
d=json.load(sys.stdin); m=d.get("maintenance",{}); instance=d.get("instanceId","")
ok=(d.get("running") is True and d.get("version")=="2f4e3356" and re.fullmatch(r"1-[0-9a-f]{8}",instance)
    and m.get("active") is True and m.get("phase")=="counting_down"
    and m.get("durableConfirmed") is True and m.get("remainingMs",0)>=285000)
if not ok: raise SystemExit(1)
print(instance)
')" || die 'physical countdown entry unavailable'

# Persist intent before opening debugger access. A disconnect is unknown, not
# permission to invoke again. Existing release recovery retains this run key.
python3 - "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" "$INSTANCE" "$CONTAINER_ID" <<'PY'
import json,os,sys,time
path,instance,container=sys.argv[1:]
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
    os.write(fd,(json.dumps({"instance":instance,"container":container,"at":time.time(),"retryAllowed":False})+"\n").encode())
    os.fsync(fd)
finally: os.close(fd)
fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
try: os.fsync(fd)
finally: os.close(fd)
PY

{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs"; cat "$CONTROL_DIR/legacy-engine-checkpoint.mjs"; } \
  | docker exec -i "$CONTAINER_ID" node --input-type=module - "$INSTANCE" \
  || die 'checkpoint or inspector cleanup refused; do not retry this operation'
[ "$(timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}}' "$CONTAINER")" = "$IDENTITY" ] \
  || die 'predecessor changed during checkpoint'
# This helper cannot certify or start cutover. The caller must now pass the
# original maintenance_certificate with the complete 285000ms reserve.
