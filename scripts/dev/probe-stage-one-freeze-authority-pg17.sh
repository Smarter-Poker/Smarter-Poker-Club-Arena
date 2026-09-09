#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
canonical="${repo_dir}/supabase/migrations/20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql"
cutover="${repo_dir}/supabase/migrations/20260909014421_satellite_settlement_has_one_atomic_authority.sql"
bootstrap="${repo_dir}/scripts/dev/fixtures/stage-one-freeze-authority-pg17-bootstrap.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | rg -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

for required in "$canonical" "$cutover" "$bootstrap"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-freeze-authority-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
predicate_sql="${probe_root}/predicate.sql"
writer_sql="${probe_root}/writer.sql"
authentication_sql="${probe_root}/authentication.sql"
mkdir -p "$socket_dir"
port="$((38432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-freeze-authority-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -d postgres
)

extract_function() {
  local signature="$1"
  local destination="$2"
  awk -v signature="$signature" '
    index($0, signature) == 1 { capture = 1 }
    capture { print }
    capture && /^\$function\$;$/ { exit }
  ' "$canonical" >"$destination"
  if ! rg -q '^\$function\$;$' "$destination"; then
    echo "Could not extract canonical function: $signature" >&2
    exit 1
  fi
}

extract_function \
  'CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()' \
  "$predicate_sql"
extract_function \
  'CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write()' \
  "$writer_sql"

awk '
  /^DO \$authenticate_entry_freeze_authority\$/ { capture = 1 }
  capture { print }
  capture && /^\$authenticate_entry_freeze_authority\$;$/ { exit }
' "$cutover" >"$authentication_sql"
if ! rg -q '^\$authenticate_entry_freeze_authority\$;$' "$authentication_sql"; then
  echo 'Could not extract stage-one freeze authentication block.' >&2
  exit 1
fi

"${pg17_bin}/postgres" --version
"${psql_cmd[@]}" -f "$bootstrap" >/dev/null
"${psql_cmd[@]}" -f "$predicate_sql" >/dev/null
"${psql_cmd[@]}" -f "$writer_sql" >/dev/null
"${psql_cmd[@]}" -c \
  'CREATE TRIGGER aa_serialize_maintenance_break_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.engine_maintenance_break FOR EACH STATEMENT EXECUTE FUNCTION public.fn_serialize_engine_maintenance_break_write()' \
  >/dev/null

"${psql_cmd[@]}" -c 'CREATE ROLE portable_freeze_owner NOLOGIN' >/dev/null
"${psql_cmd[@]}" -c 'CREATE ROLE mismatched_freeze_owner NOLOGIN' >/dev/null
"${psql_cmd[@]}" -c 'ALTER TABLE public.engine_maintenance_break OWNER TO portable_freeze_owner' >/dev/null
"${psql_cmd[@]}" -c 'ALTER FUNCTION public.fn_entry_purchases_frozen() OWNER TO portable_freeze_owner' >/dev/null
"${psql_cmd[@]}" -c 'ALTER FUNCTION public.fn_serialize_engine_maintenance_break_write() OWNER TO portable_freeze_owner' >/dev/null

run_authentication() {
  "${psql_cmd[@]}" -f "$authentication_sql" >/dev/null
}

expect_refusal() {
  local label="$1"
  local expected="$2"
  local output
  local result
  set +e
  output="$("${psql_cmd[@]}" -f "$authentication_sql" 2>&1)"
  result=$?
  set -e
  if [[ $result -eq 0 ]] || ! rg -q "$expected" <<<"$output"; then
    echo "$label did not fail closed as expected" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s\n' "$label: PASS"
}

run_authentication
echo 'portable canonical authority: PASS'

"${psql_cmd[@]}" -c \
  "CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS 'SELECT true'" \
  >/dev/null
expect_refusal 'stubbed predicate' 'maintenance entry-freeze predicate is not canonical'
"${psql_cmd[@]}" -f "$predicate_sql" >/dev/null

"${psql_cmd[@]}" -c \
  "CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS 'BEGIN RETURN NULL; END'" \
  >/dev/null
expect_refusal 'stubbed serialization function' 'maintenance-row serialization function is not canonical'
"${psql_cmd[@]}" -f "$writer_sql" >/dev/null

"${psql_cmd[@]}" -c \
  'ALTER FUNCTION public.fn_entry_purchases_frozen() OWNER TO mismatched_freeze_owner' >/dev/null
expect_refusal 'predicate owner mismatch' 'maintenance entry-freeze predicate is not canonical'
"${psql_cmd[@]}" -c \
  'ALTER FUNCTION public.fn_entry_purchases_frozen() OWNER TO portable_freeze_owner' >/dev/null

"${psql_cmd[@]}" -c \
  'DROP TRIGGER aa_serialize_maintenance_break_write ON public.engine_maintenance_break' \
  >/dev/null
expect_refusal 'missing trigger' 'maintenance-row serialization trigger is not canonical and enabled'
"${psql_cmd[@]}" -c \
  'CREATE TRIGGER aa_serialize_maintenance_break_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.engine_maintenance_break FOR EACH STATEMENT EXECUTE FUNCTION public.fn_serialize_engine_maintenance_break_write()' \
  >/dev/null

"${psql_cmd[@]}" -c \
  'ALTER TABLE public.engine_maintenance_break DISABLE TRIGGER aa_serialize_maintenance_break_write' \
  >/dev/null
expect_refusal 'disabled trigger' 'maintenance-row serialization trigger is not canonical and enabled'
"${psql_cmd[@]}" -c \
  'ALTER TABLE public.engine_maintenance_break ENABLE TRIGGER aa_serialize_maintenance_break_write' \
  >/dev/null

"${psql_cmd[@]}" -c \
  'DROP TRIGGER aa_serialize_maintenance_break_write ON public.engine_maintenance_break' \
  >/dev/null
"${psql_cmd[@]}" -c \
  'CREATE TRIGGER aa_serialize_maintenance_break_write BEFORE INSERT ON public.engine_maintenance_break FOR EACH ROW EXECUTE FUNCTION public.fn_serialize_engine_maintenance_break_write()' \
  >/dev/null
expect_refusal 'wrong row trigger' 'maintenance-row serialization trigger is not canonical and enabled'

echo 'STAGE_ONE_FREEZE_AUTHORITY_PG17_PASS'
