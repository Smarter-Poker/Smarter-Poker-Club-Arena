#!/usr/bin/env bash
# Run `promtool test rules <file>` with the monitoring stack's pinned Prometheus
# (infra/monitoring/docker-compose.yml: prom/prometheus:v2.55.1), on any runner.
#
# GitHub-hosted runners have Docker, so the image is used exactly as before,
# pinned by digest. The estate runners (self-hosted, estate-linux) have no
# Docker daemon by design - they run 12-18 runners per box and never host
# containers - so there the same promtool version is fetched once from the
# Prometheus release, verified against its published sha256, cached on the box
# and reused. Both paths evaluate identical rules with identical promtool
# 2.55.1; neither reaches the network to run the test itself.
#
# 2026-09-14: added when CI moved back to the estate runners (PR #4647). Two
# steps in typecheck_compile were `docker run ...` and died with exit 127
# (`docker: command not found`) on the first estate run.
set -euo pipefail
rules_file="${1:?usage: promtool-test-rules.sh <file under tests/monitoring>}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
PROM_VERSION="2.55.1"
PROM_IMAGE="prom/prometheus@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  exec docker run --rm --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=32m --memory 256m --cpus 1 \
    -v "$repo_root:/work:ro" --workdir /work/tests/monitoring \
    --entrypoint /bin/promtool \
    "$PROM_IMAGE" \
    test rules "$rules_file"
fi

case "$(uname -m)" in
  x86_64)  arch=amd64; sha=19700bdd42ec31ee162e4079ebda4cd0a44432df4daa637141bdbea4b1cd8927 ;;
  aarch64) arch=arm64; sha=af43368bc6379c3c8bd5ac0b82208060bba22267bf01ad3ab5df56ad5725bf88 ;;
  *) echo "promtool-test-rules: no docker and unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

cache_dir="${RUNNER_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}}/promtool/$PROM_VERSION-$arch"
promtool="$cache_dir/promtool"
if [ ! -x "$promtool" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tarball="prometheus-$PROM_VERSION.linux-$arch.tar.gz"
  curl --fail --silent --show-error --location --retry 3 \
    -o "$tmp/$tarball" \
    "https://github.com/prometheus/prometheus/releases/download/v$PROM_VERSION/$tarball"
  echo "$sha  $tmp/$tarball" | sha256sum --check --strict --quiet
  tar -xzf "$tmp/$tarball" -C "$tmp" "prometheus-$PROM_VERSION.linux-$arch/promtool"
  mkdir -p "$cache_dir"
  # Atomic publish so a sibling runner on the same box never sees a half-written binary.
  mv -f "$tmp/prometheus-$PROM_VERSION.linux-$arch/promtool" "$promtool.$$"
  chmod 0755 "$promtool.$$"
  mv -f "$promtool.$$" "$promtool"
fi

cd "$repo_root/tests/monitoring"
exec "$promtool" test rules "$rules_file"
