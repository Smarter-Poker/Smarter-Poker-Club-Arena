#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export STATS_PG_SCRATCH_PARENT="${STATS_PG_SCRATCH_PARENT:-${RUNNER_TEMP:-/Volumes/SmarterWork/agent-work}}"
export DATA_CONSOLE_PG_SCRATCH_PARENT="${DATA_CONSOLE_PG_SCRATCH_PARENT:-$STATS_PG_SCRATCH_PARENT}"

scripts=(
  scripts/dev/test-stats-cash-opportunities-postgres.sh
  scripts/dev/test-stats-club-scope-postgres.sh
  scripts/dev/test-stats-evidence-session-postgres.sh
  scripts/dev/test-stats-exact-cash-sessions-postgres.sh
  scripts/dev/test-stats-facts-phase2-postgres.sh
  scripts/dev/test-stats-financial-reports-postgres.sh
  scripts/dev/test-stats-operational-quality-postgres.sh
  scripts/dev/test-stats-owner-workspace-postgres.sh
  scripts/dev/test-financial-admin-revenue-postgres.sh
)

for script in "${scripts[@]}"; do
  echo "DATA_CONSOLE_POSTGRES RUN $script"
  bash "$repo/$script"
  echo "DATA_CONSOLE_POSTGRES PASS $script"
done
