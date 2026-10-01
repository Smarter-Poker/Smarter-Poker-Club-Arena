#!/usr/bin/env bash
# Run a real-browser production walkthrough from the host (needs network +
# node_modules with playwright). Usage: bash scripts/e2e-host.sh <name>
# where <name> is a script in e2e-live/ without extension, e.g.
#   bash scripts/e2e-host.sh multitable-walk
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:?usage: e2e-host.sh <script-name (no .mjs)>}"
SCRIPT="e2e-live/${NAME}.mjs"
[ -f "$SCRIPT" ] || { echo "no such script: $SCRIPT"; ls e2e-live/*.mjs; exit 1; }
: "${SP_EMAIL:?set SP_EMAIL to a test account (an address ending in .invalid); see e2e-live/README.md}"
: "${SP_PASS:?set SP_PASS to that test account password}"
mkdir -p "${E2E_SHOTS:-/tmp/e2e-shots}" "$(dirname "${E2E_AUTH:-/tmp/e2e-work/auth.json}")"
exec node "$SCRIPT"
