#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

migration_by_suffix() {
  local suffix="$1"
  local matches=()
  local match
  while IFS= read -r match; do
    matches+=("$match")
  done < <(
    find "$repo_dir/supabase/migrations" -maxdepth 1 -type f \
      \( -name "*_${suffix}" -o -name "*_${suffix}.pending" \) -print | sort
  )
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one staged-or-promoted migration ending ${suffix}; found ${#matches[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

migration="$({
  migration_by_suffix stage_b_lease_keyshare_once.sql
})"
heartbeat_migration="$({
  migration_by_suffix lease_heartbeats_skip_busy_generations.sql
})"
busy_manager_migration="$repo_dir/supabase/migrations/20260910063559_a_busy_manager_keeps_its_lease.sql"
hand_heartbeat_migration="$repo_dir/supabase/migrations/20260910064701_a_hand_commit_does_not_hold_the_lease_against_its_own_heartb.sql"
claim_source="$repo_dir/supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql"
hand_source="$repo_dir/supabase/migrations/20260908043100_table_leases_and_hand_commits_have_generations.sql"
close_source="$repo_dir/supabase/migrations/20260908043300_tournament_table_break_close_is_atomic.sql"
hook_source="$repo_dir/supabase/migrations/20260908125958_tournament_manager_requests_carry_lease_authority.sql"
addon_source="$repo_dir/supabase/migrations/20260908130009_post_commit_obligations_are_atomic_and_resumable.sql"
current_postimage_source="$repo_dir/supabase/migrations/20260910055955_stage_b_current_postimage_contraction.sql"

for required_source in \
  "$busy_manager_migration" \
  "$hand_heartbeat_migration" \
  "$claim_source" \
  "$hand_source" \
  "$close_source" \
  "$hook_source" \
  "$addon_source" \
  "$current_postimage_source"; do
  if [[ ! -f "$required_source" ]]; then
    echo "Required authenticated preimage source is missing: $required_source" >&2
    exit 1
  fi
done

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "/tmp/ca-lease-keyshare-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
claim_sql="${probe_root}/claim.sql"
hand_sql="${probe_root}/hand.sql"
close_sql="${probe_root}/close.sql"
hook_sql="${probe_root}/hook.sql"
addon_sql="${probe_root}/addon.sql"
stage_b_hook_sql="${probe_root}/stage-b-hook.sql"
mkdir -p "$socket_dir"
port="$((41432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-lease-keyshare-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

extract_function() {
  local source_file="$1"
  local signature="$2"
  local destination="$3"
  awk -v signature="$signature" '
    index($0, signature) == 1 { capture = 1 }
    capture { print }
    capture && /^\$function\$;$/ { found = 1; exit }
    END { if (!found) exit 1 }
  ' "$source_file" >"$destination" || {
    echo "Could not extract authenticated function: $signature" >&2
    exit 1
  }
}

extract_function_with_marker() {
  local source_file="$1"
  local signature="$2"
  local marker="$3"
  local destination="$4"
  awk -v signature="$signature" -v marker="$marker" '
    index($0, signature) == 1 { capture = 1; candidate = "" }
    capture { candidate = candidate $0 ORS }
    capture && /^\$function\$;$/ {
      if (index(candidate, marker) > 0) {
        printf "%s", candidate
        found = 1
        exit
      }
      capture = 0
      candidate = ""
    }
    END { if (!found) exit 1 }
  ' "$source_file" >"$destination" || {
    echo "Could not extract authenticated function containing: $marker" >&2
    exit 1
  }
}

extract_function \
  "$claim_source" \
  'CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(' \
  "$claim_sql"
extract_function_with_marker \
  "$hand_source" \
  'CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(' \
  'p_lease_generation uuid' \
  "$hand_sql"
extract_function \
  "$close_source" \
  'CREATE OR REPLACE FUNCTION public.fn_close_empty_tournament_table(' \
  "$close_sql"
extract_function \
  "$hook_source" \
  'CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()' \
  "$hook_sql"
extract_function \
  "$addon_source" \
  'CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons(' \
  "$addon_sql"
extract_function \
  "$current_postimage_source" \
  'CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()' \
  "$stage_b_hook_sql"

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port} -c deadlock_timeout=100ms" \
  -w start >/dev/null; then
  sed -n '1,240p' "$postgres_log" >&2
  exit 1
fi

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -U postgres -d postgres
)

"${psql_cmd[@]}" \
  -f "$repo_dir/scripts/dev/fixtures/lease-heartbeat-keyshare-pg17-bootstrap.sql" \
  >/dev/null
"${psql_cmd[@]}" -f "$claim_sql" >/dev/null
"${psql_cmd[@]}" -f "$hand_sql" >/dev/null
"${psql_cmd[@]}" -c \
  'ALTER FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) RENAME TO fn_ca_commit_hand_settlement_exact_before_obligations;' \
  >/dev/null
"${psql_cmd[@]}" -f "$close_sql" >/dev/null
"${psql_cmd[@]}" -f "$hook_sql" >/dev/null
"${psql_cmd[@]}" -f "$addon_sql" >/dev/null
"${psql_cmd[@]}" -f "$heartbeat_migration" >/dev/null
"${psql_cmd[@]}" -c \
  'REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role; REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role; REVOKE ALL ON FUNCTION public.fn_close_empty_tournament_table(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_close_empty_tournament_table(uuid,uuid,uuid) TO service_role; REVOKE ALL ON FUNCTION public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid) TO service_role; REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO anon,authenticated,service_role;' \
  >/dev/null
"${psql_cmd[@]}" -f "$busy_manager_migration" >/dev/null
"${psql_cmd[@]}" -f "$hand_heartbeat_migration" >/dev/null
"${psql_cmd[@]}" -f "$stage_b_hook_sql" >/dev/null

# A Stage-A legacy door must make the migration refuse before either
# ownership constraint or any weaker lock is installed.
"${psql_cmd[@]}" -c \
  'CREATE FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object() $$;' \
  >/dev/null
stage_a_log="${probe_root}/stage-a-refusal.log"
if "${psql_cmd[@]}" -f "$migration" >"$stage_a_log" 2>&1; then
  echo 'The key-share migration accepted a Stage-A catalog.' >&2
  exit 1
fi
if ! grep -Fq 'LEASE_KEYSHARE_REQUIRES_STRICT_STAGE_B' "$stage_a_log"; then
  sed -n '1,240p' "$stage_a_log" >&2
  exit 1
fi
"${psql_cmd[@]}" -c \
  'DROP FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb);' \
  >/dev/null

# heartbeat_at must not silently become a key column in some other immediate
# unique index. Prove each relation makes the migration abort atomically.
table_key_log="${probe_root}/table-heartbeat-key-refusal.log"
"${psql_cmd[@]}" -c \
  'CREATE UNIQUE INDEX lease_probe_bad_table_heartbeat_key ON public.engine_table_leases(table_id, heartbeat_at);' \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$table_key_log" 2>&1; then
  echo 'The key-share migration accepted heartbeat_at as a table ownership key.' >&2
  exit 1
fi
if ! grep -Fq 'LEASE_HEARTBEAT_KEY_COLUMN_INVALID' "$table_key_log"; then
  sed -n '1,240p' "$table_key_log" >&2
  exit 1
fi
"${psql_cmd[@]}" -c 'DROP INDEX public.lease_probe_bad_table_heartbeat_key;' >/dev/null

tournament_key_log="${probe_root}/tournament-heartbeat-key-refusal.log"
"${psql_cmd[@]}" -c \
  'CREATE UNIQUE INDEX lease_probe_bad_tournament_heartbeat_key ON public.engine_tournament_leases(tournament_id, heartbeat_at);' \
  >/dev/null
if "${psql_cmd[@]}" -f "$migration" >"$tournament_key_log" 2>&1; then
  echo 'The key-share migration accepted heartbeat_at as a tournament ownership key.' >&2
  exit 1
fi
if ! grep -Fq 'LEASE_HEARTBEAT_KEY_COLUMN_INVALID' "$tournament_key_log"; then
  sed -n '1,240p' "$tournament_key_log" >&2
  exit 1
fi
"${psql_cmd[@]}" -c 'DROP INDEX public.lease_probe_bad_tournament_heartbeat_key;' >/dev/null

"${psql_cmd[@]}" -f "$migration" >/dev/null

table_id='11111111-1111-4111-8111-111111111111'
tournament_table_id='55555555-5555-4555-8555-555555555555'
tournament_id='22222222-2222-4222-8222-222222222222'
table_generation='33333333-3333-4333-8333-333333333333'
tournament_generation='44444444-4444-4444-8444-444444444444'

run_case() {
  local label="$1"
  local holder_sql="$2"
  local relation="$3"
  local id_column="$4"
  local id_value="$5"
  local original_generation="$6"
  local replacement_generation="$7"
  local holder_log="${probe_root}/${label}-holder.log"
  local takeover_log="${probe_root}/${label}-takeover.log"
  local delete_log="${probe_root}/${label}-delete.log"
  local holder_pid
  local ready=0
  local heartbeat_result
  local heartbeat_sql
  local post_result

  "${psql_cmd[@]}" -c \
    "SET application_name = 'lease-keyshare-${label}'; BEGIN; ${holder_sql} SELECT pg_sleep(3); COMMIT;" \
    >"$holder_log" 2>&1 &
  holder_pid=$!

  for _ in {1..100}; do
    ready="$("${psql_cmd[@]}" -Atq -c \
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'lease-keyshare-${label}' AND state = 'active' AND wait_event = 'PgSleep';")"
    [[ "$ready" == '1' ]] && break
    sleep 0.05
  done
  if [[ "$ready" != '1' ]]; then
    sed -n '1,240p' "$holder_log" >&2
    echo "${label}: holder never reached the post-fence sleep." >&2
    exit 1
  fi

  if [[ "$relation" == 'engine_table_leases' ]]; then
    heartbeat_sql="SELECT state FROM public.heartbeat_table_leases_v4('probe-owner', jsonb_build_array(jsonb_build_object('table_id', '${id_value}', 'lease_generation', '${original_generation}')), 30);"
  else
    heartbeat_sql="SELECT state FROM public.heartbeat_tournament_leases_v4('probe-owner', jsonb_build_array(jsonb_build_object('tournament_id', '${id_value}', 'lease_generation', '${original_generation}')), 30);"
  fi

  # Call the real v4 lockable/renewed CTE. heartbeat_at is not an ownership
  # key, so it must return kept rather than skipping this row as busy.
  heartbeat_result="$("${psql_cmd[@]}" -Atq -c \
    "SET statement_timeout = '800ms'; ${heartbeat_sql}")"
  if [[ "$heartbeat_result" != 'kept' ]]; then
    echo "${label}: exact v4 heartbeat returned ${heartbeat_result:-no row}, not kept." >&2
    exit 1
  fi

  # Both ownership replacement and exact release must still wait.  Verbose
  # errors pin SQLSTATE 55P03 rather than accepting an unrelated failure.
  if "${psql_cmd[@]}" -c '\set VERBOSITY verbose' -c \
    "SET lock_timeout = '300ms'; UPDATE public.${relation} SET instance_id = 'replacement-owner', lease_generation = '${replacement_generation}'::uuid WHERE ${id_column} = '${id_value}'::uuid;" \
    >"$takeover_log" 2>&1; then
    echo "${label}: ownership replacement crossed a live fence." >&2
    exit 1
  fi
  if ! grep -Fq '55P03' "$takeover_log"; then
    sed -n '1,240p' "$takeover_log" >&2
    exit 1
  fi

  if "${psql_cmd[@]}" -c '\set VERBOSITY verbose' -c \
    "SET lock_timeout = '300ms'; DELETE FROM public.${relation} WHERE ${id_column} = '${id_value}'::uuid AND lease_generation = '${original_generation}'::uuid;" \
    >"$delete_log" 2>&1; then
    echo "${label}: exact release crossed a live fence." >&2
    exit 1
  fi
  if ! grep -Fq '55P03' "$delete_log"; then
    sed -n '1,240p' "$delete_log" >&2
    exit 1
  fi

  if ! wait "$holder_pid"; then
    sed -n '1,240p' "$holder_log" >&2
    exit 1
  fi

  # After the fenced transaction commits, both operations must proceed.  The
  # row is then restored for the next effective-function case.
  post_result="$("${psql_cmd[@]}" -c \
    "UPDATE public.${relation} SET instance_id = 'replacement-owner', lease_generation = '${replacement_generation}'::uuid WHERE ${id_column} = '${id_value}'::uuid;" \
    -c "DELETE FROM public.${relation} WHERE ${id_column} = '${id_value}'::uuid AND instance_id = 'replacement-owner' AND lease_generation = '${replacement_generation}'::uuid;" \
    -c "INSERT INTO public.${relation}(${id_column}, instance_id, lease_generation) VALUES ('${id_value}'::uuid, 'probe-owner', '${original_generation}'::uuid);")"
  if [[ "$post_result" != *'UPDATE 1'* || "$post_result" != *'DELETE 1'* || "$post_result" != *'INSERT 0 1'* ]]; then
    printf '%s\n' "$post_result" >&2
    echo "${label}: replacement/release did not proceed after fence completion." >&2
    exit 1
  fi

  printf 'LEASE_KEYSHARE_CASE_OK %s\n' "$label"
}

run_case \
  'exact-hand-cash' \
  "SELECT public.fn_ca_commit_hand_settlement_exact_before_obligations('${table_id}'::uuid, 1, '{}'::jsonb, 0, 0, 'probe', 0, '{}'::jsonb, '{}'::jsonb, 'probe-owner', '${table_generation}'::uuid);" \
  'engine_table_leases' 'table_id' "$table_id" "$table_generation" \
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

run_case \
  'pending-addon' \
  "SELECT public.fn_ca_resolve_unbound_pending_addons('${table_id}'::uuid, 100, 'probe-owner', '${table_generation}'::uuid);" \
  'engine_table_leases' 'table_id' "$table_id" "$table_generation" \
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

run_case \
  'exact-hand-tournament' \
  "SELECT public.fn_ca_commit_hand_settlement_exact_before_obligations('${tournament_table_id}'::uuid, 2, '{}'::jsonb, 0, 0, 'probe', 0, '{}'::jsonb, '{}'::jsonb, 'probe-owner', '${tournament_generation}'::uuid);" \
  'engine_tournament_leases' 'tournament_id' "$tournament_id" "$tournament_generation" \
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

run_case \
  'empty-table-close' \
  "SELECT set_config('app.smarter_data_actor','tournament-manager',true), set_config('app.smarter_tournament_id','${tournament_id}',true), set_config('app.smarter_tournament_lease_generation','${tournament_generation}',true); SELECT public.fn_close_empty_tournament_table('${tournament_id}'::uuid, '${tournament_table_id}'::uuid, '${tournament_generation}'::uuid);" \
  'engine_tournament_leases' 'tournament_id' "$tournament_id" "$tournament_generation" \
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

run_case \
  'manager-request-hook' \
  "SELECT set_config('request.headers','{\"x-smarter-data-actor\":\"tournament-manager\",\"x-smarter-data-protocol\":\"2\",\"x-smarter-tournament-id\":\"${tournament_id}\",\"x-smarter-tournament-lease-generation\":\"${tournament_generation}\"}',true), set_config('request.jwt.claims','{\"role\":\"service_role\"}',true), set_config('request.method','POST',true), set_config('request.path','rpc/fn_close_empty_tournament_table',true); SELECT smarter_private.fn_smarter_data_api_pre_request();" \
  'engine_tournament_leases' 'tournament_id' "$tournament_id" "$tournament_generation" \
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

echo 'LEASE_HEARTBEAT_KEYSHARE_PG17_OK'
