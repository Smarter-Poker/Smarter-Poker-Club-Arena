#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  PROBE: the database refuses migrations inside the break window (PG17)
# ═══════════════════════════════════════════════════════════════════════════
#
# Applies supabase/migrations/20260910154446_the_database_refuses_migrations_
# inside_the_break_window.sql (and 20260910160841, which only rewrites the
# refusal's HINT) to a throwaway local PostgreSQL 17 cluster and
# drives the real event triggers through every case the guard decides:
# refusal, temporary objects, pg_cron, Supabase's own roles, PostgREST, the
# CLI login, DROP (sql_drop), the Supabase MCP's history-table bootstrap (run
# before list_migrations and apply_migration), the override (one transaction,
# one record, no switches, no forged marker, a session-level SET consumed)
# and fail-open.
#
# The window is a clock, so the probe replaces the window function with a
# fixed answer ("always inside" / "never inside") for the matrix - that is the
# only thing it stubs. The real function's boundaries are asserted by the
# migration's own DO block, which runs here unchanged.
#
# Nothing here touches production. Usage:
#   bash scripts/dev/probe-break-window-ddl-guard-pg17.sh
set -euo pipefail

# macOS: without a valid locale the postmaster refuses to start ("became
# multithreaded during startup").
export LC_ALL=C LANG=C

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration="${repo_dir}/supabase/migrations/20260910154446_the_database_refuses_migrations_inside_the_break_window.sql"
# The forward fix: the refusal's HINT cites CLAUDE.md rule 8 and explains the
# Supabase MCP's history-table bootstrap.
hint_fix="${repo_dir}/supabase/migrations/20260910160841_the_break_window_refusal_names_its_rule_and_explains_list_migrations.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" && -x /opt/homebrew/opt/postgresql@17/bin/initdb ]]; then
  pg17_bin=/opt/homebrew/opt/postgresql@17/bin
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi
for required in "$migration" "$hint_fix"; do
  [[ -f "$required" ]] || { echo "missing: $required" >&2; exit 1; }
done

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-break-window-ddl-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((39432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-break-window-ddl-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U supabase_admin --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null

# as ROLE APPNAME SQL  -> prints psql output (stdout+stderr), returns psql's status
as() {
  local role="$1" app="$2" sql="$3"
  PGAPPNAME="$app" "${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=default \
    -h "$socket_dir" -p "$port" -U "$role" -d postgres -c "$sql" 2>&1
}
admin() { as supabase_admin probe-admin "$1"; }
scalar() { PGAPPNAME=probe-admin "${pg17_bin}/psql" -X -qAt -h "$socket_dir" -p "$port" -U supabase_admin -d postgres -c "$1"; }

pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok   $*"; }

expect_refused() { # name role app sql [must-contain]
  local out
  if out="$(as "$2" "$3" "$4")"; then fail "$1: expected a refusal, got success: $out"; fi
  grep -q 'migration refused:' <<<"$out" || fail "$1: failed, but not with the guard's refusal: $out"
  if [[ -n "${5:-}" ]]; then grep -q -- "$5" <<<"$out" || fail "$1: refusal lacks '$5': $out"; fi
  ok "$1"
}
expect_allowed() { # name role app sql [must-contain]
  local out
  out="$(as "$2" "$3" "$4")" || fail "$1: expected success, got: $out"
  if [[ -n "${5:-}" ]]; then grep -q -- "$5" <<<"$out" || fail "$1: output lacks '$5': $out"; fi
  ok "$1"
}
expect_scalar() { # name sql expected
  local got
  got="$(scalar "$2")"
  [[ "$got" == "$3" ]] || fail "$1: expected '$3', got '$got'"
  ok "$1"
}

# ── The estate's roles, as production has them (2026-09-10) ────────────────
admin "
  CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE ROLE authenticator LOGIN NOINHERIT;
  GRANT anon, authenticated, service_role TO authenticator;
  CREATE ROLE cli_login_postgres LOGIN;
  GRANT postgres TO cli_login_postgres;
  CREATE ROLE supabase_auth_admin LOGIN;
  GRANT ALL ON SCHEMA public TO postgres, service_role;
  GRANT CREATE ON DATABASE postgres TO postgres;
  CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
  CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;
" >/dev/null

# ── Apply the migration exactly as written ─────────────────────────────────
PGAPPNAME=probe-admin "${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" \
  -U supabase_admin -d postgres -f "$migration" -f "$hint_fix" >/dev/null
ok 'both migrations apply, and their own assertions pass'
admin "
  ALTER FUNCTION public.fn_ca_break_window_ddl_guard() OWNER TO postgres;
  ALTER FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) OWNER TO postgres;
  ALTER FUNCTION public.fn_ca_break_window_governs(text, text) OWNER TO postgres;
  ALTER TABLE public.ca_break_window_migration_overrides OWNER TO postgres;
" >/dev/null

never_inside="CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations(p_at timestamptz)
  RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS \$p\$ SELECT NULL::text \$p\$"
always_inside="CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations(p_at timestamptz)
  RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS \$p\$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'HH24:MI:SS') || ' UTC is inside the hourly maintenance break window (probe)' \$p\$"

# What the Supabase MCP sends before list_migrations and apply_migration
# (postgres logs, 2026-09-10 15:58:04): five ALTERs that change nothing and
# still reload PostgREST.
mcp_history_bootstrap="begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;
alter table supabase_migrations.schema_migrations add column if not exists created_by text;
alter table supabase_migrations.schema_migrations add column if not exists idempotency_key text unique;
alter table supabase_migrations.schema_migrations add column if not exists rollback text[];
commit;"

# ── Fixtures, created while the window is stubbed shut ─────────────────────
admin "$never_inside" >/dev/null
expect_allowed "outside the window the MCP's history bootstrap runs" postgres mgmt-api "$mcp_history_bootstrap"
expect_allowed 'outside the window a migration session changes the schema freely' postgres mgmt-api "
  CREATE TABLE public.fixture(id int PRIMARY KEY, v int);
  CREATE TABLE public.to_drop(id int);
  CREATE FUNCTION public.fixture_fn() RETURNS int LANGUAGE sql AS 'select 1';
  CREATE MATERIALIZED VIEW public.fixture_mv AS SELECT 1 AS one;"

# ── Inside the window ──────────────────────────────────────────────────────
admin "$always_inside" >/dev/null

expect_refused 'CREATE TABLE from the management API is refused' postgres mgmt-api \
  'CREATE TABLE public.t_mgmt(id int);' 'Production DDL policy, rule 8 (the break window)'
expect_scalar '  ...and nothing of it was kept' "SELECT to_regclass('public.t_mgmt') IS NULL" t
echo "     what the agent sees:"
as postgres mgmt-api 'CREATE TABLE public.t_mgmt(id int);' | sed 's/^/       | /' || true

expect_refused 'a BEGIN/COMMIT migration is refused whole, DML included' postgres mgmt-api "
  BEGIN; INSERT INTO public.fixture VALUES (1, 1);
  CREATE OR REPLACE FUNCTION public.fixture_fn() RETURNS int LANGUAGE sql AS 'select 2'; COMMIT;"
expect_scalar '  ...the insert before the DDL rolled back with it' 'SELECT count(*) FROM public.fixture' 0
expect_scalar '  ...and the function kept its old body' 'SELECT public.fixture_fn()' 1

expect_refused 'psql is refused' postgres psql 'COMMENT ON TABLE public.fixture IS $$x$$;'
expect_refused 'the pooler (Supavisor) is refused' postgres Supavisor 'ALTER TABLE public.fixture ADD COLUMN w int;'
expect_refused 'an empty application_name is refused' postgres '' 'CREATE VIEW public.v AS SELECT 1 AS one;'
expect_refused 'the Supabase CLI login (cli_login_postgres) is refused' cli_login_postgres '' \
  'CREATE TABLE public.t_cli(id int);'
expect_refused 'CREATE INDEX (no reload, but a SHARE lock) is refused' postgres mgmt-api \
  'CREATE INDEX ON public.fixture (v);'
expect_refused 'GRANT is refused' postgres mgmt-api 'GRANT SELECT ON public.fixture TO anon;'
expect_refused 'DROP TABLE is refused through sql_drop' postgres mgmt-api 'DROP TABLE public.to_drop;'
expect_scalar '  ...and the table is still there' "SELECT to_regclass('public.to_drop') IS NOT NULL" t
expect_refused 'DROP FUNCTION is refused through sql_drop' postgres mgmt-api 'DROP FUNCTION public.fixture_fn();'
expect_refused 'a hand-run REFRESH MATERIALIZED VIEW is refused' postgres mgmt-api \
  'REFRESH MATERIALIZED VIEW public.fixture_mv;'
expect_refused "inside it the MCP's history bootstrap is refused, and told to read with execute_sql" postgres mgmt-api \
  "$mcp_history_bootstrap" 'SELECT version, name FROM supabase_migrations.schema_migrations'

expect_allowed 'temporary objects are always allowed (how probes work)' postgres mgmt-api "
  BEGIN; CREATE TEMP TABLE tt(id int); CREATE INDEX ON tt(id); ALTER TABLE tt ADD COLUMN v int;
  CREATE FUNCTION pg_temp.tf() RETURNS int LANGUAGE sql AS 'select 1'; DROP TABLE tt; COMMIT;"
expect_allowed 'pg_cron is never refused' postgres pg_cron 'REFRESH MATERIALIZED VIEW public.fixture_mv;'
expect_allowed '  ...not even for a table' postgres pg_cron 'CREATE TABLE public.t_cron(id int); DROP TABLE public.t_cron;'
expect_allowed "Supabase's own roles are never refused" supabase_auth_admin gotrue \
  'CREATE TABLE auth.t_auth(id int); DROP TABLE auth.t_auth;'
expect_allowed 'the superuser is never refused' supabase_admin mgmt-api 'CREATE TABLE public.t_su(id int); DROP TABLE public.t_su;'
expect_allowed 'PostgREST (authenticator -> service_role) is never refused' authenticator 'PostgREST 12' \
  'SET ROLE service_role; CREATE TABLE public.t_api(id int); DROP TABLE public.t_api;'
expect_allowed 'plain DML is not DDL' postgres mgmt-api 'INSERT INTO public.fixture VALUES (9, 9); DELETE FROM public.fixture WHERE id = 9;'

# The override
expect_allowed 'an override with a reason is honoured for its whole transaction' postgres mgmt-api "
  BEGIN; SET LOCAL ca.break_window_migration_override = 'probe: emergency fix';
  CREATE TABLE public.t_ovr(id int); CREATE INDEX ON public.t_ovr(id);
  COMMENT ON TABLE public.t_ovr IS 'x'; DROP TABLE public.to_drop; COMMIT;" 'break window override'
expect_scalar '  ...and recorded once, with its reason' \
  "SELECT count(*) || ':' || min(reason) || ':' || min(session_role) || ':' || min(application_name) FROM public.ca_break_window_migration_overrides" \
  '1:probe: emergency fix:postgres:mgmt-api'
expect_scalar '  ...and what it applied was kept' "SELECT to_regclass('public.t_ovr') IS NOT NULL AND to_regclass('public.to_drop') IS NULL" t

expect_refused 'the override does not outlive its transaction' postgres mgmt-api "
  BEGIN; SET LOCAL ca.break_window_migration_override = 'probe: first'; CREATE TABLE public.t_a(id int); COMMIT;
  CREATE TABLE public.t_b(id int);"
expect_scalar "  ...the transaction that set it kept its work, the next one kept nothing" \
  "SELECT (to_regclass('public.t_a') IS NOT NULL)::text || '/' || (to_regclass('public.t_b') IS NOT NULL)::text" 'true/false'
expect_refused 'a switch is not a reason' postgres mgmt-api "
  BEGIN; SET LOCAL ca.break_window_migration_override = 'on'; CREATE TABLE public.t_sw(id int); COMMIT;" 'a switch, not a reason'
expect_refused 'a blank reason is not a reason' postgres mgmt-api "
  BEGIN; SET LOCAL ca.break_window_migration_override = '   '; CREATE TABLE public.t_blank(id int); COMMIT;"
expect_refused 'the in-force marker cannot be typed in' postgres mgmt-api "
  BEGIN; SET LOCAL ca.break_window_override_in_force = '12345'; CREATE TABLE public.t_forged(id int); COMMIT;"

session_out="$(PGAPPNAME=psql "${pg17_bin}/psql" -X -q -h "$socket_dir" -p "$port" -U postgres -d postgres 2>&1 <<'SQL' || true
SET ca.break_window_migration_override = 'probe: session-level reason';
BEGIN; CREATE TABLE public.t_session_1(id int); COMMIT;
BEGIN; CREATE TABLE public.t_session_2(id int); COMMIT;
SQL
)"
expect_scalar 'a session-level override is consumed by the first transaction that uses it' \
  "SELECT (to_regclass('public.t_session_1') IS NOT NULL)::text || '/' || (to_regclass('public.t_session_2') IS NOT NULL)::text" 'true/false'
grep -q 'migration refused:' <<<"$session_out" || fail "the second session transaction was not refused by the guard: $session_out"
expect_scalar '  ...and every honoured transaction left exactly one row' \
  'SELECT count(*) FROM public.ca_break_window_migration_overrides' 3

# Fail open on the guard's own defect
admin "CREATE OR REPLACE FUNCTION public.fn_ca_break_window_governs(p_session_role text, p_application text) RETURNS boolean
  LANGUAGE plpgsql AS \$p\$ BEGIN RAISE EXCEPTION 'probe: a broken helper'; END \$p\$" >/dev/null
expect_allowed 'a defect inside the guard fails open, loudly' postgres mgmt-api \
  'CREATE TABLE public.t_open(id int);' 'could not decide'

# ── The real window again: behaviour matches the clock ─────────────────────
awk '/^CREATE OR REPLACE FUNCTION public.fn_ca_break_window_governs\(/ { c = 1 } c { print } c && /^\$fn\$;$/ { exit }' \
  "$migration" >"${probe_root}/governs.sql"
awk '/^CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations\(/ { c = 1 } c { print } c && /^\$fn\$;$/ { exit }' \
  "$migration" >"${probe_root}/window.sql"
PGAPPNAME=probe-admin "${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -U supabase_admin -d postgres \
  -f "${probe_root}/governs.sql" -f "${probe_root}/window.sql" >/dev/null
if [[ "$(scalar 'SELECT public.fn_ca_break_window_refuses_migrations(clock_timestamp()) IS NULL')" == t ]]; then
  expect_allowed "the real window: $(date -u +%H:%M) UTC is outside it, so DDL is allowed" postgres mgmt-api 'CREATE TABLE public.t_now(id int);'
else
  expect_refused "the real window: $(date -u +%H:%M) UTC is inside it, so DDL is refused" postgres mgmt-api 'CREATE TABLE public.t_now(id int);'
fi

echo "all ${pass} checks passed"
