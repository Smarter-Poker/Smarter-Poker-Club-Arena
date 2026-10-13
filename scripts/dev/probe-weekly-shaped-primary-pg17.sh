#!/usr/bin/env bash
# Exact original posthand escrow, isolated native PG17; no remote connection input.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
case "$("$PGBIN/postgres" --version)" in *' 17.'*) ;; *) echo 'PostgreSQL17 required' >&2;exit 1;;esac
if [[ -d /Volumes/SmarterWork ]]; then
 [[ "$(df /Volumes/SmarterWork | tail -1 | awk '{print $NF}')" == /Volumes/SmarterWork ]]
 BASE=/Volumes/SmarterWork/agent-work
elif [[ "$(uname)" == Darwin ]]; then echo 'SSD not mounted' >&2;exit 1
else BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}";fi
WORK="$(mktemp -d "$BASE/shaped-primary.XXXXXX")"
started=false
finish() {
 local status=$?
 if [[ "$started" == true ]]; then
  if ! "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >"$WORK/stop.log" 2>&1; then
   echo "ERROR: owned private PG cleanup failed; retained $WORK" >&2
   status=1
  else started=false;fi
 fi
 if [[ -n "${SHAPED_PRIMARY_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$SHAPED_PRIMARY_EVIDENCE_DIR"
  for log in "$WORK"/*.log; do [[ ! -f "$log" ]] || cp "$log" "$SHAPED_PRIMARY_EVIDENCE_DIR/";done
 fi
 [[ "$started" == true ]] || rm -rf "$WORK"
 exit "$status"
}
trap finish EXIT
export LC_ALL=C LANG=C
"$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 >"$WORK/init.log" 2>&1
"$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -o "-k $WORK -p 56449 -h ''" -w start >/dev/null
started=true
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 56449 -U postgres -d postgres)
F="$ROOT/tests/fixtures/posthand-escrow"
FLOW="$ROOT/tests/fixtures/late-seat-flow"
OLD="$ROOT/tests/fixtures/union-pnl-blocked-resolution"
ORIGINAL="$ROOT/tests/fixtures/original-unchanged-stack"
PRIOR="$ROOT/supabase/migrations/20261012201712_late_departed_seat_settlement_proves_its_original_cash_flow.sql"
MIG="$ROOT/supabase/migrations/20261012211046_original_posthand_escrow_retains_its_completed_financial_pro.sql"
python3 "$FLOW/load-captured.py" "$F/captured.jsonb" "$WORK/load.sql"
"${PSQL[@]}" -f "$OLD/schema.sql" -f "$FLOW/schema-additions.sql" -f "$ORIGINAL/schema-additions.sql" \
 -f "$FLOW/admission-preimages.sql" -f "$ORIGINAL/cents-preimage.sql" -f "$FLOW/consumer-preimage.sql" \
 -f "$FLOW/retained-preimages.sql" -f "$FLOW/retained-key-preimage.sql" -f "$FLOW/compact-preimages.sql" \
 -f "$F/atomic-original-preimage.sql" -f "$F/retained-atomic-preimage.sql" -f "$FLOW/unused-original-dependencies.sql" -f "$ORIGINAL/lineage-preimage.sql" \
 -f "$WORK/load.sql" -f "$FLOW/flow-preimage.sql" -f "$FLOW/report-preimage.sql" -f "$FLOW/access-preimage.sql" \
 -f "$F/pruner-schema.sql" -f "$F/f06-preimages.sql" -f "$F/unchanged-pruner-preimages.sql" \
 -f "$F/cash-evidence-preimage.sql" -f "$F/hand-lines-preimage.sql" -f "$F/touch-seed.sql" -f "$F/access-preimage.sql" -f "$PRIOR"
python3 - "$PRIOR" "$WORK/prior-history.sql" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert '$original_prior$' not in s
Path(sys.argv[2]).write_text("CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);INSERT INTO supabase_migrations.schema_migrations VALUES('20261012201712','native qualified predecessor',ARRAY[$original_prior$"+s+"$original_prior$]);\n")
PY
"${PSQL[@]}" -f "$WORK/prior-history.sql"

"${PSQL[@]}" -f "$MIG"
# Exact captured three original cases coexist with the actual fourth; create
# their already-qualified proof/writer definitions, not an alternate acceptance.
python3 "$ORIGINAL/load-captured.py" "$ORIGINAL" "$WORK/load-three.sql"
python3 - "$ROOT" "$WORK/original-proof-creates.sql" <<'PY_EXTRACT'
from pathlib import Path
import sys
r=Path(sys.argv[1]);s=(r/'supabase/migrations/20261012161442_an_original_unchanged_stack_is_proved_from_its_accepted_pred.sql').read_text()
a=s.index('ALTER TABLE public.union_pnl_cash_outcome_resolutions');b=s.index('DO $post$',a)
Path(sys.argv[2]).write_text("ALTER TABLE public.union_pnl_cash_outcome_resolutions ADD CONSTRAINT union_pnl_cash_outcome_resolutions_resolution_kind_check CHECK(resolution_kind='late_seat_credit_after_roster_snapshot');\n"+s[a:b])
PY_EXTRACT
"${PSQL[@]}" -f "$WORK/load-three.sql" -f "$WORK/original-proof-creates.sql"
# Install the exact current protected report definition for dependency readback;
# report is never invoked by this reader-only qualification.
python3 - "$ROOT" "$WORK/current-report.sql" <<'PY_REPORT'
from pathlib import Path
import sys
r=Path(sys.argv[1]);p=next((r/'supabase/migrations').glob('20261012224150_*.sql'));s=p.read_text()
a=s.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report');b=s.index('$function$;',a)+len('$function$;')
Path(sys.argv[2]).write_text(s[a:b])
PY_REPORT
"${PSQL[@]}" -f "$WORK/current-report.sql"
Q="$ROOT/tests/fixtures/weekly-shaped-primary"
NEW="$ROOT/supabase/migrations/20261013024122_weekly_shaped_hands_start_from_original_unaccepted.sql"
sed 's/^COMMIT;$/ROLLBACK;/' "$NEW" >"$WORK/rollback.sql"
"${PSQL[@]}" -v migration="$NEW" -v rollback_migration="$WORK/rollback.sql" -f "$Q/preimage.sql"
"${PSQL[@]}" -c "ALTER FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) OWNER TO postgres;REVOKE ALL ON FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;"
python3 "$Q/admission.py" "$PGBIN" "$WORK" "$NEW"
"${PSQL[@]}" -v migration="$NEW" -v rollback_migration="$WORK/rollback.sql" -f "$Q/native.sql"

"${PSQL[@]}" -At -c "SELECT md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure));" >"$WORK/postimage.log"
python3 "$Q/performance.py" "$PGBIN" "$WORK" "$ROOT"

if "${PSQL[@]}" -f "$NEW" >"$WORK/replay.log" 2>&1;then echo 'ERROR original reader migration replay admitted';exit 1;fi
grep -q SHAPED_PRIMARY_PREIMAGE_OR_REPLAY_REFUSED "$WORK/replay.log"
echo 'PASS exact migration replay refused; owned private cluster cleaned'
