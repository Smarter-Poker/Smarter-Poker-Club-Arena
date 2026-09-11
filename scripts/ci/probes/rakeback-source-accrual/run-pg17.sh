#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
probe_dir="$repo_root/scripts/ci/probes/rakeback-source-accrual"
preapply="$repo_root/scripts/ops/verify-rakeback-source-accrual-preapply.sql"
migration_resolver="$repo_root/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
[[ -r "$migration_resolver" && -r "$preapply" ]] || {
  echo 'Shared migration resolver or rakeback preapply is unavailable.' >&2
  exit 69
}
# The path is derived from this checked-in script.
# shellcheck disable=SC1090,SC1091
source "$migration_resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_root/supabase/migrations" \
  rakeback_accrues_atomically_with_its_source)"

if [[ -n "${PG17_BIN:-}" ]]; then
  pg_bin=$PG17_BIN
elif [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
  pg_bin=/opt/homebrew/opt/postgresql@17/bin
elif command -v postgres >/dev/null 2>&1 && postgres --version | grep -q ' 17\.'; then
  pg_bin=$(dirname "$(command -v postgres)")
else
  echo 'PostgreSQL 17 is required (set PG17_BIN to its bin directory).' >&2
  exit 1
fi

probe_tmp=$(mktemp -d "${TMPDIR:-/tmp}/rakeback-source-accrual.XXXXXX")
probe_socket="$probe_tmp/socket"
mkdir -p "$probe_socket"
cleanup() {
  "$pg_bin/pg_ctl" -D "$probe_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$probe_tmp"
}
trap cleanup EXIT

"$pg_bin/initdb" -D "$probe_tmp/data" -A trust -U "$USER" --no-locale -E UTF8 >/dev/null
"$pg_bin/pg_ctl" -D "$probe_tmp/data" -l "$probe_tmp/postgres.log" \
  -o "-h '' -k '$probe_socket' -p 55443" -w start >/dev/null

export PGHOST="$probe_socket" PGPORT=55443 PGUSER="$USER" PGDATABASE=postgres
psql_cmd=("$pg_bin/psql" -X -v ON_ERROR_STOP=1)

"${psql_cmd[@]}" -f "$probe_dir/setup.sql"

day_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure))")
period_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))")
allocator_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_allocate_rake_credits(numeric,jsonb,text)'::regprocedure))")
rate_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_player_rakeback_rate(uuid,uuid,numeric)'::regprocedure))")
ghost_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)'::regprocedure))")
tournament_attribution_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_tournament_fee_names_its_player()'::regprocedure))")
tournament_attribution_trigger_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_triggerdef(oid)) from pg_trigger where tgrelid='public.rake_records'::regclass and tgname='trg_tournament_fee_names_its_player' and not tgisinternal")
close_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_close_settlement_period(uuid)'::regprocedure))")
relink_md5=$("${psql_cmd[@]}" -Atc \
  "select md5(pg_get_functiondef('public.fn_relink_rake_record_to_hand(uuid,bigint,uuid)'::regprocedure))")

render_for_fixture() {
  local source_file=$1
  local destination_file=$2
  sed \
    -e "s/b00b5d017cb5a3699038e1bb8896b5d6/$day_md5/" \
    -e "s/2078fb6e89f22704096974ecf933e385/$period_md5/" \
    -e "s/74d61a3e0caf1037f6e6633eff0dd611/$allocator_md5/" \
    -e "s/f9b2424384371f47f9fba2006a3f646d/$rate_md5/" \
    -e "s/d59ea94ab309a36c5d5a1298cbc604d3/$ghost_md5/" \
    -e "s/a34e26b81ceeda38237b739245ff11f6/$tournament_attribution_md5/" \
    -e "s/b78ca0d8726cc7fce4d66ef6c2030027/$tournament_attribution_trigger_md5/" \
    -e "s/0af831a32835021d60f7098e07ce4ad5/$close_md5/" \
    -e "s/708827dbc7fabd0b753d3a7b8596f076/$relink_md5/" \
    "$source_file" > "$destination_file"
}

"${psql_cmd[@]}" -q -c \
  'CREATE SCHEMA supabase_migrations;
   CREATE TABLE supabase_migrations.schema_migrations (
     version text PRIMARY KEY,
     statements text[] NOT NULL,
     name text
   );'
render_for_fixture "$preapply" "$probe_tmp/rendered-preapply.sql"
preapply_receipt="$("${psql_cmd[@]}" -qAt -f "$probe_tmp/rendered-preapply.sql")"
[[ "$preapply_receipt" == RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK\ * \
   && "$preapply_receipt" != *$'\n'* ]] || {
  echo "Rakeback PG17 preapply returned an invalid receipt: ${preapply_receipt:-<empty>}" >&2
  exit 1
}
echo "$preapply_receipt"

render_for_fixture "$migration" "$probe_tmp/rendered-migration.sql"

"${psql_cmd[@]}" -f "$probe_tmp/rendered-migration.sql"
"${psql_cmd[@]}" -f "$probe_dir/assertions.sql"

"${psql_cmd[@]}" -f "$probe_dir/concurrent-a.sql" > "$probe_tmp/concurrent-a.log" 2>&1 &
concurrent_a=$!
sleep 0.1
"${psql_cmd[@]}" -f "$probe_dir/concurrent-b.sql" > "$probe_tmp/concurrent-b.log" 2>&1 &
concurrent_b=$!
wait "$concurrent_a"
wait "$concurrent_b"
"${psql_cmd[@]}" -f "$probe_dir/concurrency-assert.sql"

run_close_race() {
  local race_name=$1
  local application_name=$2
  local a_file=$3
  local b_file=$4
  local a_log="$probe_tmp/${race_name}-a.log"
  local b_log="$probe_tmp/${race_name}-b.log"
  local a_pid
  local lock_seen=false

  "${psql_cmd[@]}" -f "$a_file" >"$a_log" 2>&1 &
  a_pid=$!
  for _ in {1..100}; do
    if [[ $("${psql_cmd[@]}" -Atc \
      "select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='$application_name' and l.locktype='advisory' and l.granted)") == t ]]; then
      lock_seen=true
      break
    fi
    sleep 0.02
  done
  if [[ $lock_seen != true ]]; then
    cat "$a_log" >&2
    wait "$a_pid" || true
    echo "$race_name did not acquire its close lock" >&2
    exit 1
  fi
  if ! "${psql_cmd[@]}" -f "$b_file" >"$b_log" 2>&1; then
    cat "$a_log" >&2
    cat "$b_log" >&2
    wait "$a_pid" || true
    exit 1
  fi
  if ! wait "$a_pid"; then
    cat "$a_log" >&2
    cat "$b_log" >&2
    exit 1
  fi
}

run_close_race close-accrual rakeback_close_accrual_a \
  "$probe_dir/close-accrual-a.sql" "$probe_dir/close-accrual-b.sql"
run_close_race close-reversal rakeback_close_reversal_a \
  "$probe_dir/close-reversal-a.sql" "$probe_dir/close-reversal-b.sql"
"${psql_cmd[@]}" -f "$probe_dir/close-race-assert.sql"

run_close_race ghost-supersession rakeback_ghost_race_a \
  "$probe_dir/ghost-race-a.sql" "$probe_dir/ghost-race-b.sql"
"${psql_cmd[@]}" -f "$probe_dir/ghost-race-assert.sql"
"${psql_cmd[@]}" -f "$probe_dir/production-readonly.sql"

echo RAKEBACK_SOURCE_ACCRUAL_PG17_OK
