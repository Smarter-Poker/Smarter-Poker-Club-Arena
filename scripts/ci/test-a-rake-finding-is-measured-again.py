"""Isolated PostgreSQL regression: a rake finding is measured again from the hand's dealt list.

On 2026-10-16 the ledger_reconcile_log:over_spec and bbj_over_spec storms kept
growing every hour at :52 after their cause (the Lightning writer that booked
payers as rake_records.num_players, fixed by 20261015222121) was installed.
fn_ca_escalate_reconcile_criticals re-measures a stored critical before it
files it, but fn_ca_remeasure_entity could not measure a rake_law finding on a
chip table, so the stored 2026-10-15 rows were filed from history every hour.
And fn_rake_law_violations priced a hand by rake_records.num_players before
hand_history.players, the copy before the witness.

The test loads production's exact text of both functions (fixtures captured
2026-10-16; their pg_get_functiondef md5 must equal production's), over
stand-in tables and a stand-in pricing rule that is sensitive to the number of
players dealt in. A four-handed hand whose rake_records.num_players says 2
(the 2026-10-15 Lightning shape) reads over_spec and bbj_over_spec on the live
text, and its table cannot be measured again. The migration must reproduce
production's derived postimage md5s; then the same hand is in spec, its table
measures "ok" on the recorded and spec amounts, a real over-rake and a
no-flop drop still measure "critical", and a second run of the migration
refuses. An empty throwaway cluster on a Unix socket; no network, no
production connection.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261016103238_a_rake_finding_is_measured_again_from_the_hands_dealt_list.sql'
FIXTURES = ROOT / 'scripts/ci/fixtures/a-rake-finding-is-measured-again'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/a-rake-finding-is-measured-again')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='rake-remeasure-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = '55832'
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

REMEASURE = 'public.fn_ca_remeasure_entity(text,uuid)'
VIOLATIONS = 'public.fn_rake_law_violations(interval)'
# pg_get_functiondef md5s read on production 2026-10-16, and the postimages
# derived read-only on production with replace().
LIVE = {REMEASURE: '03e547f65a2d4c43fd52ac92787111ba', VIOLATIONS: 'a3e1fde3f45140c91640389d419ed553'}
POST = {REMEASURE: '6619b6b524cde561636e4d451cd0ee2c', VIOLATIONS: 'e64d0cfdbcb494a2230db017fff390e1'}


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
CREATE TABLE clubs(id uuid PRIMARY KEY, asset text, default_rake_percent numeric, rake_cap numeric,
  bbj_rake_enabled boolean);
CREATE TABLE tables(id uuid PRIMARY KEY, club_id uuid, tournament_id uuid, small_blind numeric, big_blind numeric,
  max_players integer, game_variant text, rake_percent numeric, rake_cap_bb numeric);
CREATE TABLE hand_history(id uuid PRIMARY KEY, table_id uuid, tournament_id uuid, hand_number bigint,
  created_at timestamptz, rake_amount numeric, bbj_amount numeric, pot_size numeric, game_variant text,
  players jsonb, community_cards text[], community_cards2 text[], showdown jsonb, actions jsonb);
CREATE TABLE rake_records(hand_id uuid PRIMARY KEY, num_players integer, bbj_contribution numeric);
CREATE TABLE poker_diamond_hand_receipts(table_id uuid, hand_number bigint, receipt jsonb);
CREATE FUNCTION public.fn_ca_treasury_positions()
RETURNS TABLE(club_id uuid, ledger_balance numeric, stored_balance numeric, severity text)
LANGUAGE sql AS $f$ SELECT NULL::uuid, 0::numeric, 0::numeric, 'ok'::text WHERE false $f$;
-- A stand-in for the chip spec that depends on the players dealt in, the
-- way production's does: heads-up is priced at half the full percentage and
-- the BBJ drop needs three dealt.
CREATE FUNCTION public.fn_effective_rake(p_bb numeric, p_pot numeric, p_players_dealt integer, p_saw_flop boolean,
  p_sb numeric DEFAULT NULL, p_override_percent numeric DEFAULT NULL, p_override_cap_bb numeric DEFAULT NULL,
  p_seats integer DEFAULT NULL)
RETURNS TABLE(rake numeric, cap numeric, percent numeric) LANGUAGE sql STABLE AS $f$
  SELECT round(COALESCE(p_pot, 0) * CASE WHEN COALESCE(p_players_dealt, 0) <= 2 THEN 2.5 ELSE 5 END / 100, 2),
         100::numeric, CASE WHEN COALESCE(p_players_dealt, 0) <= 2 THEN 2.5 ELSE 5 END::numeric
$f$;
CREATE FUNCTION public.fn_effective_bbj_drop(p_bb numeric, p_players_dealt integer, p_saw_flop boolean, p_club_id uuid,
  p_table_id uuid DEFAULT NULL, p_variant text DEFAULT 'nlh', p_sb numeric DEFAULT NULL, p_pot numeric DEFAULT NULL,
  p_rake numeric DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN COALESCE(p_players_dealt, 0) < 3 THEN 0 ELSE 0.02 END::numeric
$f$;
"""

GRANTS = """
REVOKE ALL ON FUNCTION public.fn_ca_remeasure_entity(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_remeasure_entity(text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_rake_law_violations(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rake_law_violations(interval) TO service_role;
"""

CLUB = '00000000-0000-0000-0000-00000000c001'
PILOT = '00000000-0000-0000-0000-00000000a001'   # the 2026-10-15 Lightning shape
OVER = '00000000-0000-0000-0000-00000000a002'    # a real over-rake
NOFLOP = '00000000-0000-0000-0000-00000000a003'  # a no-flop drop
BOARD = "ARRAY['As','Kd','7c','2h','9s']"
FOUR = "'[{\"seat\":1},{\"seat\":2},{\"seat\":3},{\"seat\":4}]'::jsonb"


def seed():
    run(f"""
INSERT INTO clubs VALUES ('{CLUB}', 'chips', NULL, NULL, true);
INSERT INTO tables VALUES
  ('{PILOT}', '{CLUB}', NULL, 0.02, 0.04, 9, 'nlh', NULL, NULL),
  ('{OVER}', '{CLUB}', NULL, 0.02, 0.04, 9, 'nlh', NULL, NULL),
  ('{NOFLOP}', '{CLUB}', NULL, 0.02, 0.04, 9, 'nlh', NULL, NULL);
-- Four dealt, two fast folders who never posted: the record's copy says 2.
-- Rake 0.50 and drop 0.02 are exactly the spec for four dealt on a 10.00 pot.
INSERT INTO hand_history VALUES
  ('00000000-0000-0000-0000-0000000000b1', '{PILOT}', NULL, 1, now() - interval '1 hour', 0.50, 0.02, 10.00, 'nlh',
   {FOUR}, {BOARD}, NULL, '[]'::jsonb, '[{{"stage":"flop"}}]'::jsonb),
  ('00000000-0000-0000-0000-0000000000b2', '{OVER}', NULL, 1, now() - interval '1 hour', 0.80, 0.02, 10.00, 'nlh',
   {FOUR}, {BOARD}, NULL, '[]'::jsonb, '[{{"stage":"flop"}}]'::jsonb),
  ('00000000-0000-0000-0000-0000000000b3', '{NOFLOP}', NULL, 1, now() - interval '1 hour', 0.10, 0, 1.00, 'nlh',
   {FOUR}, NULL, NULL, NULL, '[{{"stage":"preflop"}}]'::jsonb);
INSERT INTO rake_records VALUES
  ('00000000-0000-0000-0000-0000000000b1', 2, 0.02),
  ('00000000-0000-0000-0000-0000000000b2', 4, 0.02),
  ('00000000-0000-0000-0000-0000000000b3', 4, 0);
""")


def violations():
    return run("SELECT COALESCE(string_agg(kind || ':' || right(table_id::text, 4), ',' ORDER BY kind, table_id), '') "
               "FROM public.fn_rake_law_violations('2 hours')")


def remeasure(table):
    return run(f"SELECT measurable::text || '|' || COALESCE(ledger_balance::numeric(12,2)::text, '-') || '|' "
               f"|| COALESCE(stored_balance::numeric(12,2)::text, '-') || '|' || COALESCE(severity, '-') "
               f"FROM public.fn_ca_remeasure_entity('rake_law', '{table}')")


try:
    if shutil.disk_usage(tempfile.gettempdir()).free < 256 * 1024 ** 2:
        raise RuntimeError('256 MiB disk reserve required')
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                        '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o',
                        f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
                        '-w', 'start'])
    run(SCHEMA)
    for name in ('fn_ca_remeasure_entity', 'fn_rake_law_violations'):
        run((FIXTURES / f'{name}.live-20261016.sql').read_text() + ';')
    run(GRANTS)
    for sig, md5 in LIVE.items():
        got = defmd5(sig)
        check(f'the fixture is production\'s exact text of {sig}', got == md5, got)
    seed()

    before = violations()
    check('on the live text, the four-dealt hand booked as 2 reads over_spec and bbj_over_spec',
          'over_spec:a001' in before and 'bbj_over_spec:a001' in before, before)
    check('on the live text, a rake_law finding on a chip table cannot be measured again',
          remeasure(PILOT).startswith('false|'), remeasure(PILOT))

    code, text = attempt(MIGRATION.read_text())
    check('the migration installs', code == 0, text[-800:])
    for sig, md5 in POST.items():
        got = defmd5(sig)
        check(f'{sig} reads back as production\'s derived postimage', got == md5, got)

    after = violations()
    check('the four-dealt hand is priced by its dealt list and is in spec', 'a001' not in after, after)
    check('a real over-rake is still a violation', 'over_spec:a002' in after, after)
    check('a no-flop drop is still a violation', 'no_flop_no_drop:a003' in after, after)
    check('the pilot table measures ok on recorded and spec amounts', remeasure(PILOT) == 'true|0.52|0.52|ok',
          remeasure(PILOT))
    check('a real over-rake measures critical on fresh numbers', remeasure(OVER) == 'true|0.52|0.82|critical',
          remeasure(OVER))
    check('a no-flop drop measures critical', remeasure(NOFLOP).endswith('|critical'), remeasure(NOFLOP))
    check('a non-rake entity is still not measurable here',
          run("SELECT measurable FROM public.fn_ca_remeasure_entity('insurance_bank', gen_random_uuid())") == 'f')
    owner_acl = run("SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef || ':' "
                    "|| COALESCE(p.proacl::text, '') || ':' || COALESCE(p.proconfig::text, ''), ' ' ORDER BY p.proname) "
                    "FROM pg_proc p WHERE p.proname IN ('fn_ca_remeasure_entity', 'fn_rake_law_violations')")
    check('owner, security and grants did not move',
          'fn_ca_remeasure_entity:postgres:true:{postgres=X/postgres,service_role=X/postgres}' in owner_acl
          and 'fn_rake_law_violations:postgres:false:{postgres=X/postgres,service_role=X/postgres}' in owner_acl,
          owner_acl)

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
