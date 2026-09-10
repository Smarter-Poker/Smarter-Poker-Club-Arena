#!/usr/bin/env bash
set -euo pipefail
proof_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PAYER_PROOF_DIR:?Set PAYER_PROOF_DIR to the pinned companion rakeback-payer-proof directory}"
ROUND1_PROBE="$proof_here/native-probe.py" bash "$PAYER_PROOF_DIR/round1-owner/run-local.sh"
