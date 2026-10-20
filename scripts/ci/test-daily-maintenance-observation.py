#!/usr/bin/env python3
"""Run the actual schedule-observer migration on isolated PostgreSQL, never production."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
MIGRATION = next((ROOT / 'supabase/migrations').glob('*_daily_chicago_maintenance_observation.sql'))

def function(source, name):
    a = source.index('CREATE OR REPLACE FUNCTION public.' + name + '(')
    b = source.index('END $function$;', a) + len('END $function$;')
    return source[a:b]

with tempfile.TemporaryDirectory(prefix='daily-pg-') as tmp:
    temp = Path(tmp)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    def run(args, **kwargs):
        return subprocess.run([str(x) for x in args], text=True, capture_output=True, timeout=45, **kwargs)
    def sql(source, ok=True):
        result = run([PG/'psql', '-X', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], input=source)
        if ok and result.returncode: raise AssertionError(result.stderr)
        return result
    result = run([PG/'initdb', '-D', temp/'data', '-A', 'trust', '-U', 'postgres', '--no-locale'])
    assert result.returncode == 0, result.stderr
    result = run([PG/'pg_ctl', '-D', temp/'data', '-l', temp/'log', '-o', f"-h 127.0.0.1 -p {port} -k ''", '-w', 'start'])
    assert result.returncode == 0, result.stderr
    try:
        first = (ROOT/'supabase/migrations/20260902203100_engine_restart_phase1_scorecard_freezeproof_dispatcher.sql').read_text()
        table = first[first.index('CREATE TABLE IF NOT EXISTS public.ca_break_scorecards'):first.index('COMMENT ON TABLE public.ca_break_scorecards')]
        original = function((ROOT/'supabase/migrations/20260910132747_the_break_scorecard_names_why_a_break_never_started.sql').read_text(), 'fn_ca_record_break_scorecard')
        sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE engine_maintenance_break_log(break_started_at timestamptz, break_ended_at timestamptz, unparked_at_countdown int, peak_unparked int, ready_for_restart_at timestamptz, recorded_at timestamptz default now());
CREATE TABLE engine_maintenance_break_faults(announced_at timestamptz, stage text, outcome text, error text, recorded_at timestamptz);
CREATE TABLE hand_history(created_at timestamptz, table_id uuid);
CREATE TABLE engine_maintenance_thaws(freeze_started_at timestamptz, frozen_seconds numeric, thawed_at timestamptz);
CREATE TABLE engine_recovery_events(event text, event_class text, created_at timestamptz);
CREATE TABLE tables(id uuid, status text);
CREATE TABLE ca_engine_deploy_attempts(at timestamptz, target_sha text, shipped bool);
CREATE TABLE ca_freeze_circulation_marks(window_hour timestamptz, kind text, total numeric);
''' + table + '''
ALTER TABLE ca_break_scorecards ADD COLUMN unparked_at_countdown int, ADD COLUMN peak_unparked int, ADD COLUMN ready_for_restart_at timestamptz, ADD COLUMN gate_opened bool;
CREATE FUNCTION fn_ca_break_scorecard_push(ca_break_scorecards) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
''' + original)
        # Reproduce the old defect without games or money: no break was due,
        # but the old default still writes a failed global-maintenance card.
        assert sql("SELECT (fn_ca_record_break_scorecard()).verdict").stdout.strip() == 'fail'
        sql('TRUNCATE ca_break_scorecards;')
        sql(MIGRATION.read_text())
        source = MIGRATION.read_text()
        selection = source.split('-- DAILY_OBSERVATION_SELECTION_BEGIN')[1].split('-- DAILY_OBSERVATION_SELECTION_END')[0]
        selection = selection.replace('v_observed_at', 'p_at').replace(' INTO v_end', '')
        fixture_sql = 'CREATE FUNCTION pg_temp.expected_end(p_at timestamptz) RETURNS timestamptz LANGUAGE sql AS $select$' + selection + '$select$;'
        replay = sql(MIGRATION.read_text(), ok=False)
        assert replay.returncode != 0 and 'preimage changed' in replay.stderr
        sql(fixture_sql + '''DO $test$ BEGIN
  IF pg_temp.expected_end('2026-10-20 17:12Z') IS NOT NULL THEN RAISE EXCEPTION 'ordinary hour invented a break'; END IF;
  IF pg_temp.expected_end('2026-10-20 09:12Z') <> '2026-10-20 09:05Z'::timestamptz THEN RAISE EXCEPTION 'CDT boundary'; END IF;
  IF pg_temp.expected_end('2026-11-01 10:12Z') <> '2026-11-01 10:05Z'::timestamptz THEN RAISE EXCEPTION 'CST boundary'; END IF;
  IF pg_temp.expected_end('2026-03-08 09:12Z') <> '2026-03-08 09:05Z'::timestamptz THEN RAISE EXCEPTION 'spring boundary'; END IF;
  IF pg_temp.expected_end('2026-10-20 09:04:59Z') IS NOT NULL THEN RAISE EXCEPTION 'premature observation'; END IF;
  IF pg_temp.expected_end('2026-10-20 10:05Z') IS NOT NULL THEN RAISE EXCEPTION 'expired expectation'; END IF;
END $test$;
INSERT INTO engine_maintenance_break_log VALUES ('2026-10-20 17:25:30Z','2026-10-20 17:30:31Z',0,0,'2026-10-20 17:25:35Z',now());
DO $test$ BEGIN
  IF pg_temp.expected_end('2026-10-20 18:12Z') <> '2026-10-20 17:30:30Z'::timestamptz THEN RAISE EXCEPTION 'emergency omitted'; END IF;
  IF pg_temp.expected_end('2026-10-20 18:31Z') IS NOT NULL THEN RAISE EXCEPTION 'old emergency replayed'; END IF;
END $test$;
TRUNCATE engine_maintenance_break_log;
''')
        # Explicit scheduled missing-break evidence still fails; only no-break-
        # due returns NULL and leaves no phantom result.
        assert sql("SELECT (fn_ca_record_break_scorecard('2026-10-20 09:05Z')).verdict").stdout.strip() == 'fail'
        print('PASS: fail-before, exact migration, daily/DST/emergency boundaries, missing-break failure and replay refusal')
    finally:
        result = run([PG/'pg_ctl', '-D', temp/'data', '-m', 'immediate', '-w', 'stop'])
        assert result.returncode == 0, result.stderr
