#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export STATS_PG_SCRATCH_PARENT="${STATS_PG_SCRATCH_PARENT:-${RUNNER_TEMP:-/Volumes/SmarterWork/agent-work}}"
export DATA_CONSOLE_PG_SCRATCH_PARENT="${DATA_CONSOLE_PG_SCRATCH_PARENT:-$STATS_PG_SCRATCH_PARENT}"
export UNION_OPS_PG_SCRATCH_PARENT="${UNION_OPS_PG_SCRATCH_PARENT:-$DATA_CONSOLE_PG_SCRATCH_PARENT}"

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
  scripts/dev/test-rake-agent-report-postgres.sh
  scripts/dev/test-union-ops-financial-admin-postgres.sh
)

for script in "${scripts[@]}"; do
  echo "DATA_CONSOLE_POSTGRES RUN $script"
  bash "$repo/$script"
  echo "DATA_CONSOLE_POSTGRES PASS $script"
done

# Operations readings are part of the same required Data Console native verdict.
# Keep the existing Stats and financial-admin invocations above unchanged.
echo 'DATA_CONSOLE_POSTGRES RUN Club Operations'
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  CLUB_OPERATIONS_PG_SCRATCH_PARENT="${CLUB_OPERATIONS_PG_SCRATCH_PARENT:-$DATA_CONSOLE_PG_SCRATCH_PARENT}" \
  python3 -B "$repo/scripts/ci/test-club-operations-overview-postgres.py"
echo 'DATA_CONSOLE_POSTGRES PASS Club Operations'

# Club Data counts what the club played (20261017160125): facts filed under the
# club the money moved through, scoped owner / agent downline / refused.
echo 'DATA_CONSOLE_POSTGRES RUN Club Data facts'
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="${DATA_CONSOLE_PG_SCRATCH_PARENT:-${TMPDIR:-/tmp}}" \
  python3 -B "$repo/scripts/ci/test-club-data-fact-db-postgres.py"
echo 'DATA_CONSOLE_POSTGRES PASS Club Data facts'

# The Club Data Report reads what the club played (20261017204111): the Report's
# daily tables from the facts, one club per tournament row, whole-club Report
# for the owner and admins only.
echo 'DATA_CONSOLE_POSTGRES RUN Club Data Report'
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="${DATA_CONSOLE_PG_SCRATCH_PARENT:-${TMPDIR:-/tmp}}" \
  python3 -B "$repo/scripts/ci/test-club-data-report-db-postgres.py"
echo 'DATA_CONSOLE_POSTGRES PASS Club Data Report'

# Player Record: funded-club attribution and private event delivery.
echo 'DATA_CONSOLE_POSTGRES RUN Member Record'
bash "$repo/scripts/ci/test-private-record-hosting.sh"
echo 'DATA_CONSOLE_POSTGRES PASS Member Record'

# A redeemed fee total must reach Member Record and Player Statistics together.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  FEE_REDEMPTION_SCRATCH="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  bash "$repo/scripts/ci/test-player-fee-redemption.sh"

# Exercise the maintained installer identity through a proxy-shaped session.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  python3 -B "$repo/scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py"

# Agent banks, private data boundaries, and atomic hierarchy assignment.
node --test "$repo/scripts/ci/qualify-agent-boundary.test.mjs" "$repo/scripts/ci/qualify-agent-assignment.test.mjs" "$repo/scripts/ci/cleanup-agent-assignment-fixtures.test.mjs" "$repo/scripts/ci/qualify-agent-assignment-browser.test.mjs"
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  AGENT_BOUNDARY_SCRATCH="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  python3 -B "$repo/scripts/ci/test-agent-data-boundary-postgres.py"

# Indexed parent traversal must match the captured predicate and measured budget.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" RUNNER_TEMP="$DATA_CONSOLE_PG_SCRATCH_PARENT" python3 -B "$repo/scripts/ci/test-agent-downline-performance-postgres.py"

# Player Management ordering must cover the complete server-paged roster.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  bash "$repo/scripts/dev/test-roster-join-sort-postgres.sh"

# Exact MTT types and union-wide Club Data reporting share the required verdict.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  python3 -B "$repo/scripts/ci/test-club-data-union-mtt-postgres.py"

# Player-selected filters never expire or cross account ownership.
bash "$repo/scripts/dev/test-player-preferences-postgres.sh"
# Personal earned-fee headline and standing share parity with Player Management.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  python3 -B "$repo/scripts/ci/test-club-data-reads-each-window-once.py"

# Opponent notes menu favorites ranks committed usage without exposing users.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  RUNNER_TEMP="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  bash "$repo/scripts/dev/test-player-throwable-favorites-postgres.sh"
# Paid jackpot awards are player cash results in every member reader.
PG_BIN="${PG_BIN:-${PG17_BINDIR:-/usr/lib/postgresql/17/bin}}" \
  TMPDIR="$DATA_CONSOLE_PG_SCRATCH_PARENT" \
  bash "$repo/scripts/ci/test-member-jackpot-win-loss.sh"
