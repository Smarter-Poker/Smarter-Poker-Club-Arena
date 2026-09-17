#!/usr/bin/env python3
"""Direct finite PG17 qualification. Private socket and disposable database only."""
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20260917190616_protect_event_owned_engine_recovery_windows_from_ddl.sql'


def function(path, name):
    source = (ROOT / path).read_text()
    match = re.search(r'CREATE(?: OR REPLACE)? FUNCTION public\.' + name +
                      r'\b.*?\bAS (\$\w*\$).*?\1\s*;', source, re.S | re.I)
    if not match:
        raise RuntimeError('missing actual SQL component: ' + name)
    return match[0]


def run(command, **kwargs):
    result = subprocess.run(command, text=True, capture_output=True, timeout=30, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


with tempfile.TemporaryDirectory(prefix='engine-recovery-pg-') as directory:
    task = Path(directory)
    data = task / 'data'
    sock = task / 'socket'
    sock.mkdir()
    env = {**os.environ, 'PGHOST': str(sock), 'PGPORT': '5432', 'PGDATABASE': 'postgres',
           'PGUSER': 'fixture_owner', 'PGCONNECT_TIMEOUT': '3', 'PGOPTIONS': '-c statement_timeout=10000'}
    run([str(PG / 'initdb'), '-D', str(data), '-U', 'fixture_owner', '-A', 'trust', '--no-locale'])
    started = False
    holder = None
    try:
        run([str(PG / 'pg_ctl'), '-D', str(data), '-l', str(task / 'postgres.log'),
             '-o', f"-F -k {sock} -c listen_addresses=''", '-w', 'start'])
        started = True
        def sql(text, role='fixture_owner', error=None):
            result = subprocess.run([str(PG / 'psql'), '-XAt', '-v', 'ON_ERROR_STOP=1'],
                                    input=text, text=True, capture_output=True,
                                    env={**env, 'PGUSER': role}, timeout=15)
            if error:
                assert result.returncode != 0 and error in result.stderr, result
            else:
                assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        sql("""
          CREATE ROLE postgres LOGIN; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
          GRANT CREATE, USAGE ON SCHEMA public TO postgres;
          CREATE SCHEMA auth;
          CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT null::text $$;
          CREATE TABLE public.engine_maintenance_break(enforce_freeze boolean, phase text,
            announced_at timestamptz, break_started_at timestamptz, break_ends_at timestamptz);
          CREATE TABLE public.engine_maintenance_thaws(contract_version integer, release_target_at timestamptz, shifted jsonb);
          CREATE TABLE public.ca_break_window_migration_overrides(txid bigint, reason text,
            session_role text, application_name text, first_command text, query_snippet text);
        """)
        sql(function('supabase/migrations/20260910054638_tables_policy_hashed_auth_admin_trusted_and_unfilled_spins_e.sql', 'fn_active_maintenance_release_boundary'))
        sql((ROOT / 'scripts/ci/fixtures/engine-recovery-entry-freeze.sql').read_text())
        baseline = 'supabase/migrations/20260910154446_the_database_refuses_migrations_inside_the_break_window.sql'
        sql(function(baseline, 'fn_ca_break_window_refuses_migrations'))
        sql(function(baseline, 'fn_ca_break_window_governs'))
        sql("INSERT INTO public.engine_maintenance_break VALUES(true,'last_hand',clock_timestamp(),null,null)")
        # Demonstrate the actual gap before installing the candidate.
        assert sql("SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:30Z') IS NULL") == 't'
        sql(function('supabase/migrations/20260910164655_stage_b_break_window_bootstrap_compatibility.sql', 'fn_ca_stage_b_ledger_bootstrap_allowed'))
        sql(function('supabase/migrations/20260910164655_stage_b_break_window_bootstrap_compatibility.sql', 'fn_ca_break_window_ddl_guard'))
        sql(MIGRATION.read_text())
        sql("""CREATE EVENT TRIGGER ca_break_window_refuses_ddl ON ddl_command_end EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();
               CREATE EVENT TRIGGER ca_break_window_refuses_drops ON sql_drop EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();""")
        assert sql("SELECT public.fn_engine_recovery_window_contract()") == 'engine-recovery-window-v1'
        assert sql("SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:30Z') IS NOT NULL") == 't'
        for minute in ('00', '02', '50', '53', '59'):
            assert sql(f"SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:{minute}Z') IS NOT NULL") == 't'
        sql('CREATE TABLE must_not_exist(id int)', role='postgres', error='migration refused')
        assert sql("SELECT to_regclass('public.must_not_exist') IS NULL") == 't'
        sql('CREATE TEMP TABLE permitted_temp(id int)', role='postgres')
        sql("BEGIN; SET LOCAL ca.break_window_migration_override='qualify explicit recovery override'; CREATE TABLE explicit_override(id int); COMMIT", role='postgres')
        assert sql('SELECT count(*) FROM ca_break_window_migration_overrides') == '1'
        sql('DROP TABLE explicit_override', role='postgres', error='migration refused')
        sql("SET ROLE authenticated; SELECT public.fn_engine_recovery_window_contract()", error='permission denied')
        sql("SET ROLE anon; SELECT public.fn_engine_recovery_window_contract()", error='permission denied')
        assert sql("SET ROLE service_role; SELECT public.fn_engine_recovery_window_contract()").endswith('engine-recovery-window-v1')
        sql("UPDATE engine_maintenance_break SET phase='counting_down', announced_at=clock_timestamp()-interval '3 minutes', break_started_at=clock_timestamp()-interval '1 minute', break_ends_at=clock_timestamp()+interval '4 minutes'")
        assert sql("SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:30Z') IS NOT NULL") == 't'
        sql('DELETE FROM engine_maintenance_break')
        assert sql("SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:30Z') IS NULL") == 't'
        steps = "'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots'"
        sql("INSERT INTO engine_maintenance_thaws SELECT 3,clock_timestamp()+interval '2 minutes',jsonb_object_agg(s,true)||'{\"complete\":true}'::jsonb FROM unnest(ARRAY["+steps+"]) s")
        assert sql("SELECT public.fn_ca_break_window_refuses_migrations('2026-09-17 12:30Z') IS NOT NULL") == 't'
        sql('DELETE FROM engine_maintenance_thaws')
        # The real exclusive announcement lock excludes governed DDL even
        # when the durable row is not yet committed and cannot be read.
        holder = subprocess.Popen([str(PG / 'psql'), '-XAt', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(530090,1); SELECT 'ready';\n")
        holder.stdin.flush()
        while holder.stdout.readline().strip() != 'ready':
            if holder.poll() is not None: raise RuntimeError('announcement lock holder exited')
        sql('CREATE TABLE blocked_by_announcement(id int)', role='postgres', error='announcement owns the DDL boundary')
        holder.communicate('ROLLBACK;\n', timeout=5)
        assert holder.returncode == 0
        holder = None
        sql('ALTER EVENT TRIGGER ca_break_window_refuses_drops DISABLE')
        assert sql('SELECT public.fn_engine_recovery_window_contract() IS NULL') == 't'
        print('PASS: old gap reproduced; announcement/countdown/thaw, DDL rollback, role ACLs, explicit override, concurrent owner lock and capability drift verified on PostgreSQL 17')
    finally:
        if holder is not None:
            holder.kill()
            holder.communicate(timeout=5)
        if started:
            run([str(PG / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'])
