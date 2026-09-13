#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# The same Prometheus release used by the monitoring stack, pinned to its
# published digest. Offline evaluation cannot deliver production alerts.
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --memory 256m --cpus 1 \
  -v "$repo_root:/work:ro" --workdir /work/tests/monitoring \
  --entrypoint /bin/promtool \
  prom/prometheus@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3 \
  test rules slo-stall-duration.test.yml
