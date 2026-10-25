#!/usr/bin/env python3
"""Qualify exact digest function transition on disposable PostgreSQL 17."""
import json, os, pathlib, socket, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[2]
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent:
    raise RuntimeError('Set TMPDIR to owned SSD scratch or provider runner temp')
if os.uname().sysname == 'Darwin' and not parent.startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('Mac fixture storage must be on SmarterWork')
migration = root/'supabase/migrations/20261025143717_digest_counts_original_alerts_rather_than_source_updates.sql'
with tempfile.TemporaryDirectory(prefix='digest-original-', dir=parent) as folder:
    scratch = pathlib.Path(folder)
    def run(tool, *args, input=None, check=True):
        result = subprocess.run([str(pg/tool), *args], input=input, text=True,
                                capture_output=True, timeout=90)
        if check and result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result
    run('initdb', '-D', str(scratch/'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0)); port = str(reserve.getsockname()[1])
    run('pg_ctl', '-D', str(scratch/'data'), '-l', str(scratch/'server.log'),
        '-o', f'-k {parent} -p {port} -h 127.0.0.1', 'start')
    try:
        def sql(source, check=True):
            return run('psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                       '-h', '127.0.0.1', '-p', port, '-d', 'postgres', input=source, check=check)
        sql('''CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE sp_daily_metrics(day date,metrics jsonb);
CREATE TABLE sp_daily_digest_runs(day date,status text);
CREATE TABLE ca_drift_incidents(resolved_at timestamptz,deadline_at timestamptz);
CREATE TABLE tournaments(id uuid,name text,tournament_type text,status text,started_at timestamptz);
CREATE TABLE cashout_requests(completed_at timestamptz,cancelled_at timestamptz,status text,created_at timestamptz);
CREATE TABLE settlement_invoices(invoice_type text,created_at timestamptz,message_sent boolean);
CREATE TABLE wheel_configs(enabled boolean,exposure_allowance_chips numeric);
CREATE TABLE diamond_game_configs(enabled boolean,exposure_allowance_chips numeric);
CREATE FUNCTION fn_sp_setting(text,numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT $2 $$;
CREATE FUNCTION fn_diamond_spins_allowance_floor() RETURNS numeric LANGUAGE sql AS $$ SELECT 2500 $$;
CREATE TABLE operational_alert_events(id bigint,alertname text,severity text,received_at timestamptz,
 investigation_status text,payload jsonb);
INSERT INTO operational_alert_events
 SELECT n,'Refusal','critical','2026-10-24 12:00Z','new',jsonb_build_object('snapshot_kind','insert') FROM generate_series(1,6) n;
INSERT INTO operational_alert_events
 SELECT n+10,'Refusal','critical','2026-10-24 12:10Z','new',jsonb_build_object('snapshot_kind','update_new','original_event',jsonb_build_object('resolved',true)) FROM generate_series(1,6) n;
INSERT INTO operational_alert_events
 SELECT n+20,'Refusal','critical','2026-10-23 12:00Z','new',jsonb_build_object('snapshot_kind','insert') FROM generate_series(1,3) n;
INSERT INTO operational_alert_events
 SELECT n+30,'Refusal','critical','2026-10-23 12:10Z','new',jsonb_build_object('snapshot_kind','update_new') FROM generate_series(1,3) n;
''')
        sql((root/'tests/fixtures/digest-alert-count-preimages.sql').read_text())
        for sig in ['fn_sp_daily_metrics_compute(date)', 'fn_sp_digest_attention(date,jsonb)']:
            sql(f'REVOKE ALL ON FUNCTION {sig} FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION {sig} TO service_role;')
        before = sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_daily_metrics_compute','fn_sp_digest_attention');").stdout
        def count_query(candidate):
            predicate = "AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'" if candidate else ''
            return f"SELECT count(*) FROM operational_alert_events WHERE received_at >= '2026-10-24 05:00Z' AND received_at < '2026-10-25 05:00Z' AND investigation_status IS DISTINCT FROM 'informational' AND severity='critical' {predicate};"
        assert sql(count_query(False)).stdout.strip() == '12', 'must reproduce double counting'
        old = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":12}}}');").stdout)
        assert any('(12, 6 the day before)' in x['title'] for x in old)
        sql(migration.read_text())
        assert sql(count_query(True)).stdout.strip() == '6', 'six incidents, irrespective of resolution updates'
        new = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":6}}}');").stdout)
        assert not any(x['rule'] == 'critical_alert_rising' for x in new), new
        # Six incidents are below the unchanged ten-event rising threshold.
        comparison = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":12}}}');").stdout)
        assert any('(12, 3 the day before)' in x['title'] for x in comparison), comparison
        definition = sql("SELECT pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure);").stdout
        assert definition.count("payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'") == 3
        assert before == sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_daily_metrics_compute','fn_sp_digest_attention');").stdout
        # Legacy direct alerts without snapshot metadata remain counted; informational
        # source rows do not. An update-only observation is never a new failure.
        sql("INSERT INTO operational_alert_events VALUES (100,'Direct','critical','2026-10-24 13:00Z','new','{}'),(101,'Info','critical','2026-10-24 13:00Z','informational','{}'),(102,'OldResolved','critical','2026-10-24 13:00Z','new','{\"snapshot_kind\":\"update_new\"}');")
        assert sql(count_query(True)).stdout.strip() == '7'
        repeated = sql(migration.read_text(), check=False)
        assert repeated.returncode and 'DIGEST_ALERT_PREIMAGE_DRIFT' in repeated.stderr
        print('PASS: 12-to-6 baseline, unchanged ten-event threshold and actual prior-day count 3, all metric consumers, direct/optional metadata, informational/update-only exclusion, unchanged ACL/owner/settings, replay refusal')
    finally:
        run('pg_ctl', '-D', str(scratch/'data'), '-m', 'immediate', 'stop')
