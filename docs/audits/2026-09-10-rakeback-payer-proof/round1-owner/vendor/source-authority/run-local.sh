#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
proposal_dir="$(dirname "$source_dir")"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
source_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-source-proof.XXXXXX")"
source_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$source_share/postgres.bki" ]]; then source_share="$PGBIN/../share/postgresql"; fi
cleanup() { "$PGBIN/pg_ctl" -D "$source_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir "$source_tmp/socket"
"$PGBIN/initdb" -L "$source_share" -D "$source_tmp/data" -U commission_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$source_tmp/data" -l "$source_tmp/postgres.log" -o "-h '' -k '$source_tmp/socket' -p 55471" -w start >/dev/null
export PGHOST="$source_tmp/socket" PGPORT=55471 PGUSER=commission_test PGDATABASE=postgres
export COMMISSION_PSQL="$PGBIN/psql"
source_psql=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q)
"${source_psql[@]}" -f "$proposal_dir/fixture.sql"
"${source_psql[@]}" -f "$proposal_dir/live-resolver-and-calculator.sql"
"${source_psql[@]}" -f "$proposal_dir/fixture-grants.sql"
"${source_psql[@]}" -f "$proposal_dir/01-schema.sql"
"${source_psql[@]}" -f "$proposal_dir/02-online-index.sql"
"${source_psql[@]}" -f "$proposal_dir/03-cutover.sql"
"${source_psql[@]}" -f "$source_dir/fixture.sql"
"${source_psql[@]}" -f "$source_dir/live-allocator.sql"
"${source_psql[@]}" -f "$source_dir/live-commission-triggers.sql"
"${source_psql[@]}" -f "$source_dir/01-source-schema.sql"
"${source_psql[@]}" -f "$source_dir/02-capture.sql"
"${source_psql[@]}" -f "$source_dir/live-accepted-owner.sql"
"${source_psql[@]}" -c "REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;"
"${source_psql[@]}" -c BEGIN -f "$source_dir/03-accepted-owner-patch.sql" -c ROLLBACK
"${source_psql[@]}" -c "SELECT test_assert('Owner cutover rollback restores body and leaves no activation', NOT EXISTS(SELECT 1 FROM ca_cash_commission_authority) AND (SELECT md5(prosrc)='0ef3c57a6a31acc383ce4b95a0f9519f' FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure));"
"${source_psql[@]}" -c BEGIN -f "$source_dir/03-accepted-owner-patch.sql" -f "$source_dir/04-cash-admission.sql" -c COMMIT
"${source_psql[@]}" -f "$source_dir/05-immutable-receipts.sql"
"${source_psql[@]}" -f "$source_dir/assertions.sql"
python3 "$source_dir/parallel-probes.py"
"${source_psql[@]}" -Atc "SELECT jsonb_build_object('checks',count(*),'all_passed',bool_and(passed)) FROM test_checks"
printf 'Evidence directory: %s\n' "$source_tmp"
