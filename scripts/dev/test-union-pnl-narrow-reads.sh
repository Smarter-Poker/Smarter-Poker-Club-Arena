#!/usr/bin/env bash
# Native qualification of the union P&L narrow-projection migration (see the .py).
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/test-union-pnl-narrow-reads.py" "$@"
