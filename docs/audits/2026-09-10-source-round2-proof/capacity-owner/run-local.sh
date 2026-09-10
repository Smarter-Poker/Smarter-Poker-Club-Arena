#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUND1_FIXTURE="${ROUND1_FIXTURE:-$HERE/../../2026-09-10-rakeback-payer-proof/round1-owner}"
proof_input="$(mktemp -d /tmp/ca-round2-input.XXXXXX)"
cp -R "$ROUND1_FIXTURE" "$proof_input/runner"
cp "$ROUND1_FIXTURE/../source-payer-proposal.sql" "$proof_input/source-payer-proposal.sql"
cp "$HERE"/0[123]-*.sql "$proof_input/runner/vendor/capacity-owner/"
cp "$HERE/table-catalog-capacity-support.json" "$proof_input/runner/table-catalog-capacity-extra.json"
cp "$HERE/trigger-catalog-capacity-support.json" "$proof_input/runner/trigger-catalog-capacity-extra.json"
cp "$HERE/function-catalog-capacity-dependencies.json" "$proof_input/runner/function-catalog-capacity-extra.json"
cp "$HERE/function-catalog-commission-batch.json" "$proof_input/runner/vendor/source-authority/owner-composition/"
export ROUND1_PROBE="$HERE/native-probe.py"
bash "$proof_input/runner/run-local.sh"
