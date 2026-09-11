#!/usr/bin/env bash
set -euo pipefail

# This boundary is no longer safely replayable in isolation. Rehearse the one
# supported forward chain against a disposable current-production clone.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$repo_dir/scripts/dev/probe-stage-b-forward-chain-pg17.sh" "$@"
