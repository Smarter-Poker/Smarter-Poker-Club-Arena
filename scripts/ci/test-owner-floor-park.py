"""Isolated PostgreSQL regression: an owner floor park is not an outage.

Migration 20261015222118. On 2026-10-15 an owner-renewed floor park
(operation 3d9c1ba1) paged as an outage: the floor-hold watchdog raised a
CRITICAL alert because the hold was ten minutes old, TournamentNeverStarted
counted two MTTs the park refused to start, the Spin gauges counted boards the
park refused to start, and after the resume the watchdog alert stayed open
because nine closes named tables that no longer exist.

The test loads the exact production definitions captured on 2026-10-15
(their pg_get_functiondef md5 equals production's; the watchdog comes from
migration 20261014231111 itself and is checked against production's md5),
proves the defects on that baseline, applies the candidate migration, and
proves:
  * an MTT, a Spin board and an unfilled Spin the park holds are not counted,
    the same rows in a club outside the park are, and all of them count again
    the moment the hold row is gone;
  * the watchdog does not page a renewed hold inside its lease and its
    ceiling, does page a lease that ran out unrenewed (and releases it), and
    does page a hold renewed past its ceiling;
  * the watchdog alert resolves once the floor is back even if a close names
    a deleted table, and still does not resolve while an existing table is
    refused;
  * fn_ca_operator_floor_park_share() reports the share of the cash floor the
    hold refuses (scoped, unscoped, none);
  * every function reproduces production's derived postimage md5.
An empty throwaway cluster on a Unix socket; no network, no production
connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'owner-floor-park'
LEASE = MIGRATIONS / '20261014231111_a_floor_park_is_a_lease_that_expires_and_pages_never_a_switc.sql'
CANDIDATE = MIGRATIONS / '20261015222118_an_owner_floor_park_is_not_an_outage.sql'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/owner-floor-park')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='owner-floor-park-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5, production, read 2026-10-15 (before / derived after).
PRE = {
    'public.fn_tournament_metrics(integer,integer,integer)': '31e04dd645cb7605b968ecd17d992d27',
    'public.fn_spin_metrics(integer)': '7e92b1acfd7b86b557a464c6f4e00a6f',
    'public.fn_spin_fill_waits()': '854aa5e365a23d4a0e18636d158c86b1',
    'public.fn_ca_operator_floor_hold_page_after()': 'c6db5997e05882d94d12be245ff05dda',
    'public.fn_ca_operator_floor_hold_watchdog()': '9f8b378e6a8cf3a340fe9c007e680e8a',
    'public.fn_ca_launch_cash_close_resumed(uuid,uuid)': '8948d10e8ef84c52d8391cb62fb5bfb7',
}
POST = {
    'public.fn_tournament_metrics(integer,integer,integer)': '26e08b560250346a619faeb3bc1353af',
    'public.fn_spin_metrics(integer)': 'c3eec000c70e31cfcc3c38b8bac998fe',
    'public.fn_spin_fill_waits()': '48c2dd2b931210349e412ea139a8a16a',
    'public.fn_ca_operator_floor_hold_page_after()': '3a43a57ded6d67fdbf6f6db9b67bff7e',
    'public.fn_ca_operator_floor_hold_watchdog()': 'a75ce8a90eaf1bbf6f6b28187233628e',
}

C1 = '00000000-0000-0000-0000-0000000000c1'   # parked club
C2 = '00000000-0000-0000-0000-0000000000c2'   # club outside the park
ACTOR = '00000000-0000-0000-0000-0000000000a1'
PARK = '00000000-0000-0000-0000-00000000aa01'
CLOSE = '00000000-0000-0000-0000-00000000aa02'
RESUME = '00000000-0000-0000-0000-00000000aa03'

SCHEMA = f'''
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role', true) $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS
  $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS
  $$ DELETE FROM cron.job WHERE jobname = n RETURNING true $$;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY, club_id uuid, union_id uuid, tournament_id uuid, status text,
  is_deleted boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE public.table_seats (table_id uuid, user_id uuid, joined_at timestamptz DEFAULT now(), left_at timestamptz);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, variant text, buy_in_amount numeric, buy_in_fee numeric, start_time timestamptz,
  status text, max_players integer, updated_at timestamptz DEFAULT now(), club_id uuid, started_at timestamptz,
  ended_at timestamptz, prize_pool numeric, tournament_type text, union_id uuid, spin_multiplier numeric,
  spin_reveal_lag_ms integer);
CREATE TABLE public.tournament_players (tournament_id uuid, user_id uuid, status text, chips numeric);
CREATE TABLE public.wallet_transactions (related_entity_id uuid, amount numeric, type text, category text);
CREATE TABLE public.poker_diamond_tournament_ledger (tournament_id uuid, kind text, wallet_journal_id uuid);
CREATE TABLE public.tournament_satellite_awards (tournament_id uuid, place integer);
CREATE TABLE public.spin_reserve_ledger (tournament_id uuid, amount numeric, kind text);
CREATE VIEW public.v_spin_draw_fairness AS
  SELECT '24h'::text AS window_label, 0::bigint AS draws, NULL::numeric AS realised_e, NULL::numeric AS spec_e,
         NULL::numeric AS z, false AS drift, 0::bigint AS constrained_draws;
CREATE VIEW public.v_spin_reserve_health AS SELECT NULL::uuid AS club_id, false AS is_thin, 0::numeric AS balance WHERE false;
CREATE VIEW public.v_tournament_rake_attribution_gaps AS SELECT 1 AS x WHERE false;
CREATE VIEW public.v_spin_unfilled_waits AS SELECT 1 AS x WHERE false;
CREATE FUNCTION public.fn_spin_reserve_owner(uuid) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT $1 $$;
CREATE FUNCTION public.fn_spin_unpaid_settlements(integer) RETURNS TABLE(chips_short numeric)
  LANGUAGE sql STABLE AS $$ SELECT 0::numeric WHERE false $$;

CREATE TABLE public.ca_operator_floor_hold (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), operation_id uuid NOT NULL, mode text NOT NULL, reason text NOT NULL);
CREATE TABLE public.ca_launch_operator_scopes (
  operation_id uuid PRIMARY KEY, actor_id uuid NOT NULL, club_ids uuid[] NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.ca_engine_operator_commands (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL, domain text NOT NULL, action text NOT NULL, reason text NOT NULL,
  status text NOT NULL, announced_at timestamptz, result jsonb, end_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.ca_operator_table_closes (
  table_id uuid NOT NULL, operation_id uuid NOT NULL, actor_id uuid NOT NULL, reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending', PRIMARY KEY (table_id, operation_id));
CREATE TABLE public.ca_launch_floor_resume_receipts (
  table_id uuid NOT NULL, close_operation_id uuid NOT NULL, park_operation_id uuid NOT NULL,
  resume_operation_id uuid NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, close_operation_id));
CREATE TABLE public.financial_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, severity text NOT NULL, source text NOT NULL, message text NOT NULL,
  context jsonb DEFAULT '{{}}'::jsonb, resolved boolean NOT NULL DEFAULT false, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_by uuid, resolution text);
CREATE TABLE public.admin_audit_log (action text, target_id text, details jsonb);
CREATE FUNCTION public.fn_log_admin_action(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO public.admin_audit_log VALUES ($2, $4, $5) $$;
'''


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));")


def counts():
    tm = run('SELECT overdue_start FROM public.fn_tournament_metrics(10, 10, 6);')
    sm = run('SELECT open_boards FROM public.fn_spin_metrics(60);')
    fw = run('SELECT unfilled_past_window FROM public.fn_spin_fill_waits();')
    return int(tm), int(sm), int(fw)


def watchdog():
    return json.loads(run('SELECT public.fn_ca_operator_floor_hold_watchdog()::text;'))


def open_alerts():
    return json.loads(run("SELECT coalesce(json_agg(json_build_object('op', context->>'operation_id', "
                          "'reason', context->>'page_reason', 'message', message)), '[]') "
                          "FROM public.financial_alerts WHERE NOT resolved;"))


def park(scoped=True, held_minutes=0, expires_in_minutes=60):
    run(f'''
DELETE FROM public.ca_operator_floor_hold;
INSERT INTO public.ca_engine_operator_commands (id, actor_id, domain, action, reason, status)
VALUES ('{PARK}', '{ACTOR}', 'floor', 'park', 'Owner park for the regression', 'accepted') ON CONFLICT DO NOTHING;
{"INSERT INTO public.ca_launch_operator_scopes VALUES ('" + PARK + "', '" + ACTOR + "', ARRAY['" + C1 + "']::uuid[]) ON CONFLICT DO NOTHING;" if scoped else "DELETE FROM public.ca_launch_operator_scopes WHERE operation_id = '" + PARK + "';"}
INSERT INTO public.ca_operator_floor_hold (operation_id, mode, reason) VALUES ('{PARK}', 'park', 'Owner park');
UPDATE public.ca_operator_floor_hold
   SET held_since = clock_timestamp() - interval '{held_minutes} minutes',
       expires_at = clock_timestamp() + interval '{expires_in_minutes} minutes';
''')


def unpark():
    run('DELETE FROM public.ca_operator_floor_hold; DELETE FROM public.financial_alerts;')


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    for f in ['fn_ca_launch_cash_close_resumed', 'fn_tournament_metrics', 'fn_spin_metrics', 'fn_spin_fill_waits']:
        run((FIXTURES / f'{f}.sql').read_text())
    run(LEASE.read_text())
    for sig, want in PRE.items():
        check(f'baseline {sig} is the production text', md5(sig) == want, md5(sig))

    # Rows: an overdue MTT, an open Spin board and a 1-of-3 Spin whose window
    # closed, once in the parked club and once outside it.
    run(f'''
INSERT INTO public.tournaments (id, variant, tournament_type, status, start_time, club_id, max_players) VALUES
  ('00000000-0000-0000-0000-000000000101', 'nlh',  'MTT',  'REGISTERING', now() - interval '20 minutes', '{C1}', 9),
  ('00000000-0000-0000-0000-000000000102', 'nlh',  'MTT',  'REGISTERING', now() - interval '20 minutes', '{C2}', 9),
  ('00000000-0000-0000-0000-000000000201', 'spin', 'SPIN', 'REGISTERING', now() - interval '5 minutes',  '{C1}', 3),
  ('00000000-0000-0000-0000-000000000202', 'spin', 'SPIN', 'REGISTERING', now() - interval '5 minutes',  '{C2}', 3);
INSERT INTO public.tables (id, tournament_id, status) VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'waiting'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', 'waiting');
INSERT INTO public.table_seats (table_id, user_id) VALUES
  ('00000000-0000-0000-0000-000000000301', gen_random_uuid()),
  ('00000000-0000-0000-0000-000000000302', gen_random_uuid());
-- The cash floor: three open tables in the parked club, one outside it, one
-- in the parked club closed by an operator close not yet resumed.
INSERT INTO public.tables (id, club_id, status) VALUES
  ('00000000-0000-0000-0000-000000000401', '{C1}', 'running'),
  ('00000000-0000-0000-0000-000000000402', '{C1}', 'waiting'),
  ('00000000-0000-0000-0000-000000000403', '{C2}', 'running'),
  ('00000000-0000-0000-0000-000000000404', '{C1}', 'closed');
INSERT INTO public.ca_engine_operator_commands (id, actor_id, domain, action, reason, status)
VALUES ('{CLOSE}', '{ACTOR}', 'floor', 'close_cash', 'Owner close for the regression', 'completed');
INSERT INTO public.ca_launch_operator_scopes VALUES ('{CLOSE}', '{ACTOR}', ARRAY['{C1}']::uuid[]);
INSERT INTO public.ca_operator_table_closes (table_id, operation_id, actor_id, reason, status)
VALUES ('00000000-0000-0000-0000-000000000404', '{CLOSE}', '{ACTOR}', 'Owner close', 'closed');
''')

    # ── Baseline: the defects, on production's own text ──────────────────
    park(held_minutes=20, expires_in_minutes=40)
    check('baseline counts a parked MTT, board and unfilled Spin', counts() == (2, 2, 2), counts())
    watchdog()
    check('baseline pages a renewed hold inside its lease', len(open_alerts()) == 1, open_alerts())
    unpark()

    run(CANDIDATE.read_text())
    for sig, want in POST.items():
        check(f'{sig} reproduces the derived postimage', md5(sig) == want, md5(sig))

    # ── 2. the reads leave out what the park holds, and only that ─────────
    park(held_minutes=20, expires_in_minutes=40)
    check('a parked MTT, board and unfilled Spin are held, the unparked club still counts', counts() == (1, 1, 1), counts())
    run("UPDATE public.ca_operator_floor_hold SET mode = 'pause';")
    check('a pause refuses no start, so nothing is held', counts() == (2, 2, 2), counts())
    unpark()
    check('the moment the hold is gone every row counts again', counts() == (2, 2, 2), counts())

    # ── 3. the share ──────────────────────────────────────────────────────
    park()
    share = json.loads(run('SELECT public.fn_ca_operator_floor_park_share()::text;'))
    check('a scoped park refuses 3 of the 4 floor tables', share['held'] and share['share'] == 0.75
          and share['floor_tables'] == 4 and share['held_tables'] == 3, share)
    park(scoped=False)
    share = json.loads(run('SELECT public.fn_ca_operator_floor_park_share()::text;'))
    check('an unscoped park refuses the whole floor', share['share'] == 1 and not share['scoped'], share)
    unpark()
    share = json.loads(run('SELECT public.fn_ca_operator_floor_park_share()::text;'))
    check('no hold, no share', share == {'held': False, 'share': 0}, share)

    # ── 4. the watchdog pages a hold nobody keeps, not a kept one ─────────
    park(held_minutes=77, expires_in_minutes=43)
    r = watchdog()
    check('a renewed hold inside its lease and ceiling pages nobody', r['raised'] == 0 and open_alerts() == [], [r, open_alerts()])
    check('and is not released', r['released'] is False, r)
    unpark()

    park(held_minutes=200, expires_in_minutes=30)
    r = watchdog()
    alerts = open_alerts()
    check('a hold renewed past its ceiling pages once', r['raised'] == 1 and len(alerts) == 1
          and alerts[0]['reason'] == 'held_past_ceiling' and 'renewed past its ceiling' in alerts[0]['message'], alerts)
    r = watchdog()
    check('and only once', r['raised'] == 0 and len(open_alerts()) == 1, r)
    unpark()

    park(held_minutes=61, expires_in_minutes=-1)
    r = watchdog()
    fa = json.loads(run("SELECT json_agg(json_build_object('reason', context->>'page_reason', 'message', message)) "
                        "FROM public.financial_alerts;"))
    check('a lease that ran out unrenewed pages', r['raised'] == 1 and fa and fa[0]['reason'] == 'lease_expired_unrenewed'
          and 'Nobody renewed or resumed' in fa[0]['message'], [r, fa])
    check('and is released in the same pass', r['released'] is True
          and run('SELECT count(*) FROM public.ca_operator_floor_hold;') == '0', r)

    # ── 4b. the alert resolves when no EXISTING table is still refused ────
    # (no earlier auto-release on record, so (c) writes no late receipt here)
    run('DELETE FROM public.financial_alerts; DELETE FROM public.ca_launch_floor_resume_receipts; '
        'DELETE FROM public.ca_operator_floor_hold_releases;')
    park(held_minutes=200, expires_in_minutes=30)
    watchdog()
    run(f'''
DELETE FROM public.ca_operator_floor_hold;
INSERT INTO public.ca_engine_operator_commands (id, actor_id, domain, action, reason, status)
VALUES ('{RESUME}', '{ACTOR}', 'floor', 'resume', 'Owner resume for the regression', 'accepted');
INSERT INTO public.ca_launch_operator_scopes VALUES ('{RESUME}', '{ACTOR}', ARRAY['{C1}']::uuid[]);
-- a close whose table is gone, as nine were on 2026-10-15
INSERT INTO public.ca_operator_table_closes (table_id, operation_id, actor_id, reason, status)
VALUES ('00000000-0000-0000-0000-0000000004ff', '{CLOSE}', '{ACTOR}', 'Owner close', 'closed');
''')
    r = watchdog()
    check('an existing table still refused keeps the alert open', len(open_alerts()) == 1, [r, open_alerts()])
    run(f'''INSERT INTO public.ca_launch_floor_resume_receipts
              (table_id, close_operation_id, park_operation_id, resume_operation_id, actor_id)
            VALUES ('00000000-0000-0000-0000-000000000404', '{CLOSE}', '{PARK}', '{RESUME}', '{ACTOR}');''')
    r = watchdog()
    check('a close of a deleted table does not hold the alert open', r['resolved'] == 1 and open_alerts() == [], [r, open_alerts()])

    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)
print(json.dumps({'passed': results.get('passed', False), 'checks': len(results['checks'])}))
