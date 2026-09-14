#!/usr/bin/env bash
set -euo pipefail
# The same Prometheus release used by the monitoring stack (2.55.1), by image
# digest where Docker exists and by verified release binary where it does not.
# Offline evaluation cannot deliver production alerts.
exec bash "$(dirname "$0")/promtool-test-rules.sh" slo-stall-duration.test.yml
