#!/usr/bin/env bash
# Build (or safely reuse) one immutable engine image from the exact committed
# `server` tree. The mutable host checkout is only an object database: it is
# never the Docker build context.
set -euo pipefail

REPO_DIR="${1:-}"
TARGET_SHA="${2:-}"
IMAGE_REF="${3:-}"
BUILD_CONTEXT_ROOT="${ENGINE_BUILD_CONTEXT_ROOT:-/var/lib/club-arena/engine-build-contexts}"
BUILD_LOCK="${ENGINE_BUILD_LOCK_FILE:-/var/lock/club-arena-engine-build.lock}"
BUILD_CONTRACT='clean-server-archive-v1'

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

case "$BUILD_CONTEXT_ROOT" in
  /*) ;;
  *) die 'build-context root must be absolute' ;;
esac
install -d -m 0700 "$BUILD_CONTEXT_ROOT"
BUILD_CONTEXT="$(mktemp -d "${BUILD_CONTEXT_ROOT%/}/context.XXXXXXXX")"
CANDIDATE_REF="$IMAGE_REF-candidate-$$"
CANDIDATE_TAGGED=0

cleanup_build() {
  if [ "$CANDIDATE_TAGGED" = 1 ]; then
    docker image rm "$CANDIDATE_REF" >/dev/null 2>&1 || true
  fi
  case "$BUILD_CONTEXT" in
    "${BUILD_CONTEXT_ROOT%/}"/context.*) rm -rf -- "$BUILD_CONTEXT" ;;
    *) echo "FATAL: refusing to remove invalid build context: $BUILD_CONTEXT" >&2; return 1 ;;
  esac
}

# EXIT alone is not run when the remote shell receives HUP or TERM. Convert
# catchable cancellation signals into a normal exit so staging is removed.
trap cleanup_build EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" archive --format=tar "$SERVER_TREE" \
  | tar --no-same-owner -xf - -C "$BUILD_CONTEXT"

for required in Dockerfile package.json tsconfig.json src; do
  [ -e "$BUILD_CONTEXT/$required" ] || die "committed server tree is missing $required"
done
[ ! -e "$BUILD_CONTEXT/.env" ] || die 'committed server tree contains forbidden .env credentials'
[ ! -e "$BUILD_CONTEXT/.git" ] || die 'build context unexpectedly contains Git metadata'

(
  cd "$BUILD_CONTEXT"
  timeout --signal=TERM --kill-after=15s 1500s docker build \
    --build-arg "GIT_COMMIT_SHA=$TARGET_SHA" \
    --label "org.opencontainers.image.revision=$TARGET_SHA" \
    --label "com.smarterpoker.engine.source-tree=$SERVER_TREE" \
    --label "com.smarterpoker.engine.build-contract=$BUILD_CONTRACT" \
    -t "$CANDIDATE_REF" .
)
CANDIDATE_TAGGED=1

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
