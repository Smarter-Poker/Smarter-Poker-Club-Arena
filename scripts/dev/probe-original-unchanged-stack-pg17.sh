#!/usr/bin/env bash
# Private native qualification; no remote URL or money connection is accepted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
case "$("$PGBIN/postgres" --version)" in *' 17.'*) ;; *) echo 'PostgreSQL 17 required' >&2;exit 1;;esac
if [[ -d /Volumes/SmarterWork ]]; then
 [[ "$(df /Volumes/SmarterWork | tail -1 | awk '{print $NF}')" == /Volumes/SmarterWork ]]
 BASE=/Volumes/SmarterWork/agent-work
elif [[ "$(uname)" == Darwin ]]; then echo 'SSD not mounted' >&2;exit 1
else BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}";fi
WORK="$(mktemp -d "$BASE/usprobe.XXXXXX")"
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
export LC_ALL=C LANG=C
"$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 >"$WORK/init.log" 2>&1
"$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -o "-k $WORK -p 56435 -h ''" -w start >/dev/null
F="$ROOT/tests/fixtures/original-unchanged-stack"
OLD="$ROOT/tests/fixtures/union-pnl-blocked-resolution"
MIG="$ROOT/supabase/migrations/20261012161442_an_original_unchanged_stack_is_proved_from_its_accepted_pred.sql"
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 56435 -U postgres -d postgres)
"${PSQL[@]}" -f "$OLD/schema.sql" -f "$F/schema-additions.sql" -f "$F/cents-preimage.sql" -f "$OLD/captured-preimages.sql" \
 -f "$OLD/seed.sql" -f "$ROOT/supabase/migrations/20260928050509_a_late_seat_credit_is_resolved_from_its_receipts_not_forgive.sql" \
 -f "$F/lineage-preimage.sql" -f "$F/seed-original.sql" -f "$F/before.sql"
sed 's/^COMMIT;$/ROLLBACK;/' "$MIG" >"$WORK/rollback-install.sql"
"${PSQL[@]}" -f "$WORK/rollback-install.sql" -c "DO \$\$BEGIN IF to_regprocedure('fn_union_pnl_prove_original_unchanged_stack(uuid,bigint)') IS NOT NULL OR to_regprocedure('fn_union_pnl_resolve_original_unchanged_stack(uuid,bigint,text)') IS NOT NULL OR md5(pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='union_pnl_cash_outcome_resolutions_resolution_kind_check'))) <> '51cb9926233107b662e43cf5c91e7ed8' THEN RAISE EXCEPTION 'rollback install left changed objects';END IF;END\$\$;"
echo 'PASS rollback installation leaves original constraint and no new functions'
"${PSQL[@]}" -f "$MIG" -f "$F/after.sql" -f "$F/boundaries.sql"
if "${PSQL[@]}" -f "$MIG" >"$WORK/replay.log" 2>&1;then echo 'ERROR migration replay unexpectedly passed';exit 1;fi
grep -q 'original unchanged-stack source preimage differs or already installed' "$WORK/replay.log"
echo 'PASS exact migration replay refuses; financial originals preserved'

# Same original components, separate database: actual retained primary records,
# not synthetic recreations of the three Oct 6 target cases.
"$PGBIN/createdb" -h "$WORK" -p 56435 -U postgres real_originals
sed '/^CREATE ROLE anon /d' "$OLD/schema.sql" >"$WORK/real-schema.sql"
python3 "$F/load-captured.py" "$F" "$WORK/load-originals.sql"
REAL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 56435 -U postgres -d real_originals)
"${REAL[@]}" -f "$WORK/real-schema.sql" -f "$F/schema-additions.sql" -f "$F/cents-preimage.sql" -f "$OLD/captured-preimages.sql" \
 -f "$ROOT/supabase/migrations/20260928050509_a_late_seat_credit_is_resolved_from_its_receipts_not_forgive.sql" \
 -f "$F/lineage-preimage.sql" -f "$WORK/load-originals.sql" -f "$MIG" -f "$F/real-cases.sql"
python3 "$F/concurrency.py" "$PGBIN" "$WORK"
echo 'PASS PostgreSQL 17 exact original unchanged-stack migration qualification'
