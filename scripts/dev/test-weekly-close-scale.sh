#!/usr/bin/env bash
# Native qualification of the weekly-close-scale migration (see the .py).
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/test-weekly-close-scale.py" "$@"
