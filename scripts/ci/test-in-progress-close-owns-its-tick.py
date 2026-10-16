"""Isolated PostgreSQL regression for migration 20261016000241.

An in-progress weekly close owns its tick, and a close attempt reads its
week's clubs once.

The Midway Union close of 2026-10-05 -> 2026-10-12 proved all 168 of its round
2 and round 3 windows by 23:28 UTC on 2026-10-15 and then had every job 272
visit cancelled at the 240 s statement budget (57014), for two reasons read on
production:

  * the union's visit always ran last: a scope whose last visit did not finish
    is ordered after every scope whose visit finished, and the standalone club
    visited before it took 125 to 196 s of the statement, so the union kept
    timing out because it had timed out;
  * fn_accounting_week_clubs(union, week) took 21 s warm and 84.6 s cold for
    that week (2.5 million accepted-earning rows materialised to find 2 clubs)
    and one paying attempt calls it from preparation, the scheduler, the
    cascade and the conservation assertion.

This test loads the exact production definitions (pg_get_functiondef md5
equal to production's: fn_accounting_week_clubs 47df4a9d..., and
fn_process_weekly_accounting_scope rebuilt from 20261013212336 through the
installs of 20261015173123 and 20261015182133, e6960e39 -> a4973812 ->
00993874), proves the starvation on the preimage, applies the candidate's two
pinned substitutions, reproduces production's derived postimage md5s, and then
proves:

  1. the set-based week-clubs read returns exactly what the old per-row read
     returned, for every union and week of a randomized fixture that covers
     NULL clubs, NULL, -infinity, infinity and boundary cutoffs, NULL and
     infinite charges, and every recognition flag;
  2. its answer is kept only inside a union close attempt that holds the
     week's exclusive close lock, only for that attempt, and is forgotten by a
     rolled-back subtransaction; and a source writer cannot take its shared
     lock while the attempt holds it;
  3. a book with a committed step goes first in its tick and the tick ends
     with it; if its own first-place visit is cancelled it gives the place
     back for exactly one tick; without an in-progress book the order is
     unchanged.

An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
CANDIDATE = MIGRATIONS / '20261016000241_an_in_progress_close_owns_its_tick_and_reads_its_clubs_once.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/in-progress-close-owns-its-tick')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['PATH'] = env.get('PATH', '/usr/bin:/bin') + ':/usr/sbin:/sbin'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='in-progress-close-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
results = {'checks': [], 'production_mutations': False}

# Production, read 2026-10-15/16 (pg_get_functiondef md5).
WEEK_CLUBS_LIVE = '47df4a9dfae6291b7b3f3d3c16470cfc'
SCOPE_SELECTOR = 'e6960e3960fde66c11578438692c57b1'   # 20261013212336
SCOPE_SPLIT = 'a497381284a4f68b573cbf08ce1929e3'      # 20261015173123 (live)
SCOPE_WINDOWS = '009938740934b24744b35496477d02a1'    # 20261015182133 (#6995)
# Derived read-only on production with replace() over the live text.
WEEK_CLUBS_POST = '5d65713ce64534dfbe31e749d5bf737f'
SCOPE_POST = 'faa32923eae3b055b18e85d5f3df356d'
# 20261015234926 (PR #7040) pins #6995's text too and edits disjoint lines; it
# installs first, and this candidate then starts from its postimage.
COMPLETION_POST = 'e4c2252df2382259d164e1b11b00b82b'
SCOPE_POST_AFTER_COMPLETION = 'a0ffe85a2f16c82af0221de03202fa26'
COMPLETION = MIGRATIONS / '20261015234926_a_completed_week_reads_its_earning_clubs_once.sql'
PARENT = {}

UNION = 'fade0000-0000-0000-0000-000000000001'
CLUB = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'


def command(args, sql=None, timeout=120):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def psql_args(tz=None):
    a = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
    return a


def run(sql):
    return command(psql_args(), sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def block(path, start, end):
    s = path.read_text()
    i = s.index(start)
    j = s.index(end, i) + len(end)
    return s[i:j]


def md5_of(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def tick_zone():
    # The scheduler refuses minute :45-:59 of its clock (the maintenance
    # break). Read the clock in a zone that keeps the test away from it.
    return 'UTC' if time.gmtime().tm_min < 40 else 'Asia/Kolkata'


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA supabase_migrations;
CREATE TABLE clubs(id uuid PRIMARY KEY, is_union boolean);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE union_settlement_floor(union_id uuid PRIMARY KEY, earliest_period_start timestamptz);
CREATE TABLE union_clubs(club_id uuid, union_id uuid);
CREATE TABLE agents(club_id uuid, is_prepaid boolean, credit_used numeric);
CREATE TABLE rakeback_periods(club_id uuid, status text, period_start date, period_end date, rakeback_amount numeric);
CREATE TABLE launch_cutoffs(club_id uuid PRIMARY KEY, cutoff timestamptz);
CREATE TABLE cutoff_calls(n bigserial, club_id uuid);
CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid,
  coordinator_union_id uuid, earned_at timestamptz, recorded_at timestamptz DEFAULT now());
CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, tournament_id uuid,
  coordinator_union_id uuid, union_id uuid, charged_at timestamptz, rake_credit numeric);
CREATE TABLE accounting_tournament_recognized_sources(source_id uuid, tournament_id uuid, recognized_at timestamptz,
  disposition text, rake_credit numeric);
CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY, status text, recognized_at timestamptz, union_id uuid);
CREATE TABLE accounting_payable_earning_sources(club_id uuid, source_type text, coordinator_union_id uuid, earned_at timestamptz);
CREATE TABLE accounting_agreement_history(id bigserial PRIMARY KEY, entity_type text, entity_key text, observed_at timestamptz, after_terms jsonb);
CREATE TABLE accounting_rakeback_period_calculations(club_id uuid, coordinator_union_id uuid, period_start date, period_end date);
CREATE TABLE settlement_periods(club_id uuid, union_id uuid, start_at timestamptz, end_at timestamptz);
CREATE TABLE union_accounting_runs(union_id uuid, period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  scheduled_at timestamptz, status text NOT NULL, attempts integer DEFAULT 0, started_at timestamptz, finished_at timestamptz,
  result jsonb DEFAULT '{}'::jsonb, standalone_club_id uuid,
  scope_kind text GENERATED ALWAYS AS (CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END) STORED,
  scope_id uuid GENERATED ALWAYS AS (COALESCE(union_id,standalone_club_id)) STORED,
  last_scheduler_visit_at timestamptz, PRIMARY KEY(scope_kind,scope_id,period_start,period_end),
  UNIQUE(union_id,period_start,period_end));
CREATE TABLE weekly_accounting_scheduler_visits(scope_kind text, scope_id uuid, last_visit_at timestamptz, last_outcome text,
  last_error jsonb, unfinished_visits integer DEFAULT 0, PRIMARY KEY(scope_kind,scope_id));
CREATE TABLE financial_alerts(id bigserial, source text, severity text, message text, context jsonb, resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now());
CREATE TABLE visit_log(n bigserial, kind text, scope_id uuid);
CREATE TABLE gate_sleep(scope_id uuid PRIMARY KEY, seconds numeric);

CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS 'SELECT NULL::timestamptz';
CREATE FUNCTION fn_union_week_start(p timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE
  AS $$ SELECT (date_trunc('week', p AT TIME ZONE 'UTC') + interval '7 hours') AT TIME ZONE 'UTC'
             - CASE WHEN p < (date_trunc('week', p AT TIME ZONE 'UTC') + interval '7 hours') AT TIME ZONE 'UTC'
                    THEN interval '7 days' ELSE interval '0' END $$;
CREATE FUNCTION fn_union_prev_week_start(p timestamptz) RETURNS timestamptz LANGUAGE sql AS 'SELECT public.fn_union_week_start(p)-interval ''7 days''';
CREATE FUNCTION fn_union_accounting_run_at(p timestamptz) RETURNS timestamptz LANGUAGE sql AS 'SELECT p';
CREATE FUNCTION fn_club_settlement_floor_week(p uuid) RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2026-01-05 07:00Z'::timestamptz $$;
CREATE FUNCTION fn_ca_launch_accounting_cutoff(p_kind text, p_club uuid) RETURNS timestamptz LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.cutoff_calls(club_id) VALUES(p_club);
 RETURN (SELECT c.cutoff FROM public.launch_cutoffs c WHERE c.club_id=p_club); END $$;
CREATE FUNCTION fn_accounting_close_seal_held(p timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION fn_accounting_split_advance_due() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"advanced":false}'::jsonb $$;
CREATE FUNCTION fn_accounting_window_advance_due() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"advanced":false,"books":[]}'::jsonb $$;
CREATE FUNCTION fn_accounting_close_gate_holds(p_kind text, p_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE s numeric;
BEGIN
 INSERT INTO public.visit_log(kind,scope_id) VALUES(p_kind,p_id);
 SELECT g.seconds INTO s FROM public.gate_sleep g WHERE g.scope_id=p_id;
 IF s IS NOT NULL THEN PERFORM pg_sleep(s); END IF;
 RETURN true;
END $$;
"""


def load_preimages():
    wc = block(MIGRATIONS / '20261013195428_weekly_cohort_cutoff_runs_once_per_earning_club.sql',
               'CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(', 'END $function$;')
    run(wc + "\nREVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;")
    check('week-clubs-preimage-is-production', md5_of('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)') == WEEK_CLUBS_LIVE)
    # The old read, kept beside the new one under another name for comparison.
    run(wc.replace('public.fn_accounting_week_clubs(', 'public.fn_accounting_week_clubs_before(', 1))
    ps = block(MIGRATIONS / '20261013212336_weekly_standalone_selector_callbacks_run_once_per_earning_cl.sql',
               'CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting_scope(', 'END $function$;')
    run(ps + "\nREVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;")
    sig = 'public.fn_process_weekly_accounting_scope(uuid,uuid)'
    check('scope-selector-text-is-production', md5_of(sig) == SCOPE_SELECTOR)
    for name, expect in (('20261015173123_a_calculating_week_advances_on_its_own_tick.sql', SCOPE_SPLIT),
                         ('20261015182133_a_proving_week_advances_on_its_own_tick.sql', SCOPE_WINDOWS)):
        run('SET search_path=public;\n' + block(MIGRATIONS / name, 'DO $install$', 'END $install$;'))
        check('scope-chain-' + name[:14], md5_of(sig) == expect, md5_of(sig))
    PARENT['scope'] = run(f"SELECT pg_get_functiondef('{sig}'::regprocedure)")


def install_candidate():
    text = CANDIDATE.read_text()
    blocks = re.findall(r'DO \$install\$.*?END \$install\$;', text, re.S)
    check('candidate-has-two-installs', len(blocks) == 2, len(blocks))
    check('candidate-pins-window-advance-first', "version='20261015182133'" in text and SCOPE_WINDOWS in text)
    for b in blocks:
        run('SET search_path=public;\n' + b)
    check('week-clubs-postimage-is-production-derived',
          md5_of('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)') == WEEK_CLUBS_POST)
    check('scope-postimage-is-production-derived',
          md5_of('public.fn_process_weekly_accounting_scope(uuid,uuid)') == SCOPE_POST)
    sec = run("SELECT string_agg(p.proname||':'||p.prosecdef||':'||p.provolatile::text||':'||array_to_string(p.proconfig,',')||':'||COALESCE(array_to_string(p.proacl,','),''),' ' ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('fn_accounting_week_clubs','fn_process_weekly_accounting_scope')")
    check('owner-security-config-unchanged',
          sec == 'fn_accounting_week_clubs:true:s:search_path=public:postgres=X/postgres fn_process_weekly_accounting_scope:true:v:search_path=public:postgres=X/postgres', sec)


# ── 1. week clubs: same answer ────────────────────────────────────────────
FIXTURE = """
SELECT setseed(0.4242);
INSERT INTO clubs(id,is_union) SELECT ('c0000000-0000-0000-0000-00000000000'||i)::uuid,false FROM generate_series(1,8) i;
INSERT INTO launch_cutoffs VALUES
 ('c0000000-0000-0000-0000-000000000002','2026-10-07 00:00Z'),
 ('c0000000-0000-0000-0000-000000000003','infinity'),
 ('c0000000-0000-0000-0000-000000000004','-infinity'),
 ('c0000000-0000-0000-0000-000000000005','2026-10-11 12:00Z'),
 ('c0000000-0000-0000-0000-000000000006','2026-10-05 07:00Z'),
 ('c0000000-0000-0000-0000-000000000007','2026-10-13 00:00Z');
CREATE TEMP TABLE u(i int, id uuid);
INSERT INTO u VALUES (1,'a0000000-0000-0000-0000-000000000001'),(2,'a0000000-0000-0000-0000-000000000002'),(3,NULL);
CREATE TEMP TABLE pick_club AS SELECT g, CASE WHEN random()<0.08 THEN NULL
  ELSE ('c0000000-0000-0000-0000-00000000000'||(1+floor(random()*8))::int)::uuid END AS club FROM generate_series(1,3000) g;
INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)
SELECT p.club, (SELECT id FROM u WHERE u.i=1+floor(random()*3)::int),
  '2026-09-27 00:00Z'::timestamptz + (random()*interval '24 days')
FROM pick_club p WHERE p.g<=900;
INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)
SELECT p.club,'a0000000-0000-0000-0000-000000000001',x FROM pick_club p,
 unnest(ARRAY['2026-10-05 07:00Z','2026-10-12 06:59:59.999999Z','2026-10-07 00:00Z','2026-10-11 12:00Z']::timestamptz[]) x WHERE p.g BETWEEN 901 AND 910;
INSERT INTO accounting_tournament_fee_recognitions(tournament_id,status,recognized_at,union_id)
SELECT ('70000000-0000-0000-0000-'||lpad(t::text,12,'0'))::uuid,
  CASE WHEN random()<0.8 THEN 'recognized' ELSE 'pending' END,
  '2026-09-28 00:00Z'::timestamptz + (random()*interval '22 days'),
  CASE WHEN random()<0.15 THEN NULL WHEN random()<0.5 THEN 'a0000000-0000-0000-0000-000000000001'::uuid ELSE 'a0000000-0000-0000-0000-000000000002'::uuid END
FROM generate_series(1,60) t;
INSERT INTO accounting_tournament_fee_sources(club_id,tournament_id,coordinator_union_id,union_id,charged_at,rake_credit)
SELECT p.club, ('70000000-0000-0000-0000-'||lpad((1+floor(random()*60))::int::text,12,'0'))::uuid,
  (SELECT id FROM u WHERE u.i=1+floor(random()*3)::int),
  CASE WHEN random()<0.1 THEN NULL WHEN random()<0.6 THEN 'a0000000-0000-0000-0000-000000000001'::uuid ELSE 'a0000000-0000-0000-0000-000000000002'::uuid END,
  CASE WHEN random()<0.06 THEN NULL WHEN random()<0.05 THEN 'infinity'::timestamptz WHEN random()<0.05 THEN '-infinity'::timestamptz
   ELSE '2026-09-27 00:00Z'::timestamptz + (random()*interval '24 days') END,
  CASE WHEN random()<0.05 THEN NULL ELSE (1+floor(random()*3))::numeric END
FROM pick_club p WHERE p.g BETWEEN 1001 AND 2400;
INSERT INTO accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)
SELECT s.id, CASE WHEN random()<0.03 THEN gen_random_uuid() ELSE s.tournament_id END,
  CASE WHEN random()<0.7 THEN r.recognized_at ELSE '2026-09-28 00:00Z'::timestamptz + (random()*interval '22 days') END,
  CASE WHEN random()<0.8 THEN 'earned' WHEN random()<0.5 THEN 'refunded' ELSE NULL END,
  CASE WHEN random()<0.85 THEN s.rake_credit ELSE s.rake_credit+1 END
FROM accounting_tournament_fee_sources s JOIN accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
WHERE random()<0.9;
INSERT INTO accounting_agreement_history(entity_type,entity_key,observed_at,after_terms) VALUES
 ('union_clubs','k1','2026-09-01Z',jsonb_build_object('club_id','c0000000-0000-0000-0000-000000000008','union_id','a0000000-0000-0000-0000-000000000001')),
 ('union_clubs','k1','2026-10-08Z',jsonb_build_object('club_id','c0000000-0000-0000-0000-000000000008','union_id','a0000000-0000-0000-0000-000000000002')),
 ('union_clubs','k2','2026-10-06Z',jsonb_build_object('club_id','a0000000-0000-0000-0000-000000000001','union_id','a0000000-0000-0000-0000-000000000001'));
INSERT INTO accounting_rakeback_period_calculations VALUES
 ('c0000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-000000000002','2026-10-05','2026-10-11');
INSERT INTO settlement_periods VALUES
 ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z');
"""
WEEKS = [('2026-09-28 07:00Z', '2026-10-05 07:00Z'), ('2026-10-05 07:00Z', '2026-10-12 07:00Z'),
         ('2026-10-12 07:00Z', '2026-10-19 07:00Z'), ('2026-10-05 07:00Z', '2026-10-06 07:00Z'),
         ('2026-10-07 00:00Z', '2026-10-11 12:00Z'), ('2026-09-01 00:00Z', '2026-11-01 00:00Z')]
UNIONS = ['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
          'a0000000-0000-0000-0000-000000000009']


def week_clubs(fn, u, a, b):
    return run(f"SELECT COALESCE(string_agg(club_id::text,',' ORDER BY n),'') FROM (SELECT club_id,row_number() OVER () n FROM public.{fn}('{u}',NULL,'{a}','{b}')) q")


def baseline_week_clubs():
    run(FIXTURE)
    base = {}
    for u in UNIONS:
        for a, b in WEEKS:
            base[(u, a, b)] = week_clubs('fn_accounting_week_clubs', u, a, b)
    nonempty = sum(1 for v in base.values() if v)
    check('fixture-exercises-the-read', nonempty >= 8, nonempty)
    results['week_clubs_baseline'] = {f'{k[0][-1]}|{k[1]}|{k[2]}': v for k, v in base.items()}
    return base


def same_week_clubs(base):
    for (u, a, b), want in base.items():
        got = week_clubs('fn_accounting_week_clubs', u, a, b)
        check(f'same-clubs-{u[-1]}-{a[:10]}-{b[:10]}', got == want, {'before': want, 'after': got})
    # The club branch is untouched.
    for fn in ('fn_accounting_week_clubs', 'fn_accounting_week_clubs_before'):
        got = run(f"SELECT string_agg(club_id::text,',') FROM public.{fn}(NULL,'c0000000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z')")
        check('club-branch-unchanged-' + fn, got == 'c0000000-0000-0000-0000-000000000001', got)
    # Randomized rounds: new rows, old and new read side by side.
    for seed in range(5):
        run(f"""SELECT setseed(0.{seed+11});
INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)
SELECT ('c0000000-0000-0000-0000-00000000000'||(1+floor(random()*8))::int)::uuid,'a0000000-0000-0000-0000-000000000002',
 '2026-10-04Z'::timestamptz+random()*interval '9 days' FROM generate_series(1,5);
UPDATE launch_cutoffs SET cutoff=cutoff+interval '13 hours' WHERE isfinite(cutoff) AND random()<0.5;""")
        for u in UNIONS:
            for a, b in WEEKS:
                old = week_clubs('fn_accounting_week_clubs_before', u, a, b)
                new = week_clubs('fn_accounting_week_clubs', u, a, b)
                check(f'round-{seed}-{u[-1]}-{a[:10]}-{b[:10]}', old == new, {'before': old, 'after': new})


# ── 2. week clubs: kept only under the attempt's own lock ───────────────
LOCK_KEY = ("hashtextextended('union-accounting:a0000000-0000-0000-0000-000000000001:'"
            "||extract(epoch FROM '2026-10-05 07:00Z'::timestamptz)::text||':'||extract(epoch FROM '2026-10-12 07:00Z'::timestamptz)::text,0)")
ATTEMPT = """SELECT set_config('app.weekly_accounting_chunked','on',true),set_config('app.accounting_close_memo','on',true),
 set_config('app.weekly_accounting_scope_deadline',(clock_timestamp()+interval '3 minutes')::text,true);"""
CALL = "SELECT COALESCE(string_agg(club_id::text,','),'') FROM public.fn_accounting_week_clubs('a0000000-0000-0000-0000-000000000001',NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');"
NEW_CLUB = ("INSERT INTO clubs VALUES ('c0000000-0000-0000-0000-00000000000f',false);"
            "INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at) VALUES "
            "('c0000000-0000-0000-0000-00000000000f','a0000000-0000-0000-0000-000000000001','2026-10-08Z');")


def calls():
    return "SELECT count(*) FROM cutoff_calls;"


def memo_rules():
    # (a) inside an attempt that holds the week lock: read once, kept.
    r = run(f"""BEGIN;{ATTEMPT}
SELECT pg_advisory_xact_lock({LOCK_KEY});
{calls()}
{CALL}
{calls()}
{CALL}
{calls()}
SAVEPOINT s; {NEW_CLUB} {CALL} ROLLBACK TO s;
SELECT current_setting('app.accounting_week_clubs_memo',true) LIKE 'a0000000-0000-0000-0000-000000000001|%';
ROLLBACK;""").splitlines()
    n0, first, n1, second, n2, third, memo = int(r[-7]), r[-6], int(r[-5]), r[-4], int(r[-3]), r[-2], r[-1]
    check('attempt-reads-the-week-once', n1 > n0 and n2 == n1 and first == second, r)
    check('kept-answer-is-the-attempts-own', third == first and memo == 't', r)
    # (b) the same attempt settings WITHOUT the lock: read every time.
    r = run(f"""BEGIN;{ATTEMPT}
{CALL}
{calls()}
{CALL}
{calls()}
{NEW_CLUB}
{CALL}
ROLLBACK;""").splitlines()
    check('no-lock-no-keeping', int(r[-2]) > int(r[-4]) and 'c0000000-0000-0000-0000-00000000000f' in r[-1]
          and 'c0000000-0000-0000-0000-00000000000f' not in r[-5], r)
    # (c) outside an attempt, even holding the lock: read every time.
    r = run(f"""BEGIN;SELECT pg_advisory_xact_lock({LOCK_KEY});
{CALL}
{calls()}
{CALL}
{calls()}
ROLLBACK;""").splitlines()
    check('outside-an-attempt-no-keeping', int(r[-1]) > int(r[-3]), r)
    # (d) the next attempt (a new deadline) reads again and sees a new source.
    r = run(f"""BEGIN;{ATTEMPT}
SELECT pg_advisory_xact_lock({LOCK_KEY});
{CALL}
{NEW_CLUB}
{ATTEMPT}
{CALL}
ROLLBACK;""").splitlines()
    check('next-attempt-reads-again', 'c0000000-0000-0000-0000-00000000000f' not in r[-3]
          and 'c0000000-0000-0000-0000-00000000000f' in r[-1], r)
    # (e) a rolled-back subtransaction forgets what it kept.
    r = run(f"""BEGIN;{ATTEMPT}
SELECT pg_advisory_xact_lock({LOCK_KEY});
SAVEPOINT s; {CALL} ROLLBACK TO s;
SELECT 'memo='||COALESCE(current_setting('app.accounting_week_clubs_memo',true),'');
ROLLBACK;""").splitlines()
    check('rolled-back-attempt-forgets', r[-1] == 'memo=', r)
    # (f) while the attempt holds the week lock no source writer can share it.
    holder = subprocess.Popen(list(map(str, psql_args())), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, env=env)
    holder.stdin.write(f"BEGIN; SELECT pg_advisory_xact_lock({LOCK_KEY}); SELECT pg_sleep(3); ROLLBACK;\n")
    holder.stdin.flush()
    time.sleep(1.0)
    writer = run(f"SELECT pg_try_advisory_xact_lock_shared({LOCK_KEY});")
    holder.communicate(timeout=30)
    check('writer-cannot-share-the-held-week-lock', writer == 'f', writer)


# ── 3. the in-progress book owns its tick ─────────────────────────────────
TICK_STATE = f"""
TRUNCATE union_accounting_runs, weekly_accounting_scheduler_visits, visit_log, financial_alerts, gate_sleep, unions,
  union_settlement_floor, accounting_payable_earning_sources;
DELETE FROM accounting_cash_rake_sources WHERE coordinator_union_id IS NULL;
INSERT INTO clubs VALUES ('{UNION}',true),('{CLUB}',false) ON CONFLICT DO NOTHING;
INSERT INTO unions VALUES ('{UNION}');
INSERT INTO union_settlement_floor VALUES ('{UNION}',public.fn_union_week_start(now())-interval '7 days');
INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)
 VALUES ('{CLUB}',NULL,public.fn_union_week_start(now())-interval '6 days');
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,started_at,finished_at,result,last_scheduler_visit_at)
 VALUES ('{UNION}',public.fn_union_week_start(now())-interval '7 days',public.fn_union_week_start(now()),now()-interval '3 days','running',120,
  now()-interval '5 hours',now()-interval '5 hours','{{"stage":"prepared","success":false,"chunk_committed":true,"committed_round":0}}',now()-interval '5 minutes');
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at,finished_at,result,last_scheduler_visit_at)
 VALUES ('{CLUB}',public.fn_union_week_start(now())-interval '7 days',public.fn_union_week_start(now()),now()-interval '3 days','complete',11,
  now()-interval '3 days',now()-interval '3 days','{{"success":true,"accounting_version":3}}',now()-interval '7 minutes');
INSERT INTO weekly_accounting_scheduler_visits VALUES
 ('union','{UNION}',now()-interval '5 minutes','statement_timeout',
  '{{"error":"weekly_scope_statement_budget_exhausted","success":false,"sqlstate":"57014","statement_timeout":"4min"}}',29),
 ('club','{CLUB}',now()-interval '7 minutes','visited',NULL,0);
"""


def tick(timeout='30s'):
    zone = tick_zone()
    r = run(f"""SET TimeZone='{zone}';
SELECT set_config('statement_timeout','{timeout}',false),set_config('app.weekly_accounting_attempt_budget','1',false),
 set_config('app.weekly_accounting_scope_budget','3 minutes',false),set_config('app.weekly_accounting_chunked','on',false);
TRUNCATE visit_log;
CREATE TEMP TABLE tick_out AS SELECT public.fn_process_weekly_accounting_scope(NULL,NULL) AS result;
SELECT jsonb_build_object('result',(SELECT result FROM tick_out),
 'order',(SELECT COALESCE(string_agg(kind,',' ORDER BY n),'') FROM visit_log))::text;""").splitlines()
    got = json.loads(r[-1])
    return got['result'], got['order']


def visit(kind):
    return json.loads(run(f"SELECT to_jsonb(v) FROM weekly_accounting_scheduler_visits v WHERE v.scope_kind='{kind}'"))


def starvation_on_the_preimage():
    run(TICK_STATE)
    res, order = tick()
    check('preimage-visits-the-club-before-the-in-progress-union', order == 'club,union', {'order': order, 'result': res})


def in_progress_book_first():
    run(TICK_STATE)
    res, order = tick()
    check('in-progress-union-goes-first-and-ends-the-tick', order == 'union' and res.get('more_remaining') is True,
          {'order': order, 'result': res})
    check('its-visit-is-recorded-as-finished', visit('union')['last_outcome'] == 'visited', visit('union'))
    res, order = tick()
    check('it-keeps-the-tick-while-in-progress', order == 'union', order)
    # Its own first-place visit is cancelled: it says so, and gives the place back once.
    run(f"INSERT INTO gate_sleep VALUES ('{UNION}',4)")
    res, order = tick('2s')
    v = visit('union')
    # The cancelled visit's own writes (its visit_log row too) roll back with it.
    check('a-cancelled-first-place-visit-is-marked', order == '' and v['last_outcome'] == 'statement_timeout'
          and v['last_error'].get('in_progress_visit') is True, {'order': order, 'visit': v})
    run('TRUNCATE gate_sleep')
    res, order = tick()
    check('it-gives-the-place-back-for-one-tick', order == 'club,union', {'order': order, 'result': res})
    check('the-normal-visit-clears-the-mark', visit('union')['last_outcome'] == 'visited', visit('union'))
    res, order = tick()
    check('and-takes-it-again-the-tick-after', order == 'union', order)
    # A visit that was cancelled behind another scope is not the book's fault.
    run(f"UPDATE weekly_accounting_scheduler_visits SET last_outcome='statement_timeout',last_error='{{\"error\":\"weekly_scope_statement_budget_exhausted\"}}' WHERE scope_kind='union'")
    res, order = tick()
    check('a-starved-timeout-keeps-the-place', order == 'union', order)


def unchanged_without_a_book_in_progress():
    run(TICK_STATE)
    run(f"UPDATE union_accounting_runs SET status='failed',result='{{\"success\":false,\"error\":\"x\"}}' WHERE union_id='{UNION}'")
    res, order = tick()
    check('no-book-in-progress-same-order-as-before', order == 'club,union', {'order': order, 'result': res})
    run(TICK_STATE)
    run(f"UPDATE weekly_accounting_scheduler_visits SET last_outcome='visited',last_error=NULL,last_visit_at=now()-interval '9 minutes' WHERE scope_kind='union'")
    run(f"UPDATE union_accounting_runs SET status='complete',result='{{\"success\":true}}',last_scheduler_visit_at=now()-interval '9 minutes' WHERE union_id='{UNION}'")
    res, order = tick()
    check('finished-scopes-keep-oldest-first', order.startswith('union') and 'club' in order, order)


def after_the_completion_read():
    # The candidate also installs on top of 20261015234926 when that lands first.
    if not COMPLETION.exists():
        results['completion_parent'] = 'not in this tree; its postimage md5 is pinned in the candidate'
        check('candidate-accepts-the-completion-postimage', COMPLETION_POST in CANDIDATE.read_text()
              and SCOPE_POST_AFTER_COMPLETION in CANDIDATE.read_text())
        return
    sig = 'public.fn_process_weekly_accounting_scope(uuid,uuid)'
    run(PARENT['scope'] + ";\nREVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;")
    check('scope-restored-to-window-advance-text', md5_of(sig) == SCOPE_WINDOWS)
    run('SET search_path=public;\n' + block(COMPLETION, 'DO $install$', 'END $install$;'))
    check('completion-read-installed', md5_of(sig) == COMPLETION_POST, md5_of(sig))
    blocks = re.findall(r'DO \$install\$.*?END \$install\$;', CANDIDATE.read_text(), re.S)
    run('SET search_path=public;\n' + blocks[1])
    check('scope-postimage-after-completion-read', md5_of(sig) == SCOPE_POST_AFTER_COMPLETION, md5_of(sig))
    in_progress_book_first()


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    load_preimages()
    base = baseline_week_clubs()
    starvation_on_the_preimage()
    install_candidate()
    same_week_clubs(base)
    memo_rules()
    in_progress_book_first()
    unchanged_without_a_book_in_progress()
    after_the_completion_read()
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'failed': [c['name'] for c in results['checks'] if not c['passed']]}))
