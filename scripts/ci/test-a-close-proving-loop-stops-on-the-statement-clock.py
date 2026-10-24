"""Isolated PostgreSQL regression for the weekly close's round-2 and round-3 advances.

Job 272 runs the weekly close as ONE 240 s statement. Before a union attempt
reaches the round-2 windows (fn_settle_accounting_commission_advance) or the
round-3 windows and plan (fn_settle_accounting_rakeback_advance), the tick has
already selected scopes, visited the standalone club scope and prepared the
book, which can take most of the statement. Both advances stopped only 120 s
after the ATTEMPT began, never asking how much of the STATEMENT was left, so a
late attempt kept starting windows until the statement was cancelled and every
window it had proved was rolled back (production 2026-10-15 18:05 UTC).

The test loads the exact production definitions captured on 2026-10-15 (their
pg_get_functiondef md5 equal production's) over stub windows, proves the
baseline starts work with less than a minute of the statement left and is
cancelled with nothing kept, then applies the candidate migration and proves:

  * a late attempt starts no window and no round-3 plan, and returns cleanly;
  * an attempt with a short statement proves windows until a minute before the
    timeout and keeps them (the statement completes);
  * with no statement timeout the attempt rules (at least one window, 120 s,
    60 s before the plan) are unchanged;
  * every window fresh and the plan present still returns false, so the money
    round is never held back by the clock;
  * job 272's entry (fn_union_settlement_cascade_due) proves a 'prepared'
    book's round-2 windows from the top of the tick until a minute before the
    statement ends and then visits no scope, and is exactly as before when no
    window is pending, the round is paid, the tick is not chunked (the
    engine's call), the platform is frozen, or a window cannot be proved;
  * the derived postimage md5s, owner, volatility, settings and grants, and a
    refused second run.

An empty throwaway cluster on a Unix socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'a-close-proving-loop-stops-on-the-statement-clock'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path,
                    default=ROOT / 'artifacts/a-close-proving-loop-stops-on-the-statement-clock')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='close-clock-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55841'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

COMMISSION = 'public.fn_settle_accounting_commission_advance(text,uuid,timestamp with time zone,timestamp with time zone)'
DUE = 'public.fn_union_settlement_cascade_due()'
RAKEBACK = 'public.fn_settle_accounting_rakeback_advance(text,uuid,timestamp with time zone,timestamp with time zone)'
# pg_get_functiondef md5 read on production 2026-10-15 before the candidate,
# and the postimages derived read-only on production with replace().
LIVE = {COMMISSION: '962cc58063d067043734b56a829a78aa', RAKEBACK: '53dadff0fe6ec7e39415e8b8d4b6a99b',
        DUE: '719944c319cd935f5240326469d98f01'}
POST = {COMMISSION: 'e91c40770c8de772df2a25bbce016ef5', RAKEBACK: '2c3f36a8920d70b225c887c1287a567b',
        DUE: '4e48f73890bd1b928653327f3a0a388b'}
FIXTURE = {COMMISSION: 'fn_settle_accounting_commission_advance.live-20261015.sql',
           RAKEBACK: 'fn_settle_accounting_rakeback_advance.live-20261015.sql',
           DUE: 'fn_union_settlement_cascade_due.live-20261015.sql'}
# Production's grants: {postgres=X/postgres,service_role=X/postgres}.
GRANTS = ''.join(f'REVOKE ALL ON FUNCTION {s} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {s} TO service_role;\n'
                 for s in (COMMISSION, RAKEBACK, DUE))
PRONAMES = "('fn_settle_accounting_commission_advance','fn_settle_accounting_rakeback_advance','fn_union_settlement_cascade_due')"

UNION = 'fade0000-0000-0000-0000-000000000001'
WEEK = "'2026-10-05 07:00+00'::timestamptz,'2026-10-12 07:00+00'::timestamptz"

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, name text);
CREATE TABLE public.accounting_close_partials(kind text NOT NULL, union_id uuid NOT NULL,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL, value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea,
  computed_at timestamptz NOT NULL, PRIMARY KEY(kind,union_id,period_start,period_end,window_start));
CREATE TABLE public.plan_calls(at timestamptz DEFAULT clock_timestamp());
CREATE TABLE public.process_calls(at timestamptz DEFAULT clock_timestamp());
CREATE TABLE public.union_accounting_runs(scope_kind text, scope_id uuid, period_start timestamptz,
  period_end timestamptz, status text, result jsonb);
CREATE TABLE public.accounting_routed_settlement_runs(scope_kind text, scope_id uuid, period_start timestamptz,
  period_end timestamptz, round_no integer);
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql
  AS $$ SELECT COALESCE(current_setting('test.frozen',true),'')='on' $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
-- The scope scan the tick would otherwise run: recorded, nothing else.
CREATE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL::uuid) RETURNS jsonb
  LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.process_calls DEFAULT VALUES;
  RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'detail','[]'::jsonb,'processed',true); END $$;
-- Production's definition, byte for byte.
CREATE FUNCTION public.fn_accounting_close_windows(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(window_start timestamp with time zone, window_end timestamp with time zone)
 LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
 SELECT g, LEAST(g+interval '2 hours', p_end)
   FROM generate_series(p_start, p_end-interval '1 microsecond', interval '2 hours') g
  WHERE p_start<p_end AND isfinite(p_start) AND isfinite(p_end)
$function$;
-- Stubs for the book's reads: each window takes test.window_seconds.
CREATE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text, p_scope_id uuid,
  p_period_start timestamptz, p_period_end timestamptz)
 RETURNS TABLE(union_id uuid, standalone_club_id uuid, club_ids uuid[], scope_key text, lock_key text, routing_context text)
 LANGUAGE sql AS $$ SELECT p_scope_id, NULL::uuid, ARRAY[p_scope_id], p_scope_id::text, 'k', 'c' $$;
CREATE FUNCTION public.fn_settle_accounting_commission_window(p_union_id uuid, p_standalone_club_id uuid,
  p_club_ids uuid[], p_window_start timestamptz, p_window_end timestamptz)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
 LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_sleep(current_setting('test.window_seconds')::float8);
  IF COALESCE(current_setting('test.window_fail',true),'')='on' THEN RAISE EXCEPTION 'stub window refused'; END IF;
  RETURN QUERY SELECT jsonb_build_object('e1',0), NULL::uuid[], NULL::bytea, NULL::uuid[], NULL::bytea;
 END $$;
CREATE FUNCTION public.fn_settle_accounting_rakeback_window(p_union_id uuid, p_standalone_club_id uuid,
  p_window_start timestamptz, p_window_end timestamptz)
 RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_sleep(current_setting('test.window_seconds')::float8);
  RETURN jsonb_build_object('read_failed',false);
 END $$;
CREATE FUNCTION public.fn_settle_accounting_rakeback_plan(p_scope_kind text, p_scope_id uuid,
  p_period_start timestamptz, p_period_end timestamptz)
 RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO public.plan_calls DEFAULT VALUES;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('round3_'||p_scope_kind||'_plan',p_scope_id,p_period_start,p_period_end,p_period_start,p_period_end,'{}',clock_timestamp());
  RETURN '{}';
 END $$;
"""


def command(args, sql=None, timeout=180):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql, timeout=180):
    return command(psql, sql, timeout)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


def attempt(fn, *, statement_timeout, late_seconds, window_seconds, began_seconds_ago=0):
    """One chunked close attempt, as job 272 runs it: ONE statement under
    statement_timeout, which spends late_seconds before reaching the advance.
    Returns (outcome, value, seconds) where outcome is 'ok' or 'cancelled'."""
    sql = f"""
SET statement_timeout = '{statement_timeout}';
SET test.window_seconds = '{window_seconds}';
SET app.weekly_accounting_chunked = 'on';
SET app.weekly_accounting_scope_budget = '3 minutes';
DO $t$ DECLARE v boolean; t0 timestamptz := clock_timestamp(); BEGIN
  PERFORM set_config('app.weekly_accounting_scope_deadline',
    (clock_timestamp() + interval '3 minutes' - interval '{began_seconds_ago} seconds')::text, false);
  PERFORM pg_sleep({late_seconds});
  v := public.{fn}('union', '{UNION}', {WEEK});
  RAISE NOTICE 'RESULT %|%', v, extract(epoch FROM clock_timestamp() - t0);
END $t$;
"""
    r = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=240)
    if r.returncode:
        if 'canceling statement due to statement timeout' in r.stderr:
            return 'cancelled', None, None
        raise RuntimeError(r.stderr)
    m = re.search(r'RESULT (\w*)\|([\d.]+)', r.stderr)
    return 'ok', m.group(1), float(m.group(2))


def partials(kind):
    return int(run(f"SELECT count(*) FROM public.accounting_close_partials WHERE kind='{kind}'"))


def reset():
    run('TRUNCATE public.accounting_close_partials, public.plan_calls;')


def fill(kind):
    run(f"""INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
SELECT '{kind}','{UNION}','2026-10-05 07:00+00','2026-10-12 07:00+00',w.window_start,w.window_end,'{{}}',now()
FROM public.fn_accounting_close_windows({WEEK}) w;""")


def plan_calls():
    return int(run('SELECT count(*) FROM public.plan_calls'))


def tick(*, statement_timeout='64s', chunked='on', window_seconds=1, frozen='off', fail='off'):
    """One job 272 tick: its settings, then ONE statement calling the entry.
    The hourly-break rule reads the minute in the session's time zone, so the
    tick runs in a zone whose minute is under 45 (production runs in UTC)."""
    minute = int(run("SELECT extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC')"))
    zone = 'UTC' if minute < 40 else 'Asia/Kathmandu'
    run('TRUNCATE public.process_calls;')
    sql = f"""
SET TimeZone = '{zone}';
SET statement_timeout = '{statement_timeout}';
SET test.window_seconds = '{window_seconds}';
SET test.frozen = '{frozen}';
SET test.window_fail = '{fail}';
SET app.weekly_accounting_chunked = '{chunked}';
SET app.weekly_accounting_scope_budget = '3 minutes';
SELECT public.fn_union_settlement_cascade_due();
"""
    out_ = command(psql, sql, 240)
    return json.loads(out_.splitlines()[-1]), int(run('SELECT count(*) FROM public.process_calls'))


def prepared_run(stage='prepared'):
    run('TRUNCATE public.union_accounting_runs, public.accounting_routed_settlement_runs;')
    run(f"""INSERT INTO public.union_accounting_runs VALUES('union','{UNION}','2026-10-05 07:00+00','2026-10-12 07:00+00',
'running',jsonb_build_object('stage','{stage}','success',false,'chunk_committed',true,'committed_round',0));""")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    check('the-week-has-84-windows', run(f'SELECT count(*) FROM public.fn_accounting_close_windows({WEEK})') == '84')

    # Baseline: the exact production definitions before this change.
    for sig, fx in FIXTURE.items():
        run((FIXTURES / fx).read_text() + ';')
    run(GRANTS)
    for sig in FIXTURE:
        got = run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")
        check(f'baseline-is-production-preimage:{sig.split("(")[0]}', got == LIVE[sig], got)
    acl_before = run("SELECT string_agg(p.oid::regprocedure::text||'|'||pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||"
                     "p.provolatile::text||'|'||array_to_string(p.proconfig,',')||'|'||p.proacl::text, ';' ORDER BY p.oid::regprocedure::text) "
                     "FROM pg_proc p WHERE p.proname IN " + PRONAMES)

    base = {}
    # 1. A late attempt: 3 s of a 62 s statement already spent, so less than a
    #    minute is left. The baseline starts windows anyway.
    reset()
    base['late-round2'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='62s',
                                  late_seconds=3, window_seconds=0.02)
    base['late-round2-kept'] = partials('round2_union_window')
    check('baseline-starts-round2-windows-with-under-a-minute-left', base['late-round2-kept'] > 0, base)
    reset()
    fill('round3_union_window')
    base['late-plan'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='62s',
                                late_seconds=3, window_seconds=0.02)
    base['late-plan-calls'] = plan_calls()
    check('baseline-starts-the-round3-plan-with-under-a-minute-left', base['late-plan-calls'] == 1, base)
    # 2. The production failure: windows of 1 s each, a 64 s statement. The
    #    baseline keeps starting windows (its rule is 120 s after the attempt
    #    began) until the statement is cancelled, and keeps none.
    reset()
    base['overrun-round2'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='64s',
                                     late_seconds=0, window_seconds=1)
    base['overrun-round2-kept'] = partials('round2_union_window')
    check('baseline-is-cancelled-and-keeps-nothing',
          base['overrun-round2'][0] == 'cancelled' and base['overrun-round2-kept'] == 0, base)
    reset()
    prepared_run()
    base['tick'] = tick()
    base['tick-kept'] = partials('round2_union_window')
    check('baseline-tick-never-proves-windows-before-the-scope-scan',
          base['tick'][1] == 1 and base['tick-kept'] == 0, base)
    results['baseline'] = base

    # Candidate: the migration under test, applied as production would.
    migration = one('*_a_close_proving_loop_stops_on_the_statement_clock.sql').read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;$', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;$', migration, re.M)) == 1)
    check('candidate-carries-live-proof',
          migration.startswith('-- @live-proof:') and all(v in migration.splitlines()[0] for v in POST.values()))
    check('candidate-writes-no-row',
          not re.search(r'^\s*(INSERT|UPDATE|DELETE)\b', '\n'.join(l for l in migration.splitlines()
                                                                if not l.lstrip().startswith('--') and '$o' not in l and '$n' not in l),
                        re.M | re.I))
    run(migration)
    for sig in FIXTURE:
        got = run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")
        check(f'candidate-reproduces-production-derived-postimage:{sig.split("(")[0]}', got == POST[sig], got)
    acl_after = run("SELECT string_agg(p.oid::regprocedure::text||'|'||pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||"
                    "p.provolatile::text||'|'||array_to_string(p.proconfig,',')||'|'||p.proacl::text, ';' ORDER BY p.oid::regprocedure::text) "
                    "FROM pg_proc p WHERE p.proname IN " + PRONAMES)
    check('candidate-keeps-owner-volatility-settings-and-grants', acl_after == acl_before, [acl_before, acl_after])
    check('the-advance-is-service-role-only',
          run("SELECT array_to_string(proacl,',') FROM pg_proc WHERE oid='public.fn_accounting_close_windows_advance_due()'::regprocedure")
          == 'postgres=X/postgres,service_role=X/postgres')

    got = {}
    reset()
    got['late-round2'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='62s',
                                 late_seconds=3, window_seconds=0.02)
    got['late-round2-kept'] = partials('round2_union_window')
    check('a-late-attempt-starts-no-round2-window',
          got['late-round2'][0] == 'ok' and got['late-round2'][1] == 'f' and got['late-round2-kept'] == 0, got)
    reset()
    got['late-round3'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='62s',
                                 late_seconds=3, window_seconds=0.02)
    got['late-round3-kept'] = partials('round3_union_window')
    check('a-late-attempt-starts-no-round3-window-and-ends-the-attempt',
          got['late-round3'][0] == 'ok' and got['late-round3'][1] == 't' and got['late-round3-kept'] == 0, got)
    reset()
    fill('round3_union_window')
    got['late-plan'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='62s',
                               late_seconds=3, window_seconds=0.02)
    got['late-plan-calls'] = plan_calls()
    check('a-late-attempt-starts-no-round3-plan-and-ends-the-attempt',
          got['late-plan'][1] == 't' and got['late-plan-calls'] == 0, got)
    # The production failure, fixed: the attempt proves windows until a
    # minute before the timeout, then commits them.
    reset()
    got['overrun-round2'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='64s',
                                    late_seconds=0, window_seconds=1)
    got['overrun-round2-kept'] = partials('round2_union_window')
    check('a-short-statement-keeps-the-windows-it-proved',
          got['overrun-round2'][0] == 'ok' and got['overrun-round2'][1] == 'f'
          and 3 <= got['overrun-round2-kept'] <= 6 and got['overrun-round2'][2] < 8, got)
    reset()
    got['overrun-round3'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='64s',
                                    late_seconds=0, window_seconds=1)
    got['overrun-round3-kept'] = partials('round3_union_window')
    check('a-short-statement-keeps-the-round3-windows-it-proved',
          got['overrun-round3'][0] == 'ok' and got['overrun-round3'][1] == 't'
          and 3 <= got['overrun-round3-kept'] <= 6 and got['overrun-round3'][2] < 8, got)
    # With time left, unchanged: all 84 windows in one attempt, then the plan
    # in the next (60 s rule not reached), exactly as before.
    reset()
    got['free-round2'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='0',
                                 late_seconds=0, window_seconds=0.01)
    got['free-round2-kept'] = partials('round2_union_window')
    check('no-statement-timeout-proves-every-window', got['free-round2-kept'] == 84 and got['free-round2'][1] == 't', got)
    reset()
    got['free-round3'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='240s',
                                 late_seconds=0, window_seconds=0.01)
    got['free-round3-kept'] = (partials('round3_union_window'), plan_calls())
    check('time-left-proves-every-round3-window-and-the-plan', got['free-round3-kept'] == (84, 1)
          and got['free-round3'][1] == 't', got)
    # The attempt rules are unchanged: an attempt that began over 120 s ago
    # still proves exactly one window.
    reset()
    got['old-attempt'] = attempt('fn_settle_accounting_commission_advance', statement_timeout='0',
                                 late_seconds=0, window_seconds=0.01, began_seconds_ago=130)
    got['old-attempt-kept'] = partials('round2_union_window')
    check('the-120-second-attempt-rule-is-unchanged', got['old-attempt-kept'] == 1 and got['old-attempt'][1] == 'f', got)
    # Every window fresh and the plan present: false, late or not, so the
    # attempt goes on to its money round. The clock never holds it back.
    reset()
    fill('round3_union_window')
    run(f"""INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
VALUES('round3_union_plan','{UNION}','2026-10-05 07:00+00','2026-10-12 07:00+00','2026-10-05 07:00+00','2026-10-12 07:00+00','{{}}',now());""")
    got['done-late'] = attempt('fn_settle_accounting_rakeback_advance', statement_timeout='62s',
                               late_seconds=3, window_seconds=0.01)
    check('a-finished-round3-never-holds-the-money-round', got['done-late'][1] == 'f' and plan_calls() == 0, got)
    # Job 272's entry: a 'prepared' book's round-2 windows are proved from
    # the top of the tick until a minute before the statement ends, and the
    # tick then visits no scope.
    reset()
    prepared_run()
    got['tick'] = tick(statement_timeout='64s', window_seconds=1)
    got['tick-kept'] = partials('round2_union_window')
    check('a-chunked-tick-proves-pending-round2-windows-and-visits-no-scope',
          got['tick'][0].get('window_advance') is not None and got['tick'][1] == 0
          and 3 <= got['tick-kept'] <= 5 and got['tick'][0].get('success') is True
          and got['tick'][0].get('checked') == 0 and got['tick'][0].get('detail') == [], got)
    reset()
    prepared_run()
    got['tick-whole'] = tick(statement_timeout='240s', window_seconds=0.01)
    got['tick-whole-kept'] = partials('round2_union_window')
    check('a-tick-with-time-proves-every-window', got['tick-whole-kept'] == 84 and got['tick-whole'][1] == 0, got)
    got['tick-done'] = tick(statement_timeout='240s', window_seconds=0.01)
    check('every-window-fresh-the-tick-is-as-before',
          got['tick-done'][1] == 1 and got['tick-done'][0].get('processed') is True, got)
    reset()
    prepared_run()
    run(f"INSERT INTO public.accounting_routed_settlement_runs VALUES('union','{UNION}','2026-10-05 07:00+00','2026-10-12 07:00+00',2);")
    got['tick-paid'] = tick(window_seconds=0.01)
    check('a-paid-round-is-left-alone', got['tick-paid'][1] == 1 and partials('round2_union_window') == 0, got)
    reset()
    prepared_run(stage='certifying')
    got['tick-certifying'] = tick(window_seconds=0.01)
    check('a-book-not-prepared-is-left-alone', got['tick-certifying'][1] == 1 and partials('round2_union_window') == 0, got)
    reset()
    prepared_run()
    got['tick-engine'] = tick(statement_timeout='8s', chunked='off', window_seconds=0.01)
    check('the-engines-call-is-unchanged', got['tick-engine'][1] == 1 and partials('round2_union_window') == 0, got)
    got['tick-frozen'] = tick(frozen='on', window_seconds=0.01)
    check('a-frozen-platform-is-left-alone', got['tick-frozen'][1] == 1 and partials('round2_union_window') == 0, got)
    got['tick-fail'] = tick(fail='on', window_seconds=0.01)
    check('a-window-that-cannot-be-proved-falls-through-to-the-scope-scan',
          got['tick-fail'][1] == 1 and partials('round2_union_window') == 0, got)
    results['candidate'] = got

    # A second run is refused (the advance exists; the pinned preimages are gone).
    try:
        run(migration)
        replay = 'applied'
    except RuntimeError as e:
        replay = str(e)
    check('a-second-run-is-refused', 'close_clock_advance_already_present' in replay, replay[-300:])
    try:
        run(migration.replace("IF to_regprocedure('public.fn_accounting_close_windows_advance_due()') IS NOT NULL THEN RAISE EXCEPTION 'close_clock_advance_already_present';END IF;", ''))
        replay = 'applied'
    except RuntimeError as e:
        replay = str(e)
    check('a-second-run-is-refused-by-the-pinned-preimage-too', 'is not the pinned text' in replay, replay[-300:])
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'passed': sum(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
