#!/usr/bin/env bash
# Native qualification of the union P&L evidence migration (see the .py).
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/test-union-pnl-evidence-fast.py" "$@"
