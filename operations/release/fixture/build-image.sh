#!/usr/bin/env bash
set -euo pipefail

# Build only. No registry login, push, workflow dispatch, or production input.
fixture_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(git -C "$fixture_dir" rev-parse --show-toplevel)
revision=$(git -C "$repo_dir" rev-parse HEAD)
image_tag=${1:-club-arena-component-fixture:local}
[[ "$image_tag" =~ ^[a-z0-9][a-z0-9._/-]*:[a-z0-9._-]+$ ]] || { echo 'Invalid local image tag' >&2; exit 2; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires an admitted Linux amd64 Docker runner' >&2; exit 2; }
[[ $(docker info --format '{{.OSType}}/{{.Architecture}}') == linux/x86_64 ]] || { echo 'Requires native Linux amd64 Docker' >&2; exit 2; }
files=(Dockerfile package.json package-lock.json fixture-server.mjs runtime-files.mjs gateway.mjs auth-fixture.mjs auth-bootstrap-proof.mjs service-role-boundary.mjs actors.mjs financial-route-phase.mjs seed-fixture.mjs native-smoke.mjs observation-bridge.mjs)
for file in "${files[@]}"; do
  git -C "$repo_dir" ls-files --error-unmatch "operations/release/fixture/$file" >/dev/null
  [[ -f "$fixture_dir/$file" && ! -L "$fixture_dir/$file" ]] || { echo "Missing reviewed runtime file: $file" >&2; exit 2; }
done
git -C "$repo_dir" diff --exit-code HEAD -- operations/release/fixture >/dev/null || { echo 'Commit the reviewed fixture files before building' >&2; exit 2; }

# Exact allowlist context: no .env, application dump, credentials, or worktree files.
tar -C "$fixture_dir" -cf - "${files[@]}" | docker build --platform=linux/amd64 \
  --label "org.opencontainers.image.revision=$revision" \
  --label "com.smarter-poker.control-revision=$revision" \
  --label "com.smarter-poker.source-revision=$revision" \
  --label 'org.opencontainers.image.source=https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena' \
  --label 'com.smarter-poker.scope=isolated-component-fixture' \
  --tag "$image_tag" -
docker image inspect --format '{{.Id}}' "$image_tag"
