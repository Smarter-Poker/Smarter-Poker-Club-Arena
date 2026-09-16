#!/usr/bin/env bash
# Build (or safely reuse) one immutable engine image from the exact committed
# `server` tree. The mutable host checkout is only an object database: it is
# never the Docker build context.
set -euo pipefail
# The background build owns a separate session; never enable job control here.
set +m

REPO_DIR="${1:-}"
TARGET_SHA="${2:-}"
IMAGE_REF="${3:-}"
MODE="${4:-build}"
[ "$MODE" = build ] || [ "$MODE" = --require-prebuilt ] || { echo "invalid image mode" >&2; exit 1; }
BUILD_CONTEXT_ROOT="${ENGINE_BUILD_CONTEXT_ROOT:-/var/lib/club-arena/engine-build-contexts}"
BUILD_LOCK="${ENGINE_BUILD_LOCK_FILE:-/var/lock/club-arena-engine-build.lock}"
BUILD_CONTRACT='clean-server-archive-v1'
# The default Docker builder shares the daemon's unbounded memory budget. On
# 2026-09-12 a concurrent TypeScript build outlived a global OOM kill of the
# production engine. Every uncached build now runs inside this owned cgroup.
BUILDER='club-arena-engine-bounded-v3'
BUILDER_CONTAINER="buildx_buildkit_${BUILDER}0"
BUILDKIT_IMAGE='moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8'
BUILD_MEMORY_BYTES=4294967296
BUILD_RESERVE_KIB=262144

die() {
  echo "FATAL: $*" >&2
  exit 1
}

[ -n "$REPO_DIR" ] || die 'repository path is required'
[ -n "$TARGET_SHA" ] || die 'target commit SHA is required'
[ -n "$IMAGE_REF" ] || die 'image reference is required'
case "$REPO_DIR" in
  /*) ;;
  *) die 'repository path must be absolute' ;;
esac
case "$REPO_DIR$BUILD_CONTEXT_ROOT" in
  *$'\n'* | *$'\r'*) die 'paths must not contain control characters' ;;
esac
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'target SHA must be one lowercase 40-hex commit'
[[ "$IMAGE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || die 'unsafe image reference'
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || die 'repository path is not a Git checkout'

# Serialize inspect -> build -> validation -> final tag. A workflow queue is
# useful scheduling, but this host lock is the actual mutation boundary for
# workflows, operators, and recovery tools alike.
case "$BUILD_LOCK" in
  /*) ;;
  *) die 'build lock path must be absolute' ;;
esac
install -d -m 0755 "$(dirname "$BUILD_LOCK")"
exec 7>"$BUILD_LOCK"
flock -w 1800 7 || die 'could not acquire the engine image build lock'

RESOLVED_SHA="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" rev-parse --verify "${TARGET_SHA}^{commit}")"
[ "$RESOLVED_SHA" = "$TARGET_SHA" ] || die 'target SHA did not resolve to itself'
SERVER_TREE="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" rev-parse --verify "${TARGET_SHA}:server")"
[[ "$SERVER_TREE" =~ ^[0-9a-f]{40}$ ]] || die 'server source tree did not resolve to one Git tree'
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" cat-file -e "${SERVER_TREE}^{tree}"

image_label() {
  local reference="$1" key="$2"
  docker image inspect -f "{{index .Config.Labels \"$key\"}}" "$reference" 2>/dev/null || true
}

if [ "$MODE" = --require-prebuilt ]; then
  # The original host transaction may consume only the exact locally built
  # image whose root-owned receipt was published after bounded import.
  EXPECTED_IMAGE_ID="$(python3 - "$TARGET_SHA" "$SERVER_TREE" <<'PY_PREBUILT'
import json, os, pathlib, re, stat, sys
path = pathlib.Path('/var/lib/club-arena/engine-prebuilt') / (sys.argv[1] + '.json')
for parent in path.parents:
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        raise SystemExit('prebuilt receipt parent is not protected')
fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, 'rb') as stream:
    st = os.fstat(stream.fileno())
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o400 or not 0 < st.st_size <= 4096:
        raise SystemExit('prebuilt receipt is not a protected bounded regular file')
    raw = stream.read(4097)
    v = json.loads(raw)
    if (json.dumps(v, sort_keys=True, separators=(',', ':')) + '\n').encode() != raw:
        raise SystemExit('prebuilt receipt is not canonical')
if v.get('source_sha') != sys.argv[1] or v.get('server_tree') != sys.argv[2] or v.get('platform') != 'linux/amd64' or v.get('build_contract') != 'clean-server-archive-v1':
    raise SystemExit('prebuilt receipt source differs')
image = v.get('image_id')
if not isinstance(image, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
    raise SystemExit('prebuilt receipt image differs')
print(image)
PY_PREBUILT
  )" || die 'required locally built image receipt is absent or invalid'
  ACTUAL_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE_REF")" \
    || die 'required locally built image is absent'
  [ "$ACTUAL_IMAGE_ID" = "$EXPECTED_IMAGE_ID" ] || die 'locally built image ID changed'
  [ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE_REF")" = linux/amd64 ] \
    || die 'locally built image architecture differs'
fi

if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
  EXISTING_REVISION="$(image_label "$IMAGE_REF" 'org.opencontainers.image.revision')"
  EXISTING_TREE="$(image_label "$IMAGE_REF" 'com.smarterpoker.engine.source-tree')"
  EXISTING_CONTRACT="$(image_label "$IMAGE_REF" 'com.smarterpoker.engine.build-contract')"
  if [ "$EXISTING_REVISION" = "$TARGET_SHA" ] \
    && [ "$EXISTING_TREE" = "$SERVER_TREE" ] \
    && [ "$EXISTING_CONTRACT" = "$BUILD_CONTRACT" ]; then
    IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE_REF")"
    [[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'reused image has an invalid immutable ID'
    echo "validated immutable image $IMAGE_ID at revision $TARGET_SHA from server tree $SERVER_TREE"
    echo 'ENGINE_IMAGE_REUSED=true'
    exit 0
  fi
  echo "existing image is unproven (revision=${EXISTING_REVISION:-missing}, tree=${EXISTING_TREE:-missing}, contract=${EXISTING_CONTRACT:-missing}); rebuilding from committed objects" >&2
fi

[ "$MODE" != --require-prebuilt ] || die 'prebuilt image labels differ; host compilation is forbidden'

case "$BUILD_CONTEXT_ROOT" in
  /*) ;;
  *) die 'build-context root must be absolute' ;;
esac
install -d -m 0700 "$BUILD_CONTEXT_ROOT"
BUILD_CONTEXT="$(mktemp -d "${BUILD_CONTEXT_ROOT%/}/context.XXXXXXXX")"
CANDIDATE_REF="$IMAGE_REF-candidate-$$"
CANDIDATE_TAGGED=0
BUILDER_STARTED=0
BUILD_PID=''
BUILDER_CONFIG="${BUILD_CONTEXT}.buildkitd.toml"

cleanup_build() {
  local resource_cleanup_failed=0
  if [ -n "$BUILD_PID" ]; then
    kill -TERM -- "-$BUILD_PID" 2>/dev/null || true
  fi
  if [ "$BUILDER_STARTED" = 1 ]; then
    # Stop only our builder, preserving its configured cache for the next release.
    # Cancellation must not leave a compiler competing with the live engine.
    if ! timeout --signal=TERM --kill-after=5s 20s docker buildx stop "$BUILDER" >/dev/null 2>&1; then
      if ! timeout --signal=TERM --kill-after=5s 25s docker stop --time 10 "$BUILDER_CONTAINER" >/dev/null 2>&1; then
        echo 'ERROR: owned engine builder could not be stopped' >&2
        resource_cleanup_failed=1
      fi
    fi
  fi
  if [ -n "$BUILD_PID" ]; then
    # The client group belongs to this invocation, including timeout and Buildx.
    # After stopping its builder, reap it without an unbounded wait.
    kill -KILL -- "-$BUILD_PID" 2>/dev/null || true
    wait "$BUILD_PID" 2>/dev/null || true
  fi
  if [ "$CANDIDATE_TAGGED" = 1 ]; then
    docker image rm "$CANDIDATE_REF" >/dev/null 2>&1 || true
  fi
  case "$BUILD_CONTEXT" in
    "${BUILD_CONTEXT_ROOT%/}"/context.*) rm -rf -- "$BUILD_CONTEXT"; rm -f -- "$BUILDER_CONFIG" ;;
    *) echo "FATAL: refusing to remove invalid build context: $BUILD_CONTEXT" >&2; return 1 ;;
  esac
  [ "$resource_cleanup_failed" = 0 ] || exit 1
}

# EXIT alone is not run when the remote shell receives HUP or TERM. Convert
# catchable cancellation signals into a normal exit so staging is removed.
trap cleanup_build EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

# Read through the producer's final block padding. BSD tar can otherwise
# close at the end markers early and turn a valid archive into SIGPIPE under
# pipefail. Archive or extraction errors still fail the complete pipeline.
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" archive --format=tar "$SERVER_TREE" \
  | tar --ignore-zeros --no-same-owner -xf - -C "$BUILD_CONTEXT"

for required in Dockerfile package.json tsconfig.json src; do
  [ -e "$BUILD_CONTEXT/$required" ] || die "committed server tree is missing $required"
done
[ ! -e "$BUILD_CONTEXT/.env" ] || die 'committed server tree contains forbidden .env credentials'
[ ! -e "$BUILD_CONTEXT/.git" ] || die 'build context unexpectedly contains Git metadata'

# Keep 256 MiB available beyond the complete builder limit before starting.
# There is no unbounded fallback on unsupported hosts or a low-memory reading.
AVAILABLE_KIB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
[[ "$AVAILABLE_KIB" =~ ^[0-9]+$ ]] || die 'host memory availability is unreadable'
[ "$AVAILABLE_KIB" -ge "$((BUILD_MEMORY_BYTES / 1024 + BUILD_RESERVE_KIB))" ] \
  || die "insufficient memory headroom for the bounded engine build (available=${AVAILABLE_KIB}KiB, required=$((BUILD_MEMORY_BYTES / 1024 + BUILD_RESERVE_KIB))KiB)"
command -v setsid >/dev/null || die 'owned build process sessions are unavailable'

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  cat > "$BUILDER_CONFIG" <<'BUILDKIT_CONFIG'
[worker.oci]
  max-parallelism = 1
  gc = true
  reservedSpace = "512MB"
  maxUsedSpace = "2GB"
  minFreeSpace = "2GB"
BUILDKIT_CONFIG
  docker buildx create --name "$BUILDER" --driver docker-container \
    --driver-opt "image=$BUILDKIT_IMAGE" \
    --driver-opt "memory=$BUILD_MEMORY_BYTES" \
    --driver-opt "memory-swap=$BUILD_MEMORY_BYTES" \
    --driver-opt cpu-period=100000 --driver-opt cpu-quota=100000 \
    --driver-opt restart-policy=no \
    --buildkitd-config "$BUILDER_CONFIG" >/dev/null
fi
# Older supported Buildx releases have no inspect --format option. The named
# driver's ordinary inspect output is stable; missing/ambiguous output refuses.
DRIVER="$(docker buildx inspect "$BUILDER" | sed -n 's/^Driver:[[:space:]]*//p')"
[ "$DRIVER" = docker-container ] || die 'engine builder is not the dedicated container driver'
BUILDER_STARTED=1
timeout --signal=TERM --kill-after=10s 120s docker buildx inspect "$BUILDER" --bootstrap >/dev/null
BUILDER_LIMITS="$(docker inspect --format '{{.Config.Image}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.CpuPeriod}} {{.HostConfig.CpuQuota}} {{.HostConfig.RestartPolicy.Name}}' "$BUILDER_CONTAINER")"
[ "$BUILDER_LIMITS" = "$BUILDKIT_IMAGE $BUILD_MEMORY_BYTES $BUILD_MEMORY_BYTES 100000 100000 no" ] \
  || die 'engine builder resource configuration drifted'
CGROUP_MEMORY="$(docker exec "$BUILDER_CONTAINER" cat /sys/fs/cgroup/memory.max)"
CGROUP_SWAP="$(docker exec "$BUILDER_CONTAINER" cat /sys/fs/cgroup/memory.swap.max)"
CGROUP_CPU="$(docker exec "$BUILDER_CONTAINER" cat /sys/fs/cgroup/cpu.max)"
[ "$CGROUP_MEMORY" = "$BUILD_MEMORY_BYTES" ] && [ "$CGROUP_SWAP" = 0 ] \
  && [ "$CGROUP_CPU" = '100000 100000' ] || die 'engine build cgroup limits are not enforced'
# A reused builder must retain the single-worker and collection settings too.
# maxUsedSpace is a GC target, not a filesystem quota or a hard disk-usage cap.
docker exec "$BUILDER_CONTAINER" cat /etc/buildkit/buildkitd.toml | python3 -c '
import sys, tomllib
config = tomllib.loads(sys.stdin.read())
expected = {"max-parallelism": 1, "gc": True, "reservedSpace": "512MB",
            "maxUsedSpace": "2GB", "minFreeSpace": "2GB"}
if config.get("worker") != {"oci": expected}:
    sys.exit("engine builder worker or cache collection configuration drifted")
' || die 'engine builder worker configuration could not be verified'
echo "ENGINE_BUILD_RESOURCE_BOUNDARY=memory:$CGROUP_MEMORY,swap:$CGROUP_SWAP,cpu:$CGROUP_CPU"

# BuildKit can load a candidate before the client returns. Cleanup owns that
# unique tag even when a failure or cancellation interrupts that final response.
CANDIDATE_TAGGED=1
(
  cd "$BUILD_CONTEXT"
  exec setsid timeout --signal=TERM --kill-after=15s 1500s docker buildx build \
    --builder "$BUILDER" --platform linux/amd64 --load --progress plain \
    --build-arg "GIT_COMMIT_SHA=$TARGET_SHA" \
    --label "org.opencontainers.image.revision=$TARGET_SHA" \
    --label "com.smarterpoker.engine.source-tree=$SERVER_TREE" \
    --label "com.smarterpoker.engine.build-contract=$BUILD_CONTRACT" \
    -t "$CANDIDATE_REF" .
) &
BUILD_PID=$!
# Bash defers traps while waiting on a foreground external command. Waiting on
# this owned background job instead lets TERM/HUP enter cleanup immediately.
BUILD_STATUS=0
wait "$BUILD_PID" || BUILD_STATUS=$?
BUILD_PID=''
[ "$BUILD_STATUS" = 0 ] || exit "$BUILD_STATUS"
BUILD_MEMORY_PEAK="$(docker exec "$BUILDER_CONTAINER" cat /sys/fs/cgroup/memory.peak)"
[[ "$BUILD_MEMORY_PEAK" =~ ^[0-9]+$ ]] || die 'engine build memory peak is unreadable'
echo "ENGINE_BUILD_MEMORY_PEAK_BYTES=$BUILD_MEMORY_PEAK"

IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$CANDIDATE_REF")"
BUILT_REVISION="$(image_label "$CANDIDATE_REF" 'org.opencontainers.image.revision')"
BUILT_TREE="$(image_label "$CANDIDATE_REF" 'com.smarterpoker.engine.source-tree')"
BUILT_CONTRACT="$(image_label "$CANDIDATE_REF" 'com.smarterpoker.engine.build-contract')"
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'built image has an invalid immutable ID'
[ "$BUILT_REVISION" = "$TARGET_SHA" ] || die 'built image revision label does not match the target'
[ "$BUILT_TREE" = "$SERVER_TREE" ] || die 'built image source-tree label does not match the archived tree'
[ "$BUILT_CONTRACT" = "$BUILD_CONTRACT" ] || die 'built image contract label does not match the clean-build contract'

# Only a fully validated candidate may replace the immutable SHA tag. A failed
# build or label check leaves any previously proven target untouched.
docker tag "$IMAGE_ID" "$IMAGE_REF"
FINAL_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE_REF")"
[ "$FINAL_IMAGE_ID" = "$IMAGE_ID" ] || die 'final immutable tag does not resolve to the validated image ID'
docker image rm "$CANDIDATE_REF" >/dev/null
CANDIDATE_TAGGED=0

echo "validated immutable image $IMAGE_ID at revision $BUILT_REVISION from server tree $BUILT_TREE"
echo 'ENGINE_IMAGE_REUSED=false'
