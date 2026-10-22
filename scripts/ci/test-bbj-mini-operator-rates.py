#!/usr/bin/env python3
"""Qualify the mini jackpot operator-rate read in an isolated native PostgreSQL.

No production connection and no money command. Installs the predecessor
fn_bbj_mini_for_club exactly as 20261015042155 wrote it, seeds two pools (one
never reset, one with an executed launch reset in the middle of its 7-day
window, plus unrelated pools' rows that must never be counted), and records
the full returned row for an operator, a plain member and an anonymous caller
of every club. Then applies 20261022041710 through its own preimage guard and
requires every row to be identical. Finally the operator plan must read
bbj_contributions through its (pool_id, created_at) index with the reset
start as an index bound, and must not touch the reporting view.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / 'supabase/migrations/20261015042155_the_mini_jackpot_read_answers_players_in_milliseconds.sql'
NEW = ROOT / 'supabase/migrations/20261022041710_the_mini_jackpot_operator_rates_read_contributions_by_pool_i.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--port', default=os.environ.get('PG_PORT', '55441'))
args = parser.parse_args()
pg = Path(args.pg_bin)
base = Path(tempfile.mkdtemp(prefix='bbj-mini-rates-', dir=os.environ.get('RUNNER_TEMP')))
data, sock = base / 'data', base / 'sock'
sock.mkdir()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False


def run(argv, sql=None):
    r = subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=180)
    if r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def q(sql):
    return run([pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', args.port,
                '-U', 'postgres', '-d', 'postgres'], sql)


def predecessor():
    sql = OLD.read_text()
    start = sql.index('CREATE OR REPLACE FUNCTION public.fn_bbj_mini_for_club')
    end = sql.index('$function$;', start) + len('$function$;')
    return sql[start:end]


SCHEMA = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid);
CREATE TABLE public.club_members (club_id uuid, user_id uuid, role text, status text);
CREATE TABLE public.bbj_pools (id uuid PRIMARY KEY, club_id uuid, union_id uuid, backup_balance numeric,
  mini_reserve_floor numeric, mini_enabled boolean);
CREATE TABLE public.bbj_contributions (id bigserial PRIMARY KEY, pool_id uuid, club_id uuid, table_id uuid,
  hand_number bigint, amount numeric, big_blind numeric, stakes_tier text, created_at timestamptz,
  main_portion numeric, backup_portion numeric, promo_portion numeric, hand_id uuid);
CREATE INDEX idx_bbj_contrib_pool_created ON public.bbj_contributions (pool_id, created_at) INCLUDE (backup_portion);
CREATE TABLE public.bbj_winners (id bigserial PRIMARY KEY, club_id uuid, pool_id uuid, loser_id uuid, winner_id uuid,
  loser_hand text, winner_hand text, loser_payout numeric, winner_payout numeric, table_share_payout numeric,
  total_payout numeric, pool_amount_at_hit numeric, stakes_tier text, table_id uuid, hand_number bigint,
  awarded_at timestamptz, winner_display_name text, loser_display_name text, kind text);
CREATE TABLE public.bbj_stakes_tiers (id text PRIMARY KEY, label text, blind_range text, min_bb numeric, max_bb numeric);
CREATE TABLE public.bbj_mini_tiers (tier_id text PRIMARY KEY, amount numeric, enabled boolean);
CREATE TABLE public.ca_launch_reset_operations (operation_id uuid PRIMARY KEY, state text, captured_at timestamptz);
CREATE TABLE public.ca_launch_reset_rows (operation_id uuid, relation_name text, row_key jsonb);
CREATE FUNCTION public.fn_bbj_pool_for_club(p_club uuid)
 RETURNS TABLE(pool_id uuid, backup_balance numeric, is_union_pool boolean) LANGUAGE sql STABLE AS $$
  SELECT p.id, p.backup_balance, p.union_id IS NOT NULL FROM public.clubs c JOIN public.bbj_pools p
    ON (c.union_id IS NOT NULL AND p.union_id = c.union_id) OR (c.union_id IS NULL AND p.club_id = c.id)
   WHERE c.id = p_club $$;
CREATE FUNCTION public.fn_bbj_parked_reserve(p uuid, k text) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 125.5::numeric $$;
CREATE FUNCTION public.fn_is_club_admin_uid(p_club_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
    AND cm.role IN ('owner','co_owner','admin','manager') AND COALESCE(cm.status,'active') = 'active') $$;
CREATE FUNCTION public.fn_ca_launch_bbj_reporting_start(p_pool uuid) RETURNS timestamptz LANGUAGE sql STABLE
 SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
 SELECT coalesce(max(o.captured_at),'-infinity'::timestamptz)
 FROM public.ca_launch_reset_operations o
 JOIN public.ca_launch_reset_rows r ON r.operation_id=o.operation_id
 WHERE o.state='executed' AND r.relation_name='bbj_pools'
 AND r.row_key=jsonb_build_object('id',p_pool); $$;
CREATE VIEW public.ca_launch_bbj_reporting_contributions WITH (security_invoker = true) AS
 WITH starts AS (SELECT r.row_key, max(o.captured_at) AS s FROM public.ca_launch_reset_operations o
   JOIN public.ca_launch_reset_rows r ON r.operation_id = o.operation_id
  WHERE o.state = 'executed' AND r.relation_name = 'bbj_pools' GROUP BY r.row_key)
 SELECT c.* FROM public.bbj_contributions c LEFT JOIN starts st ON st.row_key = jsonb_build_object('id', c.pool_id)
  WHERE c.created_at >= COALESCE(st.s, '-infinity'::timestamptz);
CREATE VIEW public.ca_launch_bbj_reporting_winners WITH (security_invoker = true) AS
 WITH starts AS (SELECT r.row_key, max(o.captured_at) AS s FROM public.ca_launch_reset_operations o
   JOIN public.ca_launch_reset_rows r ON r.operation_id = o.operation_id
  WHERE o.state = 'executed' AND r.relation_name = 'bbj_pools' GROUP BY r.row_key)
 SELECT w.* FROM public.bbj_winners w LEFT JOIN starts st ON st.row_key = jsonb_build_object('id', w.pool_id)
  WHERE w.awarded_at >= COALESCE(st.s, '-infinity'::timestamptz);
"""


def u(n):
    return '00000000-0000-4000-8000-' + str(n).zfill(12)


# Fixed fixture time so both definitions see the same now(): every read below
# runs inside one transaction with now() pinned by the transaction start.
SEED = f"""
INSERT INTO public.bbj_stakes_tiers VALUES ('nano','Nano','0.05/0.10',0.01,0.20),('mid','Mid','2/4',3.01,8.00),('high','High','5/10',8.01,40);
INSERT INTO public.bbj_mini_tiers VALUES ('nano',250,true),('mid',950,true),('high',1200,false);
-- union U (pool P1, never reset), club 3 standalone (pool P2, reset 2.5 days ago), club 4 standalone (pool P3, untouched noise)
INSERT INTO public.clubs VALUES ('{u(1)}','{u(90)}'),('{u(2)}','{u(90)}'),('{u(3)}',NULL),('{u(4)}',NULL);
INSERT INTO public.bbj_pools VALUES ('{u(11)}',NULL,'{u(90)}',30058.64,5000,true),
  ('{u(12)}','{u(3)}',NULL,900.10,0,true),('{u(13)}','{u(4)}',NULL,50000,1500,false);
INSERT INTO public.club_members VALUES ('{u(1)}','{u(101)}','owner','active'),('{u(1)}','{u(102)}','member','active'),
  ('{u(2)}','{u(103)}','admin','active'),('{u(3)}','{u(104)}','owner','active'),('{u(3)}','{u(105)}','manager','suspended'),
  ('{u(4)}','{u(106)}','owner','active');
INSERT INTO public.ca_launch_reset_operations VALUES ('{u(201)}','executed', now() - interval '2.5 days'),
  ('{u(202)}','planned', now() - interval '1 day'), ('{u(203)}','executed', now() - interval '6 days');
INSERT INTO public.ca_launch_reset_rows VALUES ('{u(201)}','bbj_pools',jsonb_build_object('id','{u(12)}'::uuid)),
  ('{u(202)}','bbj_pools',jsonb_build_object('id','{u(11)}'::uuid)),
  ('{u(203)}','bbj_pools',jsonb_build_object('id','{u(12)}'::uuid)),
  ('{u(201)}','clubs',jsonb_build_object('id','{u(11)}'::uuid));
INSERT INTO public.bbj_contributions (pool_id, club_id, created_at, amount, backup_portion)
 SELECT (ARRAY['{u(11)}','{u(12)}','{u(13)}'])[1 + g % 3]::uuid, NULL,
        now() - (g * interval '37 seconds'), 1, round(((g % 97) * 0.0137)::numeric, 4)
   FROM generate_series(1, 60000) g;
INSERT INTO public.bbj_winners (pool_id, kind, total_payout, awarded_at)
 SELECT (ARRAY['{u(11)}','{u(12)}','{u(13)}'])[1 + g % 3]::uuid, CASE WHEN g % 4 = 0 THEN 'main' ELSE 'mini' END,
        100 + g, now() - (g * interval '9 hours') FROM generate_series(1, 120) g;
ANALYZE;
"""

CALLERS = [(u(1), u(101)), (u(1), u(102)), (u(1), None), (u(2), u(103)), (u(2), u(101)),
           (u(3), u(104)), (u(3), u(105)), (u(3), None), (u(4), u(106)), (u(4), None), (u(99), u(101))]


def snapshot():
    """Both definitions, every caller, ONE transaction: now() is identical."""
    parts = []
    for club, user in CALLERS:
        sub = repr(user or '')
        for fn in ('fn_bbj_mini_for_club_before', 'fn_bbj_mini_for_club'):
            parts.append(
                f"SELECT set_config('request.jwt.claim.sub', {sub}, true);"
                f"SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM public.{fn}('{club}') r;")
    out = q("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE authenticated;"
            + ''.join(parts) + "ROLLBACK;")
    rows = [json.loads(line) for line in out.splitlines() if line.startswith('[')]
    assert len(rows) == 2 * len(CALLERS), out
    return [(rows[2 * i], rows[2 * i + 1]) for i in range(len(CALLERS))]


try:
    run([pg / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
    run([pg / 'pg_ctl', '-D', data, '-w', '-l', base / 'server.log', '-o', f"-k {sock} -p {args.port} -c listen_addresses=''", 'start'])
    started = True
    q(SCHEMA)
    old = predecessor()
    q(old + "\nREVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;"
      "\nGRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;")
    md5 = q("SELECT md5(pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure))")
    assert md5 == '83308728ca2f8033dbf967a1f485f09b', 'fixture predecessor is not the production definition: ' + md5
    # The predecessor stays installed under a second name so both are read in
    # one snapshot with one now().
    q(old.replace('public.fn_bbj_mini_for_club(', 'public.fn_bbj_mini_for_club_before(', 1)
      + "\nGRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club_before(uuid) TO authenticated;")
    q(SEED)
    q(NEW.read_text())
    first = snapshot()
    q(NEW.read_text())  # replay: the guard accepts its own definition
    replay = snapshot()

    ops = [b for b, _ in first if b and b[0]['is_operator']]
    assert len(ops) >= 4, first
    assert all(r[0]['in_per_day'] not in (None, 0) for r in ops), ops
    assert any(float(r[0]['window_days']) < 7 for r in ops), 'the reset pool must exercise a short window'
    assert any(float(r[0]['out_per_day']) > 0 for r in ops), ops
    for c, (b, a), (b2, a2) in zip(CALLERS, first, replay):
        assert b == a, f'{c}: before {b}\nafter {a}'
        assert b2 == a2, f'{c} replay: before {b2}\nafter {a2}'
        for row in a:
            if not row['is_operator']:
                for k in ('in_per_day', 'out_per_day', 'net_per_day', 'floor_minimum', 'window_days', 'days_to_floor'):
                    assert row[k] is None, (c, k, row)

    definition = q("SELECT pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure)")
    assert 'ca_launch_bbj_reporting_contributions' not in definition
    assert 'ca_launch_bbj_reporting_winners' not in definition
    acl = q("SELECT proacl::text FROM pg_proc WHERE oid='public.fn_bbj_mini_for_club(uuid)'::regprocedure")
    assert 'anon' not in acl and 'authenticated=X' in acl and 'service_role=X' in acl, acl
    flags = q("SELECT prosecdef::text||provolatile::text FROM pg_proc WHERE oid='public.fn_bbj_mini_for_club(uuid)'::regprocedure")
    assert flags == 'trues', flags

    # The operator income sum reads the pool's index range, bounded by the
    # reset start, with no join, hash or sort of contribution rows.
    plan = q("EXPLAIN (COSTS OFF) WITH pool AS (SELECT p.pool_id, "
             "public.fn_ca_launch_bbj_reporting_start(p.pool_id) AS start_at FROM public.fn_bbj_pool_for_club('"
             + u(3) + "') p) SELECT (SELECT sum(x.backup_portion) FROM public.bbj_contributions x "
             "WHERE x.pool_id = pool.pool_id AND x.created_at >= pool.start_at "
             "AND x.created_at > now() - interval '7 days') FROM pool")
    cond = re.search(r'Index (?:Only )?Scan (?:using|on) idx_bbj_contrib_pool_created\s+Index Cond: ([^\n]*)', plan)
    assert cond and 'pool_id =' in cond.group(1) and 'fn_ca_launch_bbj_reporting_start' in cond.group(1), plan
    assert 'Hash' not in plan and 'Sort' not in plan and 'jsonb_build_object' not in plan, plan
    print(json.dumps({'callers': len(CALLERS), 'operatorRows': len(ops), 'identical': True}))
finally:
    if started:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'], env=env, capture_output=True)
    shutil.rmtree(base, ignore_errors=True)
