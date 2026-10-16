"""Isolated PostgreSQL regression: the club messenger welcome triggers are declared.

UndeclaredTriggerOnAMoneyTable paged from 04:06 UTC on 2026-10-16: migration
20261016033645, pushed to production outside this repository, created two
triggers on club_members (capture_club_messenger_admission and the deferred
deliver_club_messenger_welcome) without declaring them in
ca_declared_money_triggers. They move no money; the declaration was missing.

The test loads production's exact fn_undeclared_money_triggers (its
pg_get_functiondef md5 must equal production's) over a stand-in club_members
and register, and the two triggers with production's definitions. On the live
register both are undeclared. After the migration neither is, an unrelated
undeclared trigger is still reported, a second run is harmless, and the
migration refuses when a trigger of that name is bound to some other function.
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
MIGRATION = ROOT / 'supabase/migrations/20261016104521_the_club_messenger_welcome_triggers_are_declared.sql'
FIXTURE = ROOT / 'scripts/ci/fixtures/the-club-messenger-welcome-triggers-are-declared/fn_undeclared_money_triggers.live-20261016.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/the-club-messenger-welcome-triggers-are-declared')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='messenger-triggers-declared-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55834'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

# pg_get_functiondef md5 of fn_undeclared_money_triggers read on production 2026-10-16.
LIVE_MD5 = '7144e0c30692affb47c0ccaa4ad3f011'


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
CREATE TABLE ca_declared_money_triggers(table_name text NOT NULL, trigger_name text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(), note text, PRIMARY KEY (table_name, trigger_name));
CREATE TABLE club_members(club_id uuid, user_id uuid, status text, is_active boolean,
  membership_lifecycle_status text, agent_id uuid, chip_balance numeric);
CREATE FUNCTION public.fn_capture_club_messenger_admission() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NEW; END $f$;
CREATE FUNCTION public.fn_deliver_club_messenger_welcome() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NEW; END $f$;
CREATE FUNCTION public.fn_some_other_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NEW; END $f$;
-- Production's definitions, verbatim from pg_get_triggerdef.
CREATE TRIGGER capture_club_messenger_admission AFTER INSERT OR UPDATE OF status, is_active, membership_lifecycle_status, agent_id ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_capture_club_messenger_admission();
CREATE CONSTRAINT TRIGGER deliver_club_messenger_welcome AFTER INSERT OR UPDATE OF status, is_active, membership_lifecycle_status, agent_id ON public.club_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_deliver_club_messenger_welcome();
CREATE TRIGGER an_unreviewed_guard BEFORE UPDATE OF chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_some_other_guard();
"""


def undeclared():
    return run("SELECT COALESCE(string_agg(trigger_name, ',' ORDER BY trigger_name), '') "
               "FROM public.fn_undeclared_money_triggers()")


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
    got = run("SELECT md5(pg_get_functiondef('public.fn_undeclared_money_triggers()'::regprocedure))")
    check("the fixture is production's exact detector text", got == LIVE_MD5, got)

    before = undeclared()
    check('on the live register both welcome triggers are undeclared',
          before == 'an_unreviewed_guard,capture_club_messenger_admission,deliver_club_messenger_welcome', before)

    code, text = attempt(MIGRATION.read_text())
    check('the migration installs', code == 0, text[-800:])
    after = undeclared()
    check('neither welcome trigger is undeclared, and an unreviewed one still is', after == 'an_unreviewed_guard', after)
    notes = run("SELECT count(*) FROM ca_declared_money_triggers WHERE note LIKE '%writes no money table%'")
    check('each declaration says what it does', notes == '2', notes)

    code, text = attempt(MIGRATION.read_text())
    check('a second run is harmless', code == 0 and undeclared() == 'an_unreviewed_guard', text[-300:])

    run("DELETE FROM ca_declared_money_triggers; DROP TRIGGER capture_club_messenger_admission ON club_members; "
        "CREATE TRIGGER capture_club_messenger_admission AFTER INSERT ON public.club_members "
        "FOR EACH ROW EXECUTE FUNCTION fn_some_other_guard();")
    code, text = attempt(MIGRATION.read_text())
    check('a trigger of that name bound to another function is refused, not declared',
          code != 0 and 'not the reviewed trigger' in text, text[-300:])
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
