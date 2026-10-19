#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Evaluate real rules offline with the monitoring stack's pinned Prometheus.
# break-does-not-silence-its-own-alarms.test.yml (2026-09-26) proves the
# alarms about the break are not muted by the break, and that long durations
# measured across breaks can fire at all.
# fleet-relative-throughput.test.yml (2026-10-15) proves the same-hour
# relative-drop alarm fires on the 2026-10-13 stall shape and stays quiet on
# a quiet hour, a short history, a tiny baseline and inside the break.
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --memory 256m --cpus 1 \
  -v "$repo_root:/work:ro" --workdir /work/tests/monitoring \
  --entrypoint /bin/promtool \
  quay.io/prometheus/prometheus@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3 \
  test rules fleet-throughput.test.yml break-does-not-silence-its-own-alarms.test.yml \
    fleet-relative-throughput.test.yml lightning-abandoned-and-engine-memory.test.yml
