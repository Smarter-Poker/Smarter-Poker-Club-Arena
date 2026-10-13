#!/usr/bin/env bash
# Private original cash-flow qualification. Never accepts a remote connection.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
case "$("$PGBIN/postgres" --version)" in *' 17.'*) ;; *) echo 'PostgreSQL 17 required' >&2;exit 1;;esac
if [[ -d /Volumes/SmarterWork ]]; then
 [[ "$(df /Volumes/SmarterWork | tail -1 | awk '{print $NF}')" == /Volumes/SmarterWork ]]
 BASE=/Volumes/SmarterWork/agent-work
elif [[ "$(uname)" == Darwin ]]; then echo 'SSD not mounted' >&2;exit 1
else BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}";fi
WORK="$(mktemp -d "$BASE/lateflow.XXXXXX")"
finish() {
 "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
 if [[ -n "${LATE_FLOW_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$LATE_FLOW_EVIDENCE_DIR"
  cp "$WORK"/*.log "$LATE_FLOW_EVIDENCE_DIR/" 2>/dev/null || true
 fi
 rm -rf "$WORK"
}
trap finish EXIT
export LC_ALL=C LANG=C
"$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 >"$WORK/init.log" 2>&1
"$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -o "-k $WORK -p 56436 -h ''" -w start >/dev/null
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 56436 -U postgres -d postgres)
F="$ROOT/tests/fixtures/late-seat-flow"
OLD="$ROOT/tests/fixtures/union-pnl-blocked-resolution"
ORIGINAL="$ROOT/tests/fixtures/original-unchanged-stack"
MIG="$ROOT/supabase/migrations/20261012201712_late_departed_seat_settlement_proves_its_original_cash_flow.sql"
python3 "$F/load-captured.py" "$F/captured.jsonb" "$WORK/load.sql" "$F/captured-moves.jsonb"
"${PSQL[@]}" -f "$OLD/schema.sql" -f "$F/schema-additions.sql" -f "$ORIGINAL/schema-additions.sql" \
 -f "$F/admission-preimages.sql" -f "$ORIGINAL/cents-preimage.sql" -f "$F/consumer-preimage.sql" -f "$F/retained-preimages.sql" -f "$F/retained-key-preimage.sql" -f "$F/compact-preimages.sql" -f "$F/unused-original-dependencies.sql" \
 -f "$ORIGINAL/lineage-preimage.sql" -f "$WORK/load.sql" -f "$F/flow-preimage.sql" -f "$F/report-preimage.sql" -f "$F/access-preimage.sql" -f "$F/before.sql"
python3 "$F/admission-refusals.py" "$PGBIN" "$WORK" "$MIG"
sed 's/^COMMIT;$/ROLLBACK;/' "$MIG" >"$WORK/rollback.sql"
"${PSQL[@]}" -f "$WORK/rollback.sql" -c "DO \$\$BEGIN IF to_regprocedure('fn_union_pnl_prove_late_settlement(uuid)') IS NOT NULL OR md5(pg_get_functiondef('fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))<>'4b8273549e5781ff321c8e26d5b9bb39' OR md5(pg_get_functiondef('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))<>'929cc88e98cd027e821f871f8adbe935' THEN RAISE EXCEPTION 'rollback installation left changed source';END IF;END\$\$;"
echo 'PASS rolled-back exact installation restores both original readers and no new helper'
"${PSQL[@]}" -f "$MIG" -f "$F/after.sql" -f "$F/boundaries.sql" -f "$F/retained-cases.sql"
if "${PSQL[@]}" -f "$MIG" >"$WORK/replay.log" 2>&1;then echo 'ERROR migration replay unexpectedly passed';exit 1;fi
grep -q 'late settlement original proof dependency differs or already installed' "$WORK/replay.log"
echo 'PASS exact migration replay refuses'
"${PSQL[@]}" -A -t -c "SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl)) FROM pg_proc p WHERE p.oid IN('fn_union_pnl_prove_late_settlement(uuid)'::regprocedure,'fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,'fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)"
python3 "$F/arithmetic.py" "$F/report-preimage.sql" "$F/arithmetic-prefix.sql" "$WORK/arithmetic-before.sql" false
"${PSQL[@]}" -A -t -c "SELECT pg_get_functiondef('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)" >"$WORK/report-after.sql"
python3 "$F/arithmetic.py" "$WORK/report-after.sql" "$F/arithmetic-prefix.sql" "$WORK/arithmetic-after.sql" true
"${PSQL[@]}" -f "$WORK/arithmetic-before.sql" -f "$WORK/arithmetic-after.sql"
echo 'PASS PostgreSQL 17 original late-seat cash-flow qualification'
