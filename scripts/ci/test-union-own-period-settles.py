"""Isolated PostgreSQL regression: the union's own square-up period settles with its week.

fn_union_settlement_cascade settles the week's periods (fn_mark_scope_accounting_settled)
BEFORE round 4, and round 4 (fn_union_issue_weekly_invoices) then opens a
'processing' period for every club it bills that has none, the union's own club
row (clubs.id = union id) included. A week whose own-club period is first opened
by the closing attempt therefore closes 'complete' with that one period left
'processing' for ever (production: cc6c056b, week of 2026-09-28).

The test loads the EXACT production definitions of the cascade and the settler
captured 2026-10-08 (their pg_get_functiondef md5 equals production's), with
every other callee stubbed to the success contract the cascade checks, and a
square-up stub that opens periods exactly as the live issuer does (only when
missing, as 'processing'). It proves the live order strands the own-club period,
then applies the candidate migration and proves:
  * it reproduces production's derived postimage md5;
  * the stranded week (cc6c056b) is settled by its own path and nothing else moves;
  * a fresh close now leaves every period of the week settled;
  * a second run refuses on the pinned preimage.
An empty throwaway cluster on a Unix socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import re
import runpy
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
FIXTURES = ROOT / 'scripts' / 'ci' / 'fixtures' / 'union-own-period-settles'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/union-own-period-settles')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='union-own-period-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55823'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 read on production 2026-10-08, before and after the
# candidate (the postimage derived read-only with replace() over the same bytes).
CASCADE_SIG = 'public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)'
MARK_SIG = 'public.fn_mark_scope_accounting_settled(text,uuid,timestamp with time zone,timestamp with time zone)'
LIVE_CASCADE_MD5 = '818ec0b8e917e4da8d0d876664dd3114'
POST_CASCADE_MD5 = '1f19fa0bf96efa7dfe07ca9bbd831f0b'
LIVE_MARK_MD5 = '147202a7a519e0188d711016abc0a059'

UNION = 'fade0000-0000-0000-0000-000000000001'
MEMBERS = ['a0000000-0000-0000-0000-000000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4']
STRANDED = 'cc6c056b-5814-4e44-84c4-9aa841b8f246'
# A later closed week for the end-to-end close (Monday 00:00 America/Los_Angeles).
WEEK_FROM, WEEK_TO = '2026-10-05 07:00:00+00', '2026-10-12 07:00:00+00'


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


def one(glob):
    found = sorted(MIGRATIONS.glob(glob))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {glob}, found {len(found)}')
    return found[0]


SCHEMA = f"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE
  SET search_path TO 'pg_catalog', 'public', 'auth' AS $$ SELECT COALESCE(auth.role(), 'service_role') = 'service_role' $$;
-- The production week boundaries, verbatim.
CREATE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS
$$ SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles')) AT TIME ZONE 'America/Los_Angeles' $$;
CREATE FUNCTION public.fn_union_prev_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS
$$ SELECT (date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles')) - interval '7 days') AT TIME ZONE 'America/Los_Angeles' $$;

CREATE TABLE public.settlement_periods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, union_id uuid,
  period_number integer, year integer, start_at timestamptz, end_at timestamptz,
  status text CHECK (status IN ('open','processing','settled','disputed','closed')),
  settled_at timestamptz, settled_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.settlement_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, period_id uuid,
  invoice_type text, breakdown jsonb, message_sent boolean, status text);
CREATE TABLE public.union_accounting_runs(scope_kind text, scope_id uuid, union_id uuid, period_start timestamptz,
  period_end timestamptz, status text);
CREATE TABLE public.settlement_locks(lock_type text, is_active boolean);
CREATE TABLE public.union_settlement_floor(union_id uuid, earliest_period_start timestamptz);
CREATE TABLE public.union_rake_rollup_days(union_id uuid, day date);
CREATE TABLE public.rakeback_periods(club_id uuid, status text, rakeback_amount numeric, period_start date, period_end date);
CREATE TABLE public.union_settlement_rounds(union_id uuid, period_start timestamptz, period_end timestamptz, round_no integer,
  round_name text, payers integer, payees integer, amount numeric, shortfalls integer, detail jsonb,
  UNIQUE (union_id, period_start, period_end, round_no));
CREATE TABLE public.accounting_routed_settlement_runs(scope_kind text, scope_id uuid, union_id uuid, period_start timestamptz,
  period_end timestamptz, round_no integer, result jsonb);

-- Every callee the cascade does not test here answers with the contract it checks.
CREATE FUNCTION public.fn_is_union_overseer(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.fn_union_rake_rollup_refresh_day(uuid, date) RETURNS void LANGUAGE sql AS $$ $$;
CREATE FUNCTION public.fn_union_pnl_closed_book_barrier(timestamptz) RETURNS void LANGUAGE sql AS $$ $$;
CREATE FUNCTION public.fn_assert_cash_commission_period(uuid, uuid, timestamptz, timestamptz) RETURNS void LANGUAGE sql AS $$ $$;
CREATE FUNCTION public.fn_prepare_accounting_week(uuid, uuid, timestamptz, timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{{"success":true}}'::jsonb $$;
CREATE FUNCTION public.fn_weekly_accounting_deadline_check() RETURNS void LANGUAGE sql AS $$ $$;
CREATE FUNCTION public.fn_union_weekly_rakeback_close(uuid, timestamptz, timestamptz) RETURNS jsonb LANGUAGE sql AS
$$ SELECT '{{"success":true,"clubs_paid":2,"total_rakeback":0,"period_rake":0}}'::jsonb $$;
CREATE FUNCTION public.fn_accounting_week_clubs(p_union uuid, p_club uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE sql AS $$ SELECT unnest(ARRAY['{MEMBERS[0]}'::uuid, '{MEMBERS[1]}'::uuid]) $$;
CREATE FUNCTION public.ca_test_round(p_union uuid, p_from timestamptz, p_to timestamptz, p_round integer) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v jsonb := jsonb_build_object('round', p_round, 'routing_version', 3, 'source_version', 2,
  'amount', 0, 'payees', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
BEGIN
  INSERT INTO public.accounting_routed_settlement_runs VALUES ('union', p_union, p_union, p_from, p_to, p_round, v);
  RETURN v;
END $$;
CREATE FUNCTION public.fn_settle_round2_club_to_agents(p uuid, f timestamptz, t timestamptz) RETURNS jsonb LANGUAGE sql AS
$$ SELECT public.ca_test_round(p, f, t, 2) $$;
CREATE FUNCTION public.fn_settle_round3_agents_to_players(p uuid, f timestamptz, t timestamptz) RETURNS jsonb LANGUAGE sql AS
$$ SELECT public.ca_test_round(p, f, t, 3) $$;
CREATE FUNCTION public.fn_union_settlement_conservation_assert(uuid, timestamptz, timestamptz, jsonb, jsonb, jsonb) RETURNS void
LANGUAGE sql AS $$ $$;
CREATE FUNCTION public.fn_union_pnl_qualified_clubs(uuid, timestamptz, timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{{}}'::jsonb $$;
CREATE FUNCTION public.fn_union_eco_record(uuid, timestamptz, timestamptz, uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{{}}'::jsonb $$;
CREATE FUNCTION public.fn_union_setting(uuid, text, integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
-- The square-up, as the live fn_union_issue_weekly_invoices opens its periods:
-- for every club it bills (the members AND the union's own club row), reuse the
-- week's period or INSERT one as 'processing', then deliver the document.
CREATE FUNCTION public.fn_union_issue_weekly_invoices(p_union_id uuid, v_from timestamptz, v_to timestamptz, p_send boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; v_period_id uuid; n integer := 0;
BEGIN
  FOR r IN SELECT c.club_id FROM public.fn_accounting_week_clubs(p_union_id, NULL, v_from, v_to) c
           UNION ALL SELECT p_union_id LOOP
    SELECT sp.id INTO v_period_id FROM settlement_periods sp
     WHERE sp.club_id = r.club_id AND sp.union_id = p_union_id AND sp.start_at = v_from AND sp.end_at = v_to
     ORDER BY sp.created_at DESC LIMIT 1;
    IF v_period_id IS NULL THEN
      INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
      VALUES (r.club_id, p_union_id, EXTRACT(week FROM v_from)::int, EXTRACT(isoyear FROM v_from)::int,
              v_from, v_to, 'processing')
      RETURNING id INTO v_period_id;
    END IF;
    INSERT INTO settlement_invoices (club_id, period_id, invoice_type, breakdown, message_sent, status)
    VALUES (r.club_id, v_period_id, 'union_weekly_squareup',
            jsonb_build_object('union_id', p_union_id, 'period_start', v_from, 'period_end', v_to), true, 'generated');
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'invoices', n);
END $$;
CREATE FUNCTION public.fn_generate_scope_credit_invoices(uuid, timestamptz, timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{{"success":true}}'::jsonb $$;
CREATE FUNCTION public.fn_issue_club_weekly_accounting(uuid, timestamptz, timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{{"success":true}}'::jsonb $$;
CREATE FUNCTION public.fn_union_close_post_rake_debit(jsonb) RETURNS TABLE(rw_after numeric, cb_after numeric) LANGUAGE sql AS $$ SELECT 0::numeric, 0::numeric $$;
"""

# Production's grants (read 2026-10-08: proacl {{postgres=X/postgres}} on both).
GRANTS = f"""
REVOKE ALL ON FUNCTION {CASCADE_SIG.replace('timestamp with time zone', 'timestamptz')} FROM PUBLIC;
REVOKE ALL ON FUNCTION {MARK_SIG.replace('timestamp with time zone', 'timestamptz')} FROM PUBLIC;
"""


def md5_of(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def close_week():
    return json.loads(run(f"SELECT public.fn_union_settlement_cascade('{UNION}', '{WEEK_FROM}', '{WEEK_TO}')"))


def week_periods():
    rows = run(f"""SELECT COALESCE(club_id::text, 'union-level') || '=' || status FROM settlement_periods
                    WHERE union_id = '{UNION}' AND start_at = '{WEEK_FROM}' AND end_at = '{WEEK_TO}'
                    ORDER BY 1""")
    return dict(r.split('=') for r in rows.splitlines() if r)


def reset():
    run('TRUNCATE settlement_periods, settlement_invoices, union_accounting_runs, union_settlement_rounds, '
        'accounting_routed_settlement_runs;')


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10 "
                        "-c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off",
                        '-w', 'start'])
    run(SCHEMA)

    # -- Baseline: the exact production definitions before this change ----------
    run((FIXTURES / 'fn_mark_scope_accounting_settled.live-20261008.sql').read_text() + ';'
        + (FIXTURES / 'fn_union_settlement_cascade.live-20261008.sql').read_text() + ';' + GRANTS)
    check('baseline-cascade-is-production-preimage', md5_of(CASCADE_SIG) == LIVE_CASCADE_MD5, md5_of(CASCADE_SIG))
    check('baseline-settler-is-production-preimage', md5_of(MARK_SIG) == LIVE_MARK_MD5, md5_of(MARK_SIG))
    r = close_week()
    p = week_periods()
    results['baseline'] = {'cascade_success': r.get('success'), 'periods': p}
    check('baseline-close-reports-success', r.get('success') is True, r)
    check('baseline-members-and-union-level-settled',
          all(p.get(k) == 'settled' for k in MEMBERS + ['union-level']), p)
    # The defect, reproduced: the square-up opened the union's own club row
    # after the settler ran, and the week closed with it still 'processing'.
    check('baseline-strands-the-union-own-period', p.get(UNION) == 'processing', p)

    # -- The production state the migration's section 2 closes -------------------
    reset()
    run(f"""
      INSERT INTO settlement_periods(id, club_id, union_id, start_at, end_at, status, settled_at)
      VALUES ('{STRANDED}', '{UNION}', '{UNION}', '2026-09-28 07:00+00', '2026-10-05 07:00+00', 'processing', NULL),
             ('11836f4c-a97a-40cb-90b7-ab5d47553e86', '{MEMBERS[0]}', '{UNION}', '2026-09-28 07:00+00', '2026-10-05 07:00+00', 'settled', '2026-10-07 21:35:00.23612+00'),
             ('ba1ec7c9-acbe-48d6-8fee-6cec540a7e10', '{MEMBERS[1]}', '{UNION}', '2026-09-28 07:00+00', '2026-10-05 07:00+00', 'settled', '2026-10-07 21:35:00.23612+00'),
             ('1480d486-0c0f-4416-b6fb-7143d68450c8', NULL, '{UNION}', '2026-09-28 07:00+00', '2026-10-05 07:00+00', 'settled', '2026-10-07 21:35:00.23612+00'),
             ('747205e9-ec0a-4474-979d-cd5710dac54a', '{UNION}', '{UNION}', '2026-09-21 07:00+00', '2026-09-28 07:00+00', 'closed', '2026-10-03 03:31:17.142505+00');
      INSERT INTO union_accounting_runs VALUES ('union', '{UNION}', '{UNION}', '2026-09-28 07:00+00', '2026-10-05 07:00+00', 'complete');
    """)
    before = run("SELECT string_agg(id || ':' || status || ':' || COALESCE(settled_at::text, ''), ',' ORDER BY id) "
                 f"FROM settlement_periods WHERE id <> '{STRANDED}'")

    # -- Candidate: the migration under test, applied as production would --------
    candidate = one('*_the_union_s_own_square_up_period_settles_with_its_week.sql')
    migration = candidate.read_text()
    check('candidate-is-one-transaction',
          len(re.findall(r'^BEGIN;', migration, re.M)) == 1 and len(re.findall(r'^COMMIT;', migration, re.M)) == 1)
    run(migration)
    check('candidate-reproduces-production-derived-postimage', md5_of(CASCADE_SIG) == POST_CASCADE_MD5, md5_of(CASCADE_SIG))
    check('candidate-leaves-the-settler-alone', md5_of(MARK_SIG) == LIVE_MARK_MD5)
    check('stranded-week-is-settled-by-its-own-path',
          run(f"SELECT status FROM settlement_periods WHERE id = '{STRANDED}'") == 'settled')
    after = run("SELECT string_agg(id || ':' || status || ':' || COALESCE(settled_at::text, ''), ',' ORDER BY id) "
                f"FROM settlement_periods WHERE id <> '{STRANDED}'")
    check('no-other-period-moved', before == after, {'before': before, 'after': after})
    check('grants-unchanged',
          run(f"SELECT proacl::text FROM pg_proc WHERE oid = '{CASCADE_SIG}'::regprocedure") == '{postgres=X/postgres}')

    reset()
    r = close_week()
    p = week_periods()
    results['candidate'] = {'cascade_success': r.get('success'), 'periods': p}
    check('candidate-close-reports-success', r.get('success') is True, r)
    check('candidate-settles-the-union-own-period', p.get(UNION) == 'settled', p)
    check('candidate-settles-every-period-of-the-week',
          sorted(p) == sorted(MEMBERS + [UNION, 'union-level']) and set(p.values()) == {'settled'}, p)
    check('candidate-replays-without-change', close_week().get('success') is True and week_periods() == p)

    replay = subprocess.run(list(map(str, psql)), input=migration, text=True, capture_output=True, env=env, timeout=60)
    check('migration-refuses-a-second-run',
          replay.returncode != 0 and 'is not the pinned text' in replay.stderr, replay.stderr[-300:])
    check('second-run-left-the-postimage', md5_of(CASCADE_SIG) == POST_CASCADE_MD5)
    runpy.run_path(str(FIXTURES / 'weekly-close-admission.py'))['exercise'](run, check, one, FIXTURES)
finally:
    if (cluster / 'data' / 'postmaster.pid').exists():
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster, ignore_errors=True)
    results['owned_cluster_removed'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2, default=str) + '\n')
print(json.dumps({'passed': len(results['checks']), 'baseline': results.get('baseline'),
                  'candidate': results.get('candidate'), 'output': str(out / 'RESULTS.json')}))
