#!/usr/bin/env bash
# Source-only transition fixture: maintained original V31 migrations, then this additive candidate.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$ROOT/scripts/ci/probes/horse-phase4-certified-solver"
if [[ -n "${PG17_BIN:-}" ]];then PG_BIN=$PG17_BIN
elif [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]];then PG_BIN=/opt/homebrew/opt/postgresql@17/bin
elif command -v postgres >/dev/null 2>&1&&postgres --version|grep -q ' 17\.';then PG_BIN=$(dirname "$(command -v postgres)")
else echo 'Native PostgreSQL17 required (or set PG17_BIN).' >&2;exit 1;fi
: "${TMPDIR:?set task-owned external TMPDIR}"
WORK=$(mktemp -d "$TMPDIR/public215-connected.XXXXXX")
if [[ "${GITHUB_ACTIONS:-}" == true ]];then
 SOCKET_ROOT=$(mktemp -d "${RUNNER_TEMP:?}/p215socket.XXXXXX")
else
 SOCKET_ROOT=$(mktemp -d "/Volumes/SmarterWork/agent-work/shared-capacity/p215socket.XXXXXX")
fi
SOCKET="$SOCKET_ROOT/socket";mkdir "$SOCKET"
cleanup(){ "$PG_BIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1||true;rm -rf "$WORK" "$SOCKET_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$WORK/data" -A trust -U "$USER" >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $SOCKET -h '' -p 55447" -l "$WORK/server.log" -w start >/dev/null||{ cat "$WORK/server.log";exit 1; }
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET" -p 55447 -U "$USER" -d postgres)
"${PSQL[@]}" -f "$HERE/setup.sql" >"$WORK/setup.log"
# Reuse the exact maintained qualification owner's migration order, not a parallel schema.
python3 - "$HERE/run-pg17.sh" <<'PY' >"$WORK/migrations.list"
import re,sys
from pathlib import Path
s=Path(sys.argv[1]).read_text();seen=set()
for m in re.finditer(r'"\$ROOT/supabase/migrations/([^"\n]+\.sql)"',s):
 n=m.group(1)
 if n=='20261029070812_public_hist215_models_bind_independent_exact_public_state.sql':continue
 if n not in seen:print(n);seen.add(n)
PY
while IFS= read -r migration;do "${PSQL[@]}" -f "$ROOT/supabase/migrations/$migration" >"$WORK/migration.log";done <"$WORK/migrations.list"
BASE_HASH=$("${PSQL[@]}" -Atc "SELECT md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure));")
"$PG_BIN/createdb" -h "$SOCKET" -p55447 -U "$USER" -T postgres public215_probe
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET" -p55447 -U "$USER" -d public215_probe)
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261029070812_public_hist215_models_bind_independent_exact_public_state.sql"
if [[ "${1:-}" != identities ]];then node "$HERE/public215-declared-proofs.mjs" | "${PSQL[@]}";fi
case "${1:-audit}" in
 all) fixture=all;;
 audit) fixture=public215-audit-cost.sql;;
 metadata) fixture=public215-metadata.sql;;
 identities) fixture=public215-identities.sql;;
 selection) fixture=public215-selection.sql;;
 admission) fixture=public215-admission.sql;;
 wtl) fixture=public215-wtl-parity.sql;;
 *) echo "expected all, audit, metadata, selection, admission or wtl" >&2;exit 2;;
esac
if [[ "$fixture" == all ]];then
 for fixture in public215-model.sql public215-physics.sql public215-metadata.sql public215-selection.sql public215-wtl-parity.sql public215-audit-cost.sql public215-admission.sql;do
  "${PSQL[@]}" -c "SET statement_timeout='240s';SET lock_timeout='1s';" -f "$HERE/$fixture"
 done
 V31_FEATURE_PRIVATE_FIXTURE_ROOT="$SOCKET_ROOT" PGHOST="$SOCKET" PGPORT=55447 PGUSER="$USER" PG17_PSQL="$PG_BIN/psql" PGDATABASE=public215_probe node "$HERE/run-public215-feature-parity.mjs"
else
 "${PSQL[@]}" -c "SET statement_timeout='240s';SET lock_timeout='1s';" -f "$HERE/$fixture"
fi
AFTER_HASH=$("$PG_BIN/psql" -XAt -h "$SOCKET" -p55447 -U "$USER" -d postgres -c "SELECT md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure));")
[[ "$AFTER_HASH" == "$BASE_HASH" ]]||{ echo 'Original rollback fixture database was changed' >&2;exit 1; }
echo PUBLIC215_ORIGINAL_DATABASE_IDENTITY_PRESERVED
