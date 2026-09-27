#!/usr/bin/env python3
"""The rakeback settler reads only what every writer has committed (20260927144455).

Runs the exact migration on a disposable socket-only PostgreSQL cluster and
proves, with real concurrent transactions rather than a mock:

1. the defect: a writer that started first and commits last is invisible to a
   page that already sees a later-stamped committed row, so a cursor saved at
   that page passes it (the 51 stranded cash sources of 2026-09-26/27);
2. the fix: the horizon is at least the margin before the oldest open
   transaction in this database, so the same page bounded by it cannot pass
   the in-flight row, and after the writer commits the row is read in order;
3. a transaction open in ANOTHER database does not hold the horizon;
4. a prepared transaction withholds the horizon, and the migration refuses to
   install while max_prepared_transactions is not 0;
5. the net: fn_rakeback_settler_stranded_source_check records exactly the
   positive cash rows below the cursor that were never submitted into
   operational_alert_events with payload.target_task_id (deduplicated), and a
   held horizon names the transaction that holds it.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TASK = '01a09b86-5ba8-7290-8657-1041f13dd3ca'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
cluster = Path(tempfile.mkdtemp(prefix='ca-horizon-', dir=args.scratch))
data = cluster / 'data'
socket = Path(tempfile.mkdtemp(prefix='ca-hz-', dir=tempfile.gettempdir()))
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
migrations = list((ROOT / 'supabase/migrations').glob('20260927144455_*.sql'))
assert len(migrations) == 1, migrations
migration = migrations[0].read_text()
started = False
sessions = []


def run(argv, sql=None, refusal=None, extra_env=None):
    result = subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True,
                            env={**env, **(extra_env or {})}, timeout=60)
    if refusal:
        assert result.returncode != 0 and refusal in result.stderr, result.stderr + result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def psql_argv(db='postgres'):
    return [pg / 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket, '-U', 'postgres',
            '-d', db, '-p', '5432']


def query(sql, refusal=None, db='postgres'):
    return run(psql_argv(db), sql, refusal)


def open_session(name, sql, db='postgres'):
    """A psql session left open inside a transaction until finish() is called."""
    p = subprocess.Popen([str(x) for x in psql_argv(db)], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         env={**env, 'PGAPPNAME': name})
    p.stdin.write(sql + '\n')
    p.stdin.flush()
    sessions.append(p)
    for _ in range(200):
        if query(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' "
                 "AND state='idle in transaction';") == '1':
            return p
        time.sleep(0.05)
    raise RuntimeError(f'session {name} never became idle in transaction')


def finish(p, sql='COMMIT;'):
    p.stdin.write(sql + '\n\\q\n')
    p.stdin.flush()
    out, err = p.communicate(timeout=30)
    assert p.returncode == 0, err
    sessions.remove(p)


def ts(sql):
    return query(f"SELECT extract(epoch FROM ({sql}))::numeric(20,6);")


FIXTURE = r'''
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command)
  ON CONFLICT(jobname) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING jobid $$;
CREATE TABLE public.rake_records(
  id uuid PRIMARY KEY, club_id uuid, rake_amount numeric NOT NULL, is_tournament boolean,
  tournament_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_rake_records_date ON public.rake_records(created_at);
CREATE TABLE public.daemon_state(daemon text PRIMARY KEY, high_water_mark timestamptz,
  high_water_mark_id uuid, updated_at timestamptz DEFAULT now());
INSERT INTO public.daemon_state(daemon) VALUES ('rakeback_settler');
CREATE TABLE public.accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY);
CREATE TABLE public.accounting_cash_rake_sources(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, rake_record_id uuid);
CREATE TABLE public.accounting_cash_source_receipts(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, rake_record_id uuid);
CREATE TABLE public.accounting_cash_source_work(rake_record_id uuid PRIMARY KEY);
CREATE TABLE public.operational_alert_events(
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 512),
  alertname text NOT NULL CHECK (length(alertname) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('firing','resolved','info')),
  severity text NOT NULL CHECK (length(severity) BETWEEN 1 AND 40),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text) <= 262144),
  received_at timestamptz DEFAULT clock_timestamp(), last_received_at timestamptz DEFAULT clock_timestamp(),
  delivery_count bigint DEFAULT 1, investigation_status text DEFAULT 'new', investigation jsonb DEFAULT '{}',
  UNIQUE (source, event_key));
-- Production body of public.fn_record_operational_alert, 2026-09-27.
CREATE FUNCTION public.fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,
  p_status text,p_severity text,p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
'''


def horizon():
    return json.loads(query('SELECT public.fn_rakeback_settler_read_horizon();'))


def page(cursor, bound=None):
    """The settler's later page: (created_at, id) after the cursor, optionally below the horizon."""
    below = f" AND created_at < '{bound}'::timestamptz" if bound else ''
    out = query("SELECT coalesce(string_agg(id::text, ',' ORDER BY created_at, id), '') FROM public.rake_records "
                f"WHERE rake_amount > 0 AND created_at > '{cursor}'::timestamptz{below};")
    return [x for x in out.split(',') if x]


def uid(n):
    return f'00000000-0000-4000-8000-{n:012d}'


try:
    version = run([pg / 'postgres', '--version'])
    assert int(version.split()[-1].split('.')[0]) >= 16, version
    run([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
         '--no-locale', '--encoding=UTF8'])
    with (data / 'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([pg / 'pg_ctl', '-D', data, '-l', cluster / 'server.log', '-w', 'start'])
    query(FIXTURE)

    # ── Before the migration: the defect, with real transactions ──────────────
    cursor0 = query("SELECT now() - interval '1 hour';")
    late = open_session('late-writer', f"BEGIN; INSERT INTO public.rake_records(id, rake_amount) VALUES ('{uid(1)}', 1);")
    time.sleep(0.3)
    query(f"INSERT INTO public.rake_records(id, rake_amount) VALUES ('{uid(2)}', 1);")
    unbounded = page(cursor0)
    assert unbounded == [uid(2)], unbounded  # the page sees the later row, not the earlier writer
    # A cursor saved at that page is past the late writer's stamp once it commits:
    passed_at = query(f"SELECT created_at FROM public.rake_records WHERE id='{uid(2)}';")
    finish(late)
    assert page(passed_at) == [], 'the late row is behind the saved cursor and no page reaches it'
    assert query(f"SELECT (SELECT created_at FROM public.rake_records WHERE id='{uid(1)}') < '{passed_at}'::timestamptz;") == 't'
    query('TRUNCATE public.rake_records;')

    # ── The migration installs once, exactly, and refuses a second time ───────
    query(migration)
    query(migration, 'STRANDED_CHECK_ALREADY_SCHEDULED')
    assert query("SELECT count(*) FROM cron.job WHERE jobname='rakeback-settler-stranded-source-check-hourly' "
                 "AND schedule='28 * * * *';") == '1'
    for fn in ('fn_rakeback_settler_read_horizon()', 'fn_rakeback_settler_stranded_source_check()'):
        assert query(f"SELECT has_function_privilege('anon','public.{fn}','EXECUTE') OR "
                     f"has_function_privilege('authenticated','public.{fn}','EXECUTE');") == 'f', fn
        assert query(f"SELECT has_function_privilege('service_role','public.{fn}','EXECUTE');") == 't', fn

    # ── After: the same race cannot pass the in-flight row ─────────────────────
    idle = horizon()
    assert idle['margin_seconds'] == 60 and idle['oldest_pid'] is None, idle
    assert float(ts(f"'{idle['read_at']}'::timestamptz - '{idle['horizon']}'::timestamptz")) == 60.0, idle

    cursor0 = query("SELECT now() - interval '1 hour';")
    late = open_session('late-writer', f"BEGIN; INSERT INTO public.rake_records(id, rake_amount, created_at) "
                                        f"VALUES ('{uid(11)}', 1, DEFAULT);")
    started_at = query("SELECT xact_start FROM pg_stat_activity WHERE application_name='late-writer';")
    time.sleep(0.3)
    query(f"INSERT INTO public.rake_records(id, rake_amount) VALUES ('{uid(12)}', 1);")
    h = horizon()
    assert h['oldest_application'] == 'late-writer' and h['oldest_state'] == 'idle in transaction', h
    assert float(ts(f"'{started_at}'::timestamptz - '{h['horizon']}'::timestamptz")) == 60.0, (started_at, h)
    assert page(cursor0, h['horizon']) == [], 'nothing below the horizon may be read past an open writer'
    finish(late)
    # To make the committed rows readable without waiting a real minute, move
    # them back in time together; their relative order is what matters.
    query("UPDATE public.rake_records SET created_at = created_at - interval '5 minutes';")
    h = horizon()
    assert page(cursor0, h['horizon']) == [uid(11), uid(12)], 'after the commit both rows are read in stamp order'

    # ── A transaction in another database does not hold the horizon ──────────
    query('CREATE DATABASE other_db;')
    other = open_session('other-db', 'BEGIN; SELECT 1;', db='other_db')
    other_start = query("SELECT xact_start FROM pg_stat_activity WHERE application_name='other-db';")
    time.sleep(1.2)
    h = horizon()
    assert h['oldest_pid'] is None, h
    assert float(ts(f"'{h['horizon']}'::timestamptz - ('{other_start}'::timestamptz - interval '60 seconds')")) > 1.0, h
    finish(other, 'ROLLBACK;')

    # ── The net: exactly the never-submitted positive cash rows below the cursor ─
    query('TRUNCATE public.rake_records;')
    query(f"""
UPDATE public.daemon_state SET high_water_mark = now() - interval '10 minutes', high_water_mark_id = '{uid(99)}'
 WHERE daemon = 'rakeback_settler';
INSERT INTO public.rake_records(id, rake_amount, is_tournament, tournament_id, created_at) VALUES
 ('{uid(21)}', 5, false, NULL, now() - interval '30 minutes'),    -- accrued
 ('{uid(22)}', 5, false, NULL, now() - interval '31 minutes'),    -- refused, receipt kept
 ('{uid(23)}', 5, NULL,  NULL, now() - interval '32 minutes'),    -- retry work
 ('{uid(24)}', 5, false, NULL, now() - interval '33 minutes'),    -- earning source only
 ('{uid(25)}', 5, false, NULL, now() - interval '34 minutes'),    -- STRANDED
 ('{uid(26)}', 5, NULL,  NULL, now() - interval '3 hours'),       -- STRANDED (is_tournament NULL is cash)
 ('{uid(27)}', 5, true,  NULL, now() - interval '35 minutes'),    -- tournament: terminal writer owns it
 ('{uid(28)}', 5, false, '{uid(900)}', now() - interval '36 minutes'), -- tournament id: same
 ('{uid(29)}', 0, false, NULL, now() - interval '37 minutes'),    -- no rake: nothing to accrue
 ('{uid(30)}', 5, false, NULL, now() - interval '1 minute'),      -- above the cursor: not read yet
 ('{uid(31)}', 5, false, NULL, now() - interval '5 hours');       -- outside the 4-hour window
INSERT INTO public.accounting_cash_accrual_batches VALUES ('{uid(21)}');
INSERT INTO public.accounting_cash_source_receipts(rake_record_id) VALUES ('{uid(22)}');
INSERT INTO public.accounting_cash_source_work VALUES ('{uid(23)}');
INSERT INTO public.accounting_cash_rake_sources(rake_record_id) VALUES ('{uid(24)}');
""")
    first = json.loads(query('SELECT public.fn_rakeback_settler_stranded_source_check();'))
    assert first['checked'] is True and first['stranded'] == 2, first
    rows = json.loads(query(
        "SELECT json_agg(json_build_object('key',event_key,'name',alertname,'status',status,'sev',severity,"
        "'task',payload->>'target_task_id','record',payload->>'rake_record_id','n',delivery_count) ORDER BY event_key) "
        "FROM public.operational_alert_events WHERE source='rakeback-settler-stranded-sources';"))
    assert rows == [
        {'key': uid(25), 'name': 'rakeback_settler_stranded_cash_source', 'status': 'firing', 'sev': 'critical',
         'task': TASK, 'record': uid(25), 'n': 1},
        {'key': uid(26), 'name': 'rakeback_settler_stranded_cash_source', 'status': 'firing', 'sev': 'critical',
         'task': TASK, 'record': uid(26), 'n': 1},
    ], rows
    again = json.loads(query('SELECT public.fn_rakeback_settler_stranded_source_check();'))
    assert again['stranded'] == 2, again
    assert query("SELECT string_agg(delivery_count::text, ',' ORDER BY event_key) FROM public.operational_alert_events "
                 "WHERE source='rakeback-settler-stranded-sources';") == '2,2', 'a re-detection is one event, not two'
    assert query("SELECT count(*) FROM public.operational_alert_events WHERE source='rakeback-settler-read-horizon';") == '0'
    # Once submitted, the row is no longer reported.
    query(f"INSERT INTO public.accounting_cash_accrual_batches VALUES ('{uid(25)}'), ('{uid(26)}');")
    assert json.loads(query('SELECT public.fn_rakeback_settler_stranded_source_check();'))['stranded'] == 0

    # ── A held horizon is named. The shipped hold is 20 minutes; the same body
    # with a 61 s hold proves the path without waiting (the margin alone is 60 s).
    shipped = query("SELECT pg_get_functiondef('public.fn_rakeback_settler_stranded_source_check()'::regprocedure);")
    assert shipped.count("interval '20 minutes'") == 1
    query(shipped.replace("interval '20 minutes'", "interval '61 seconds'") + ';')
    assert json.loads(query('SELECT public.fn_rakeback_settler_stranded_source_check();'))['stranded'] == 0
    assert query("SELECT count(*) FROM public.operational_alert_events WHERE source='rakeback-settler-read-horizon';") == '0'
    holder = open_session('forgotten-session', 'BEGIN; SELECT 1;')
    time.sleep(2.2)
    query('SELECT public.fn_rakeback_settler_stranded_source_check();')
    held = json.loads(query(
        "SELECT json_agg(json_build_object('name',alertname,'task',payload->>'target_task_id',"
        "'app',payload->>'oldest_application','state',payload->>'oldest_state')) "
        "FROM public.operational_alert_events WHERE source='rakeback-settler-read-horizon';"))
    assert held == [{'name': 'rakeback_settler_read_horizon_held', 'task': TASK, 'app': 'forgotten-session',
                     'state': 'idle in transaction'}], held
    finish(holder, 'ROLLBACK;')

    # ── Prepared transactions: no horizon, and no install ─────────────────────
    run([pg / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    with (data / 'postgresql.conf').open('a') as f:
        f.write('\nmax_prepared_transactions=2\n')
    run([pg / 'pg_ctl', '-D', data, '-l', cluster / 'server.log', '-w', 'start'])
    query("BEGIN; INSERT INTO public.rake_records(id, rake_amount) VALUES ('" + uid(40) + "', 1); PREPARE TRANSACTION 'hz';")
    h = horizon()
    assert h['horizon'] is None and h['reason'] == 'prepared_transaction_open', h
    query("COMMIT PREPARED 'hz';")
    query(migration, 'HORIZON_PREPARED_TRANSACTIONS', db='postgres')
    print('rakeback-settler-read-horizon-native-acceptance-passed')
finally:
    for p in list(sessions):
        p.kill()
    if started and (data / 'postmaster.pid').exists():
        run([pg / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    shutil.rmtree(socket, ignore_errors=True)
