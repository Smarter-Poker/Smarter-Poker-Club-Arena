#!/usr/bin/env bash
set -euo pipefail
# Evaluate real rules offline with the monitoring stack's pinned Prometheus
# (2.55.1): image digest where Docker exists, verified release binary elsewhere.
exec bash "$(dirname "$0")/promtool-test-rules.sh" fleet-throughput.test.yml
