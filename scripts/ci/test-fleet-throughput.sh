#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Evaluate real rules offline with the monitoring stack's pinned Prometheus.
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --memory 256m --cpus 1 \
  -v "$repo_root:/work:ro" --workdir /work/tests/monitoring \
  --entrypoint /bin/promtool \
  prom/prometheus@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3 \
  test rules fleet-throughput.test.yml
