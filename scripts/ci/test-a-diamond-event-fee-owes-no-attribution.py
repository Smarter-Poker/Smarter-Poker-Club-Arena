"""Isolated PostgreSQL regression: a Diamond event's fee owes no attribution.

RakeAttributionBacklog counts v_tournament_rake_attribution_gaps: settled
tournament fees with amount > 0 that credited nobody. On 2026-10-16 every one
of its 107 rows was a Diamond Arena event: fn_settle_tournament_rake's Diamond
Phase 8 branch sends a Diamond event's fee to the house (destination
'diamond_house') and records attributed_users = 0 on purpose, because VIP
points, rakeback basis and commission are chip accounting. The view counted a
fee that owes nobody as a fee that credited nobody, so the alarm rose with every
Diamond event.

The test builds the view from production's exact text (its pg_get_viewdef md5
must equal production's), over stand-in tables. A Diamond house fee and a chip
fee that credited nobody both count on the live text. After the migration the
Diamond fee does not count, the chip fee still does, an attributed chip fee
still does not, the grants and security_invoker are unchanged, and a second run
of the migration refuses. An empty throwaway cluster on a Unix socket; no
network, no production connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261016104032_a_diamond_event_fee_owes_no_attribution.sql'
FIXTURE = ROOT / 'scripts/ci/fixtures/a-diamond-event-fee-owes-no-attribution/v_tournament_rake_attribution_gaps.live-20261016.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/a-diamond-event-fee-owes-no-attribution')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='diamond-fee-attribution-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55833'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

VIEW = 'public.v_tournament_rake_attribution_gaps'
# pg_get_viewdef md5 read on production 2026-10-16.
LIVE_MD5 = '316450d4ce44fa135965716cce6ab8e4'


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


def defmd5(sig):
    return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments(id uuid PRIMARY KEY, tournament_type text, variant text, name text, buy_in_amount numeric);
CREATE TABLE tournament_rake_settlements(tournament_id uuid PRIMARY KEY, club_id uuid, amount numeric,
  destination text, source text, settled_at timestamptz, attributed_at timestamptz, attributed_users integer,
  attribution_error text);
"""

DIAMOND = '00000000-0000-0000-0000-0000000000d1'
CHIP_NOBODY = '00000000-0000-0000-0000-0000000000c1'
CHIP_PAID = '00000000-0000-0000-0000-0000000000c2'


def view_ids():
    return run(f"SELECT COALESCE(string_agg(right(tournament_id::text, 2) || ':' || verdict, ',' "
               f"ORDER BY tournament_id), '') FROM {VIEW}")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    run(f"CREATE VIEW {VIEW} WITH (security_invoker = true) AS {FIXTURE.read_text()};"
        f"REVOKE ALL ON {VIEW} FROM PUBLIC; GRANT ALL ON {VIEW} TO service_role;")
    got = run(f"SELECT md5(pg_get_viewdef('{VIEW}'::regclass))")
    check("the fixture is production's exact view text", got == LIVE_MD5, got)
    run(f"""
INSERT INTO tournaments VALUES
  ('{DIAMOND}', 'MTT', 'bounty', 'Diamond Bounty Hunt', 900),
  ('{CHIP_NOBODY}', 'MTT', 'freezeout', 'Chip Event', 10),
  ('{CHIP_PAID}', 'MTT', 'freezeout', 'Chip Event Two', 10);
INSERT INTO tournament_rake_settlements VALUES
  ('{DIAMOND}', NULL, 2400, 'diamond_house', 'engine.fn_complete_tournament_terminal', now(), now(), 0, NULL),
  ('{CHIP_NOBODY}', NULL, 28, 'union_rake_wallet', 'engine.fn_complete_tournament_terminal', now(), now(), 0, NULL),
  ('{CHIP_PAID}', NULL, 28, 'union_rake_wallet', 'engine.fn_complete_tournament_terminal', now(), now(), 7, NULL);
""")
    before = view_ids()
    check('on the live text, a Diamond house fee counts as credited nobody', 'd1:credited_nobody' in before, before)
    check('on the live text, a chip fee that credited nobody counts', 'c1:credited_nobody' in before, before)
    acl_before = run(f"SELECT relacl::text || '|' || array_to_string(reloptions, ',') FROM pg_class "
                     f"WHERE oid = '{VIEW}'::regclass")

    code, text = attempt(MIGRATION.read_text())
    check('the migration installs', code == 0, text[-800:])
    after = view_ids()
    check('a Diamond house fee is not an attribution gap', 'd1' not in after, after)
    check('a chip fee that credited nobody is still a gap', after == 'c1:credited_nobody', after)
    acl_after = run(f"SELECT relacl::text || '|' || array_to_string(reloptions, ',') FROM pg_class "
                    f"WHERE oid = '{VIEW}'::regclass")
    check('grants and security_invoker did not move', acl_after == acl_before and 'security_invoker=true' in acl_after,
          acl_after)

    code, text = attempt(MIGRATION.read_text())
    check('a second run of the migration refuses on the moved text', code != 0 and 'not the pinned text' in text,
          text[-300:])
finally:
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])
    except Exception:
        pass
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2))
    shutil.rmtree(cluster, ignore_errors=True)

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
