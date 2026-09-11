#!/usr/bin/env bash
# Retain the sealed/running/leased engine images plus five recent rollback tags.
# This is exact-tag garbage collection, never a generic Docker prune.
set -euo pipefail

CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_SEAL="$CONTROL_DIR/engine-release-seal.py"
LEASE_ROOT="${ENGINE_RELEASE_IMAGE_LEASE_ROOT:-/var/lib/club-arena/engine-image-leases}"
BUILD_LOCK="${ENGINE_BUILD_LOCK_FILE:-/var/lock/club-arena-engine-build.lock}"
IMAGE_REPO="${IMAGE_REPO:-club-arena-engine}"
CONTAINER="${CONTAINER:-club-arena-engine}"
MAX_SECONDS="${ENGINE_IMAGE_RETENTION_MAX_SECONDS:-60}"

die() {
  echo "[retain-engine-images] FATAL: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[[ "$MAX_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$MAX_SECONDS" -le 300 ] \
  || die 'retention deadline must be between one and 300 seconds'
DEADLINE=$(( $(date +%s) + MAX_SECONDS ))

remaining_seconds() {
  local remaining=$((DEADLINE - $(date +%s)))
  [ "$remaining" -gt 0 ] || die 'image retention deadline expired'
  printf '%s\n' "$remaining"
}

bounded() {
  local remaining
  remaining="$(remaining_seconds)"
  timeout --signal=TERM --kill-after=2s "${remaining}s" "$@"
}

install -d -m 0700 "$LEASE_ROOT"
python3 - "$LEASE_ROOT" "$(dirname "$LEASE_ROOT")" <<'PY'
import os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(fd)
    finally: os.close(fd)
PY
exec 7>"$BUILD_LOCK"
LOCK_WAIT="$(remaining_seconds)"
[ "$LOCK_WAIT" -le 30 ] || LOCK_WAIT=30
flock -w "$LOCK_WAIT" 7 || die 'engine image build lock is unavailable for retention'

declare -A protected=()
shopt -s nullglob
for file in "$LEASE_ROOT"/*.lease; do
  lease_name="$(basename "$file")"
  [[ "$lease_name" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?\.lease$ ]] \
    || die 'engine image lease directory contains an invalid entry'
  mapfile -t lease_lines < "$file" || die 'engine image lease is unreadable'
  [ "${#lease_lines[@]}" = 1 ] || die 'engine image lease has an invalid field count'
  leased_sha="${lease_lines[0]}"
  [[ "$leased_sha" =~ ^[0-9a-f]{40}$ ]] || die 'engine image lease has an invalid SHA'
  protected["$leased_sha"]=1
done

desired_sha="$($RELEASE_SEAL get desired-sha)"
protected["$desired_sha"]=1
running_sha="$(bounded docker container inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER")"
[[ "$running_sha" =~ ^[0-9a-f]{40}$ ]] || die 'running engine has no exact release label during retention'
protected["$running_sha"]=1

kept_extra=0
removed=0
refs="$(bounded docker image ls "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}')" \
  || die 'could not list engine image tags inside the retention deadline'
while IFS= read -r ref; do
  if [[ "$ref" =~ ^${IMAGE_REPO}:[0-9a-f]{40}-candidate-[1-9][0-9]*$ ]]; then
    bounded docker image rm "$ref" >/dev/null \
      || die "could not retire abandoned candidate tag $ref"
    removed=$((removed + 1))
    continue
  fi
  ref_sha="${ref#"$IMAGE_REPO:"}"
  [[ "$ref_sha" =~ ^[0-9a-f]{40}$ ]] || continue
  if [ "${protected[$ref_sha]:-0}" = 1 ]; then
    continue
  fi
  if [ "$kept_extra" -lt 5 ]; then
    protected["$ref_sha"]=1
    kept_extra=$((kept_extra + 1))
    continue
  fi
  bounded docker image rm "$ref" >/dev/null || die "could not retire unleased engine tag $ref"
  removed=$((removed + 1))
done <<< "$refs"

# Replacing an unproven exact-SHA tag can leave the old Club Arena-built image
# dangling. Remove only images carrying this repository's build-contract and
# revision labels, and never a revision protected by the seal/running/leases.
dangling_ids="$(bounded docker image ls --no-trunc --filter dangling=true --format '{{.ID}}')" \
  || die 'could not list dangling images inside the retention deadline'
while IFS= read -r image_id; do
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || continue
  revision="$(bounded docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" \
    || die "could not inspect dangling image $image_id"
  contract="$(bounded docker image inspect -f '{{index .Config.Labels "com.smarterpoker.engine.build-contract"}}' "$image_id")" \
    || die "could not inspect dangling image contract $image_id"
  [ "$contract" = clean-server-archive-v1 ] || continue
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die 'Club Arena-built dangling image has an invalid revision label'
  [ "${protected[$revision]:-0}" = 1 ] && continue
  bounded docker image rm "$image_id" >/dev/null \
    || die "could not retire unprotected dangling engine image $image_id"
  removed=$((removed + 1))
done <<< "$dangling_ids"

echo "retained sealed, running, leased, and $kept_extra rollback engine tag(s); removed $removed"
