"""Isolated PostgreSQL regression: the open-week basis stamps its own union's clubs.

fn_union_rake_basis_windowed reuses each closed two-hour window of the open
week while its input stamp is unchanged. Part of the stamp was
fn_accounting_clubs_scope_digest(), an md5 over every club on the platform, so
each certification club created or removed anywhere (148 in the 24 hours to
2026-10-16 10:50 UTC) made every window of every union stale. The whole week
was recomputed every hour, the refresh ran out of the union-integrity sweep's
time (fn_union_rake_basis_refresh out_of_time, 2026-10-16 02:35) and the
snapshot stopped refreshing.

The test loads production's exact text of fn_union_rake_basis_windowed (its
pg_get_functiondef md5 must equal production's) over stand-in tables and a
stand-in window plan that counts its calls. On the live text a club created
outside the union makes the next call recompute every closed window. After the
migration (which must reproduce production's derived postimage md5) the same
event recomputes none, a club joining the union still recomputes them all, and
a second run of the migration refuses. An empty throwaway cluster on a Unix
socket; no network, no production connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261016104931_the_open_week_basis_stamps_its_own_unions_clubs.sql'
FIXTURE = ROOT / 'scripts/ci/fixtures/the-open-week-basis-stamps-its-own-unions-clubs/fn_union_rake_basis_windowed.live-20261016.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/the-open-week-basis-stamps-its-own-unions-clubs')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='open-week-basis-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55835'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

SIG = 'public.fn_union_rake_basis_windowed(uuid,timestamp with time zone,timestamp with time zone)'
# pg_get_functiondef md5 read on production 2026-10-16, and the postimage
# derived read-only on production with replace().
LIVE_MD5 = '2c2bbb252ef5d119bc6e9813bcc9354b'
POST_MD5 = 'a68ecf97f457970970e97518d378e70c'


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    r = subprocess.run(list(map(str, psql)), input=sql, text=True, capture_output=True, env=env, timeout=60)
    return r.returncode, (r.stdout + r.stderr).strip()


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY, is_union boolean, union_id uuid);
CREATE TABLE accounting_cash_accrual_cutover(singleton boolean PRIMARY KEY, starts_at timestamptz);
CREATE TABLE ca_settlements(settlement_type text, union_id uuid, state text, external_ref text, totals jsonb);
CREATE TABLE union_wallet_transactions(union_id uuid, wallet text, direction text, tx_type text,
  created_at timestamptz, amount numeric);
CREATE TABLE accounting_cash_bank_receipts(union_id uuid, banked_at timestamptz);
CREATE TABLE accounting_tournament_fee_recognitions(union_id uuid, recognized_at timestamptz);
CREATE TABLE accounting_tournament_recognized_sources(recognized_at timestamptz);
CREATE TABLE accounting_cash_accrual_batches(earned_at timestamptz);
CREATE TABLE accounting_agreement_history(id bigint, observed_at timestamptz);
CREATE TABLE union_rake_basis_windows(union_id uuid, period_start timestamptz, window_start timestamptz,
  window_end timestamptz, input_stamp jsonb, value jsonb, compute_ms integer, computed_at timestamptz,
  PRIMARY KEY (union_id, period_start, window_start));
CREATE TABLE plan_calls(window_start timestamptz);
-- Production's definitions of the two helpers it calls.
CREATE FUNCTION public.fn_accounting_clubs_scope_digest() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $f$
 SELECT md5(COALESCE(string_agg(c.id::text||'|'||COALESCE(c.is_union::text,'null')||'|'||COALESCE(c.union_id::text,'null'),',' ORDER BY c.id),''))
   FROM public.clubs c
$f$;
CREATE FUNCTION public.fn_accounting_close_windows(p_start timestamptz, p_end timestamptz)
RETURNS TABLE(window_start timestamptz, window_end timestamptz) LANGUAGE sql STABLE SET search_path TO 'public' AS $f$
 SELECT g, LEAST(g+interval '2 hours', p_end)
   FROM generate_series(p_start, p_end-interval '1 microsecond', interval '2 hours') g
  WHERE p_start<p_end AND isfinite(p_start) AND isfinite(p_end)
$f$;
-- A stand-in for the window plan that records each window it is asked for.
CREATE FUNCTION public.fn_accounting_union_earned_plan_window(p_union uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea) LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO plan_calls VALUES (p_start);
  RETURN QUERY SELECT jsonb_build_object('bank_sum', 0, 'source_sum', 0, 'basis', '[]'::jsonb),
                      NULL::uuid[], NULL::bytea, NULL::uuid[], NULL::bytea;
END $f$;
"""

UNION = '00000000-0000-0000-0000-0000000000f1'
MEMBER = '00000000-0000-0000-0000-0000000000a1'


def basis():
    run('TRUNCATE plan_calls')
    status = run(f"SELECT fn_union_rake_basis_windowed('{UNION}', date_trunc('hour', now()) - interval '10 hours', now())->>'status'")
    computed = int(run('SELECT count(*) FROM plan_calls'))
    return status, computed


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FIXTURE.read_text() + ';')
    run(f"REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {SIG} TO service_role;")
    got = run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")
    check("the fixture is production's exact text", got == LIVE_MD5, got)
    run(f"""
INSERT INTO accounting_cash_accrual_cutover VALUES (true, now() - interval '30 days');
INSERT INTO clubs VALUES ('{UNION}', true, NULL), ('{MEMBER}', false, '{UNION}');
""")
    status, first = basis()
    check('the first read computes every window of the period', status == 'ready' and first >= 5, (status, first))
    status, again = basis()
    check('an unchanged period reuses every closed window', again == 1, again)

    run("INSERT INTO clubs VALUES (gen_random_uuid(), false, NULL)")
    status, live = basis()
    check('on the live text, a club created outside the union recomputes every window', live == first, (live, first))

    code, text = attempt(MIGRATION.read_text())
    check('the migration installs', code == 0, text[-800:])
    got = run(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")
    check("the function reads back as production's derived postimage", got == POST_MD5, got)
    meta = run(f"SELECT pg_get_userbyid(proowner) || '|' || proacl::text || '|' || proconfig::text FROM pg_proc "
               f"WHERE oid = '{SIG}'::regprocedure")
    check('owner, grants and settings did not move',
          meta == 'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public}', meta)

    status, settle = basis()
    check('the first read after the change restamps the period', settle == first, settle)
    run("INSERT INTO clubs VALUES (gen_random_uuid(), false, NULL)")
    status, after = basis()
    check('a club created outside the union now recomputes only the open window', after == 1, after)
    run(f"INSERT INTO clubs VALUES (gen_random_uuid(), false, '{UNION}')")
    status, joined = basis()
    check('a club joining the union still recomputes every window', joined == first, (joined, first))

    code, text = attempt(MIGRATION.read_text())
    check('a second run of the migration refuses on the moved preimage', code != 0 and 'not the pinned text' in text,
          text[-300:])
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
