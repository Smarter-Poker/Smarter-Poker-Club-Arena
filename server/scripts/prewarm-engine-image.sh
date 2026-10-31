#!/usr/bin/env bash
# Shared bounded image preparation; never starts application code or the engine.
set -euo pipefail
[ "$#" = 3 ] || { echo 'usage: prewarm-engine-image.sh IMAGE_ID RUN_ID DEADLINE' >&2; exit 1; }
IMAGE_REF="$1"
RUN_ID="$2"
DEADLINE="$3"
[[ "$IMAGE_REF" =~ ^sha256:[0-9a-f]{64}$ ]] \
  && [[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] \
  && [[ "$DEADLINE" =~ ^[1-9][0-9]*$ ]] \
  || { echo 'invalid immutable image preparation identity' >&2; exit 1; }
die() { echo "[engine-image-prewarm] $*" >&2; exit 1; }
remaining_seconds() {
  local remaining=$((DEADLINE - $(date +%s)))
  [ "$remaining" -gt 0 ] || return 1
  printf '%s\n' "$remaining"
}

# THE CANDIDATE IMAGE IS WARMED BEFORE THE BREAK (2026-10-23).
# A freshly built image has never had a container. On engine-01 (containerd
# snapshotter) the first `docker run` of a new image spent 13-40 s unpacking
# its snapshot and another 18-52 s joining the bridge network, while a second
# run of the same image takes 0.3 s for both. Measured over every cutover since
# 2026-10-17: rollback restarts of an already-run image never exceeded 0.3 s,
# and first runs of new images reached 81.5 s (stop 12.9 + create 23.9 +
# join 44.7) on 2026-10-22 06:28 UTC, which alone exceeds the 75 s cutover
# budget (run 39728449445-1). The engine is down for every one of those
# seconds. One throwaway container is therefore run to completion from the
# exact candidate image here, outside any break, with the engine command
# replaced so nothing connects to production. It carries no engine labels,
# no env file and only an ephemeral loopback port. Publishing exercises the
# port-mapper path that the old bridge-only warm-up skipped. The command still
# never starts the engine or binds the serving port.
# A Node-only exit did not hydrate the application layer: release 735e first
# emitted application output 58 seconds after Docker's start timestamp and
# exhausted the unchanged replacement budget. Read the candidate's application
# files here, with bounded memory and no imports, configuration or network work.
# An incomplete warm-up now refuses BEFORE any maintenance announcement.
prewarm_candidate_image() {
  local remaining warm_timeout warm_name started finished warm_program
  remaining="$(remaining_seconds)" || die 'deadline expired before candidate filesystem warm-up'
  warm_timeout=$((remaining - 30))
  [ "$warm_timeout" -le 120 ] || warm_timeout=120
  [ "$warm_timeout" -ge 10 ] || die 'insufficient budget for candidate filesystem warm-up before maintenance'
  warm_program="$(cat <<'CANDIDATE_FILESYSTEM_WARM'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
if (!root || !fs.lstatSync(path.join(root, 'dist/index.js')).isFile()) {
  throw new Error('candidate application entrypoint absent');
}
const buffer = Buffer.alloc(64 * 1024);
let files = 0;
let bytes = 0;
const pending = [root];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { pending.push(file); continue; }
    if (!entry.isFile()) continue; // Never follow links outside the candidate.
    const fd = fs.openSync(file, 'r');
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) bytes += count;
      files++;
    } finally { fs.closeSync(fd); }
  }
}
if (!files || !bytes) throw new Error('candidate filesystem warm-up incomplete');
console.log('ENGINE_IMAGE_PREWARM_FILES=' + files);
console.log('ENGINE_IMAGE_PREWARM_BYTES=' + bytes);
CANDIDATE_FILESYSTEM_WARM
)"
  warm_name="club-arena-engine-prewarm-$RUN_ID"
  timeout --signal=TERM --kill-after=2s 10s docker rm -f "$warm_name" >/dev/null 2>&1 || true
  started="$(date +%s)"
  if timeout --signal=TERM --kill-after=5s "${warm_timeout}s" docker run --rm --pull never \
    --name "$warm_name" --restart no --network bridge \
    --publish 127.0.0.1::8080 --entrypoint node \
    "$IMAGE_REF" -e "$warm_program" /app 2>/dev/null; then
    finished="$(date +%s)"
    echo "ENGINE_IMAGE_PREWARM_SECONDS=$((finished - started))"
  else
    timeout --signal=TERM --kill-after=2s 10s docker rm -f "$warm_name" >/dev/null 2>&1 || true
    die 'candidate filesystem warm-up did not finish before maintenance'
  fi
  return 0
}

# Standalone caller: both the receiver and transaction use these exact bytes.
# Both callers use one immutable image/fixture-bound durable scale receipt.
# This is before notice/intake in the receiver, and before notice in the
# transaction. Unknown serving/seal identity refuses; desired SHA alone never
# bypasses qualification of a still-serving legacy process.
prewarm_candidate_image
python3 "$(dirname "$(readlink -f "$0")")/legacy-census-scale-preflight.py" \
  "$IMAGE_REF" "$RUN_ID" "$DEADLINE"
