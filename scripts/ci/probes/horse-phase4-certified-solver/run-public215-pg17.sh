#!/usr/bin/env bash
# Finite isolated nativePG17 public physics feasibility; never production.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$ROOT/scripts/ci/probes/horse-phase4-certified-solver"
PG_BIN=${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
: "${TMPDIR:?set task-owned external TMPDIR}"
WORK=$(mktemp -d "$TMPDIR/public215-pg17.XXXXXX")
SOCKET=$(mktemp -d "/Volumes/SmarterWork/agent-work/shared-capacity/v31sql215.XXXXXX")
cleanup(){ "$PG_BIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORK" "$SOCKET"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$WORK/data" -A trust -U "$USER" >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $SOCKET -h '' -p 55447" -l "$WORK/server.log" -w start >/dev/null || { cat "$WORK/server.log"; exit 1; }
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET" -p 55447 -U "$USER" -d postgres)
"${PSQL[@]}" -c 'CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;' >/dev/null
# Existing V2 independentSQL helper, unchanged source (no legacy suite replay).
python3 - "$ROOT" <<'PYCODE' | "${PSQL[@]}"
import sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql').read_text()
a=s.index('\nCREATE OR REPLACE FUNCTION public.fn_gto_v31_board_relative_key_v2(')+1
b=s.index('$fn$;',s.index('AS $fn$',a))+5
print(s[a:b])
PYCODE
# Fast helper proof executes byte-exact function prefix; full existing harness owns connected DDL.
python3 - "$ROOT" <<'PYPREFIX' | "${PSQL[@]}"
import sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20261029070812_public_hist215_models_bind_independent_exact_public_state.sql').read_text()
print(s.split('-- ADDITIVE PUBLIC MODEL DATA OWNER')[0]+'COMMIT;')
PYPREFIX
if [[ "${1:-}" == "--dense-feasibility" ]]; then
 "${PSQL[@]}" <<'SQL'
\timing on
SET statement_timeout='240s';
SELECT count(*) AS legal_own_combos,
 bool_and(current_z=1081 AND terminal_z=1081*990 AND current_w>=0 AND current_t>=0 AND current_w+current_t<=current_z AND terminal_w>=0 AND terminal_t>=0 AND terminal_w+terminal_t<=terminal_z) AS exact_joint_mass_bounds
FROM public.fn_gto_v31_public215_dense_wtl(ARRAY[42,21,0],array_fill(1::numeric,ARRAY[1326]));
SQL
elif [[ "${1:-}" == "--single-feasibility" ]]; then
 "${PSQL[@]}" -f "$HERE/public215-physics.sql"
 # Existing default worker execution budget is8s; do not widen it to claim viability.
 "${PSQL[@]}" <<'SQL'
\timing on
SET statement_timeout='8s';
SELECT public.fn_gto_v31_public215_wtl(ARRAY[48,45],ARRAY[42,21,0],array_fill(1::numeric,ARRAY[1326]));
SQL
elif [[ "${1:-}" == "--head-feasibility" ]]; then
 "${PSQL[@]}" -c "SET statement_timeout='240s';" -f "$HERE/public215-head-cost.sql"
else
 "${PSQL[@]}" -f "$HERE/public215-model.sql"
 PGHOST="$SOCKET" PGPORT=55447 PGUSER="$USER" PG17_PSQL="$PG_BIN/psql" node "$HERE/run-public215-feature-parity.mjs"
fi
