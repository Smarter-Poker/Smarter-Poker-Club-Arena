#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$ROOT/scripts/ci/probes/horse-phase4-certified-solver"
if [[ -n "${PG17_BIN:-}" ]]; then
  PG_BIN=$PG17_BIN
elif [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
  PG_BIN=/opt/homebrew/opt/postgresql@17/bin
elif command -v postgres >/dev/null 2>&1 && postgres --version | grep -q ' 17\.'; then
  PG_BIN=$(dirname "$(command -v postgres)")
else
  echo 'PostgreSQL 17 is required (set PG17_BIN to its bin directory).' >&2
  exit 1
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/horse-phase4-pg.XXXXXX")
SOCKET="$WORK/socket"
DB=horse_phase4_probe
mkdir -p "$SOCKET"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$WORK/data" -A trust -U "$USER" >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $SOCKET -h '' -p 55439" -w start >/dev/null
export PGHOST="$SOCKET" PGPORT=55439 PGUSER="$USER"
"$PG_BIN/createdb" "$DB"
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -d "$DB")

"${PSQL[@]}" -f "$HERE/setup.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908163125_the_horse_reads_only_a_certified_solver_dataset.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908163137_the_solver_score_keeps_every_decision_receipt.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908163147_both_solver_hosts_and_the_compactor_leave_receipts.sql"
"${PSQL[@]}" -f "$HERE/certified-v31.sql"
"${PSQL[@]}" -f "$HERE/solver-agreement.sql"
"${PSQL[@]}" -f "$HERE/pipeline-liveness.sql"
STATUS=$("${PSQL[@]}" -Atc "select ca_gto_v31_certification_status(null)->>'contract';")
[[ "$STATUS" == 'smarter-poker.gto-v31-certification-status.v1' ]]
echo PHASE4_STATUS_OK
