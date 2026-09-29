#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Evaluate real rules offline with the monitoring stack's pinned Prometheus.
# break-does-not-silence-its-own-alarms.test.yml (2026-09-26) proves the
# alarms about the break are not muted by the break, and that long durations
# measured across breaks can fire at all.
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --memory 256m --cpus 1 \
  -v "$repo_root:/work:ro" --workdir /work/tests/monitoring \
  --entrypoint /bin/promtool \
  prom/prometheus@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3 \
  test rules fleet-throughput.test.yml break-does-not-silence-its-own-alarms.test.yml
