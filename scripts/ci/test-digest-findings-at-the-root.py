"""Isolated PostgreSQL regression for three daily digest findings, fixed at
their root rather than at the digest.

1. A new account's empty wallet is not frozen (migration 20261016103946).
   Signup inserts a PLAYER wallet with balance 0 and locked_balance 0. The
   wallets freeze guard refused it inside the hourly break, the signup
   trigger logged PLATFORM_FROZEN to signup_errors, and the account never got
   a wallet (DailyDigest.signup_errors). The guard already exempts a
   zero-chip club_members INSERT as identity, not money; the fix gives a
   zero wallets INSERT the same exemption and refuses everything else as
   before.

2. The digest counts real crashes and failed deploys (migration
   20261016104001). Its 'crashes' read counted the auth flow's own failure
   reports (a wrong password, an unconfirmed email) as app crashes, and its
   'deploys' read counted a release superseded by a newer merge as a failed
   deploy (DailyDigest.client_crash and DailyDigest.deploy_failed).

Each function is loaded from its exact production text (pg_get_functiondef
md5 equal to production's), proved to show the defect, then the candidate
migration is applied and the outcome proved, with the postimage md5 equal to
production's derived postimage and a second install refused. An empty
throwaway cluster on a Unix socket; no network, no production connection.
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
WALLET_MIGRATION = MIGRATIONS / '20261016103946_a_new_account_s_empty_wallet_is_not_frozen.sql'
DIGEST_MIGRATION = MIGRATIONS / '20261016104001_the_digest_counts_real_crashes_and_failed_deploys.sql'
# The live fn_sp_daily_metrics_compute is the text of this migration exactly
# (its pg_get_functiondef md5 equals production's, checked below).
DIGEST_SOURCE = MIGRATIONS / '20261016100458_sp_daily_digest_standalone_rake_and_club_ranking.sql'
FREEZE_FIXTURE = ROOT / 'scripts' / 'ci' / 'fixtures' / 'digest-findings-at-the-root' / 'fn_refuse_while_frozen.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/digest-findings-at-the-root')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='digest-findings-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55831'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of the production functions read 2026-10-16, before
# and after each candidate (postimages derived read-only on production).
FREEZE_SIG = 'public.fn_refuse_while_frozen()'
FREEZE_LIVE_MD5 = '3a866372172806a8a69cc3d37413f0cc'
FREEZE_POST_MD5 = 'e70516150fcc4edb9ad1033263b6df25'
DIGEST_SIG = 'public.fn_sp_daily_metrics_compute(date)'
DIGEST_LIVE_MD5 = 'ba689a29f14e0e922969645550f8e9e6'
DIGEST_POST_MD5 = '52002b51df42c6c7d2d3a0d6ced7fd9c'
ACL = '{postgres=X/postgres,service_role=X/postgres}'

SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.engine_freeze(frozen boolean NOT NULL);
INSERT INTO public.engine_freeze VALUES (true);
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT frozen FROM public.engine_freeze $$;
CREATE FUNCTION public.fn_freeze_bypass_active() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE public.wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, wallet_type text,
  balance numeric DEFAULT 0, locked_balance numeric DEFAULT 0, updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(), UNIQUE (user_id, wallet_type));
CREATE TABLE public.club_members(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, chip_balance numeric DEFAULT 0);
CREATE TABLE public.client_crash_log(id bigserial, created_at timestamptz, boundary text, section text, error_name text);
CREATE TABLE public.ca_engine_deploy_attempts(id bigserial, at timestamptz, shipped boolean, reason text);
"""
TRIGGERS = """
REVOKE ALL ON FUNCTION public.fn_refuse_while_frozen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_refuse_while_frozen() TO service_role;
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('balance');
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance');
"""
DIGEST_GRANTS = """
REVOKE ALL ON FUNCTION public.fn_sp_daily_metrics_compute(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_sp_daily_metrics_compute(date) TO service_role;
"""
# The Oct 15 rows the digest read, as production holds them.
DIGEST_ROWS = """
INSERT INTO public.client_crash_log(created_at, boundary, section, error_name) VALUES
  ('2026-10-16 02:11:40+00', 'auth', 'login_form_submit', 'invalid_credentials'),
  ('2026-10-16 02:32:42+00', 'auth', 'login_form_submit', 'email_not_confirmed'),
  ('2026-10-16 03:00:00+00', 'page', 'club-arena-probe:delivery-verification', 'Probe'),
  ('2026-10-16 03:30:00+00', 'page', 'table', 'TypeError');
INSERT INTO public.ca_engine_deploy_attempts(at, shipped, reason) VALUES
  ('2026-10-15 06:03:47+00', false, 'stood down before cutover; protected main had moved to 655469f9ba192ccb766b666b53710c9b248de784'),
  ('2026-10-15 06:04:27+00', false, 'stood down before cutover; protected main had moved to 655469f9ba192ccb766b666b53710c9b248de784'),
  ('2026-10-15 06:10:00+00', true, 'Hetzner transaction sealed and independently verified'),
  ('2026-10-15 07:10:00+00', false, 'the durable Hetzner release transaction did not complete; production still runs the previously sealed release'),
  ('2026-10-15 08:10:00+00', true, 'production already proved this exact release');
"""
S, E = '2026-10-15 05:00:00+00', '2026-10-16 05:00:00+00'


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def run(sql):
    return command(psql, sql)


def check(name, passed, detail=None):
    results['checks'].append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(f'{name}: {detail}')


def attempt(sql):
    """'ok' or the SQLSTATE the statement was refused with."""
    try:
        run(sql)
        return 'ok'
    except RuntimeError as e:
        m = re.search(r'PLATFORM_FROZEN', str(e))
        return '55006' if m else str(e)[:200]


def md5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def acl(sig):
    return run(f"SELECT proacl::text FROM pg_proc WHERE oid = '{sig}'::regprocedure")


def freeze_outcomes():
    # Thaw to reset and seed the one funded wallet, then freeze.
    run('UPDATE public.engine_freeze SET frozen = false;')
    run('DELETE FROM public.wallets; DELETE FROM public.club_members;')
    run("INSERT INTO public.wallets(user_id, wallet_type, balance) VALUES ('00000000-0000-0000-0000-0000000000aa', 'PLAYER', 10);")
    run('UPDATE public.engine_freeze SET frozen = true;')
    return {
        'signup_wallet': attempt("INSERT INTO public.wallets(user_id, wallet_type, balance, locked_balance) "
                                 "VALUES ('00000000-0000-0000-0000-000000000001', 'PLAYER', 0, 0)"),
        'signup_wallet_defaults': attempt("INSERT INTO public.wallets(user_id, wallet_type) "
                                          "VALUES ('00000000-0000-0000-0000-000000000002', 'PLAYER')"),
        'funded_wallet': attempt("INSERT INTO public.wallets(user_id, wallet_type, balance) "
                                 "VALUES ('00000000-0000-0000-0000-000000000003', 'PLAYER', 5)"),
        'locked_wallet': attempt("INSERT INTO public.wallets(user_id, wallet_type, locked_balance) "
                                 "VALUES ('00000000-0000-0000-0000-000000000004', 'PLAYER', 5)"),
        'balance_update': attempt("UPDATE public.wallets SET balance = balance + 1 "
                                  "WHERE user_id = '00000000-0000-0000-0000-0000000000aa'"),
        'wallet_delete': attempt("DELETE FROM public.wallets WHERE user_id = '00000000-0000-0000-0000-0000000000aa'"),
        'empty_membership': attempt("INSERT INTO public.club_members(user_id) VALUES ('00000000-0000-0000-0000-000000000005')"),
        'funded_membership': attempt("INSERT INTO public.club_members(user_id, chip_balance) "
                                     "VALUES ('00000000-0000-0000-0000-000000000006', 5)"),
    }


def metric(defn, key, next_key):
    """Evaluate one metric's subquery, exactly as the function text has it."""
    m = re.search(r"'" + key + r"', (\(.*?\)),\n(?:\s*--[^\n]*\n)*\s*'" + next_key + "'", defn, re.S)
    if not m:
        raise ValueError(f'{key} not found in the function text')
    return run(f"WITH w AS (SELECT timestamptz '{S}' AS s, timestamptz '{E}' AS e) SELECT {m.group(1)} FROM w")


def digest_outcomes():
    defn = run(f"SELECT pg_get_functiondef('{DIGEST_SIG}'::regprocedure)")
    return {'crashes': metric(defn, 'crashes', 'signup_errors'),
            'deploys': metric(defn, 'deploys', 'alerts_new')}


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    if not DIGEST_SOURCE.exists():
        raise RuntimeError(f'{DIGEST_SOURCE.name} (the live digest text, PR #7077) is not on this tree')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(FREEZE_FIXTURE.read_text() + ';' + TRIGGERS)
    digest_def = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_sp_daily_metrics_compute\(.*?\$fn\$;',
                           DIGEST_SOURCE.read_text(), re.S).group(0)
    # The function reads tables this cluster does not have; its body is not
    # executed here, only its two metric subqueries are.
    run('SET check_function_bodies = off;\n' + digest_def + DIGEST_GRANTS + DIGEST_ROWS)

    # 1. The freeze guard.
    check('freeze-baseline-is-production-preimage', md5(FREEZE_SIG) == FREEZE_LIVE_MD5)
    before = freeze_outcomes()
    results['freeze_before'] = before
    check('freeze-baseline-refuses-the-signup-wallet', before['signup_wallet'] == '55006', before)
    run(WALLET_MIGRATION.read_text())
    check('freeze-postimage-is-production-derived-postimage', md5(FREEZE_SIG) == FREEZE_POST_MD5)
    check('freeze-grants-unchanged', acl(FREEZE_SIG) == ACL)
    after = freeze_outcomes()
    results['freeze_after'] = after
    expected = {'signup_wallet': 'ok', 'signup_wallet_defaults': 'ok', 'funded_wallet': '55006',
                'locked_wallet': '55006', 'balance_update': '55006', 'wallet_delete': '55006',
                'empty_membership': 'ok', 'funded_membership': '55006'}
    for k, want in expected.items():
        check(f'freeze-{k}-is-{want}', after[k] == want, after)

    # 2. The digest metrics.
    check('digest-baseline-is-production-preimage', md5(DIGEST_SIG) == DIGEST_LIVE_MD5)
    before = digest_outcomes()
    results['digest_before'] = before
    check('digest-baseline-counts-auth-reports-and-probes-as-crashes', before['crashes'] == '4', before)
    check('digest-baseline-counts-superseded-releases-as-failed',
          json.loads(before['deploys']) == {'attempted': 5, 'shipped': 2}, before)
    run(DIGEST_MIGRATION.read_text())
    check('digest-postimage-is-production-derived-postimage', md5(DIGEST_SIG) == DIGEST_POST_MD5)
    check('digest-grants-unchanged', acl(DIGEST_SIG) == ACL)
    after = digest_outcomes()
    results['digest_after'] = after
    check('digest-counts-only-the-render-crash', after['crashes'] == '1', after)
    check('digest-counts-the-real-failed-deploy-only',
          json.loads(after['deploys']) == {'attempted': 3, 'shipped': 2}, after)

    # A second install of either is refused by its pinned preimage.
    for name, path in (('freeze', WALLET_MIGRATION), ('digest', DIGEST_MIGRATION)):
        try:
            run(path.read_text())
            check(f'{name}-reinstall-is-refused', False, 'second install succeeded')
        except RuntimeError as e:
            check(f'{name}-reinstall-is-refused', 'is not the pinned text' in str(e), str(e)[:200])
    results['passed'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps(results, indent=2))
