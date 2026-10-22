"""Isolated PostgreSQL qualification: the hourly sweep reads each leg once, and says the same.

Migration 20261022162545 changes how five conservation reads find their rows,
not what they answer. This loads the exact production definitions captured on
2026-10-22 (each pg_get_functiondef md5 equals production's) twice: into
public, where the migration replaces them, and into a reference schema the
migration never touches. After every step below, every replaced function must
return exactly what its reference returns:

  * before any checkpoint exists (the whole range is read);
  * on every branch of the ledger liveness sentence (critical, thin, quiet,
    normal), with the hand count printed only where it was printed before;
  * after the checkpoint advances, with legs on both sides of the six-hour
    horizon, a leg exactly at the checkpoint and legs written after it;
  * after a second advance that moves the checkpoint over those legs;
  * when a later BBJ pool joins the set after the checkpoint (read whole until
    the next advance gives it a row) and after it is kept;
  * when the BBJ epoch or the chip baseline moves (the checkpoint is ignored,
    then rebuilt from the new start);
  * through fn_ca_conservation_sweep, which advances the checkpoint first and
    still runs every check.

It also proves the migration refuses a non-installer role and a changed
preimage, refuses a second install, leaves owners and grants as they were, and
keeps horses in every figure (the fixture members include a horse). An empty
throwaway cluster on a Unix socket; no network, no production connection.
Runs as the runner user, or as postgres under root.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase' / 'migrations' / '20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql'
FIX = ROOT / 'scripts' / 'ci' / 'fixtures' / 'hourly-sweep-incremental'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/hourly-sweep-incremental')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
as_owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
cluster = pathlib.Path(tempfile.mkdtemp(prefix='hourly-sweep-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
if as_owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
PORT = os.environ.get('HOURLY_SWEEP_PORT', '55834')
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'checks': [], 'production_mutations': False}

PRE = {
    'fn_chip_drift_since_baseline()': '6e7f006fb462ab5e008f94a6d6df63e8',
    'fn_bbj_conservation_check()': 'ffbdd5f2fab8e7a8f8dbd32a667a0b5a',
    'fn_chip_integrity_report()': 'f87b9efb48d0bb8930358fabb7ebd870',
    'fn_ca_payout_rows_without_money(integer)': '7d1f46dce13044b7cb90823ed08e1be4',
    'fn_tournament_prize_disbursement_audit(integer)': 'd62ceae6005e91ab678155a826bc50e5',
    'fn_ca_conservation_sweep()': '81995d0a3590cab15132df5b1ef609e8',
    'fn_ledger_liveness()': '222ef060dbfe6e7c4a4c2a37cb0cfda5',
    'fn_unaccounted_seat_exits(interval,interval)': '9b4bd9fcada25292668ed80c5ccf7a0c',
    'fn_bbj_contributions_total()': '6a734d07f9e43b5ebbafa5e3974abfe5',
}
REPLACED = ['fn_chip_drift_since_baseline', 'fn_bbj_conservation_check', 'fn_chip_integrity_report',
            'fn_ca_payout_rows_without_money', 'fn_tournament_prize_disbursement_audit']


def command(args, sql=None):
    r = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=180)
    if r.returncode:
        raise RuntimeError(f'{args[0]} failed ({r.returncode})\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}')
    return r.stdout


def q(sql):
    return command(as_owner + psql, sql).strip()


def fails(sql, needle):
    r = subprocess.run(list(map(str, as_owner + psql)), input=sql, text=True, capture_output=True, env=env, timeout=180)
    if r.returncode == 0 or needle not in r.stderr:
        raise AssertionError(f'expected a refusal containing {needle!r}\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')


def check(name, ok, detail=''):
    results['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ((': ' + detail) if detail and not ok else ''), flush=True)
    if not ok:
        raise AssertionError(name)


PROBE = {
    'fn_chip_drift_since_baseline': "SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.club_id, x.user_id), '[]')::text FROM {s}.fn_chip_drift_since_baseline() x",
    'fn_bbj_conservation_check': "SELECT {s}.fn_bbj_conservation_check()::text",
    'fn_chip_integrity_report': "SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]')::text FROM {s}.fn_chip_integrity_report() x",
    'fn_ca_payout_rows_without_money': "SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]')::text FROM {s}.fn_ca_payout_rows_without_money(3) x",
    'fn_tournament_prize_disbursement_audit': "SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.tournament_id), '[]')::text FROM {s}.fn_tournament_prize_disbursement_audit(24) x",
}


def same(stage, wrap=None):
    """Every replaced function equals its untouched reference, in one snapshot."""
    for name, probe in PROBE.items():
        sql = 'SELECT (' + probe.format(s='public') + ') = (' + probe.format(s='ref') + '), (' + probe.format(s='public') + ')'
        if wrap:
            sql = wrap.replace('@@', sql)
        line = q(sql).splitlines()[-1]
        equal, body = line.split('|', 1)
        check(f"{stage}: {name} answers exactly as the production definition", equal == "t", body[:600])


try:
    command(as_owner + [pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth=trust', '--no-locale', '-E', 'UTF8'])
    with open(cluster / 'data' / 'postgresql.conf', 'a') as f:
        f.write(f"\nport={PORT}\nlisten_addresses=''\nunix_socket_directories='{sock}'\nfsync=off\ntimezone='UTC'\n")
    command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'log', '-w', 'start'])

    q((FIX / 'schema.sql').read_text())
    pre = ''.join((FIX / f'{fn.split("(")[0]}.live-20261022.sql').read_text() for fn in PRE)
    q('SET check_function_bodies = off;\n' + pre)
    for sig, pin in PRE.items():
        check(f'{sig} is the production definition', q(f"SELECT md5(pg_get_functiondef('public.{sig}'::regprocedure))") == pin)
    q('REVOKE ALL ON FUNCTION ' + ', '.join('public.' + s for s in PRE) + ' FROM PUBLIC, anon, authenticated;'
      + 'GRANT EXECUTE ON FUNCTION ' + ', '.join('public.' + s for s in PRE) + ' TO service_role;')

    # The reference: the same production text in a schema the migration never touches.
    ref = 'CREATE SCHEMA ref;\nSET check_function_bodies = off;\n'
    for name in REPLACED:
        text = (FIX / f'{name}.live-20261022.sql').read_text().replace(f'FUNCTION public.{name}(', f'FUNCTION ref.{name}(')
        ref += text.replace('public.fn_chip_drift_since_baseline()', 'ref.fn_chip_drift_since_baseline()')
    q(ref)
    q((FIX / 'data.sql').read_text())
    acl_before = q("SELECT jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_array(pg_get_userbyid(p.proowner), p.proacl::text, p.prosecdef, p.provolatile)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace")

    # Refusals: a role that is not the installer, and a preimage that moved.
    body = MIGRATION.read_text()
    txn = body[body.index('\nBEGIN;\n') + 1:]
    preamble = body[:body.index('\nBEGIN;\n')]
    q(preamble)
    q('CREATE ROLE stranger LOGIN; GRANT CREATE ON SCHEMA public TO stranger;')
    fails('SET ROLE stranger;\n' + txn, 'requires the maintained installer')
    fails(txn.replace('BEGIN;\n', "BEGIN;\nALTER FUNCTION public.fn_chip_integrity_report() SET work_mem = '1MB';\n", 1), 'hourly sweep preimage changed: public.fn_chip_integrity_report()')
    check('the migration refuses a stranger and a moved preimage, and nothing is left behind',
          q("SELECT to_regclass('public.ca_ledger_audit_marks') IS NULL") == 't')

    same('before the migration')
    command(as_owner + psql + ['-f', MIGRATION])
    fails(body, 'already installed')
    check('a second install is refused', True)
    acl_after = q("SELECT jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_array(pg_get_userbyid(p.proowner), p.proacl::text, p.prosecdef, p.provolatile)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = ANY (ARRAY[" + ','.join(f"'{s}'" for s in PRE) + "])")
    before = json.loads(acl_before)
    after = json.loads(acl_after)
    check('owners, grants, SECURITY DEFINER and volatility are unchanged', all(before[k] == v for k, v in after.items()) and len(after) == len(PRE), acl_after)
    check('the advance is the installer\'s alone', q("SELECT has_function_privilege('service_role', 'public.fn_ca_ledger_audit_checkpoint_advance()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.fn_ca_ledger_audit_checkpoint_advance()', 'EXECUTE')") == 'f')

    same('installed, no checkpoint yet')

    # Every liveness branch, each in a transaction rolled back.
    same('liveness critical (hands, no ledger rows in 24 h)', "BEGIN; DELETE FROM public.chip_ledger WHERE created_at > now() - interval '24 hours'; @@; ROLLBACK;")
    same('liveness critical (no hands, members moved, no ledger rows)', "BEGIN; DELETE FROM public.chip_ledger WHERE created_at > now() - interval '24 hours'; DELETE FROM public.hand_history; @@; ROLLBACK;")
    same('liveness thin', "BEGIN; INSERT INTO public.club_members (club_id, user_id, chip_balance) SELECT gen_random_uuid(), gen_random_uuid(), 0 FROM generate_series(1, 400); @@; ROLLBACK;")
    same('liveness quiet', "BEGIN; DELETE FROM public.hand_history; UPDATE public.club_members SET updated_at = now() - interval '3 days'; @@; ROLLBACK;")
    check('the critical sentence still prints the exact hand count',
          q("BEGIN; DELETE FROM public.chip_ledger WHERE created_at > now() - interval '24 hours'; SELECT detail FROM public.fn_chip_integrity_report() WHERE check_name = 'ledger_liveness'; ROLLBACK;").splitlines()[-1].startswith('THE AUDIT TRAIL IS NOT RECORDING. 2 hands and'))

    adv = json.loads(q('SELECT public.fn_ca_ledger_audit_checkpoint_advance()'))
    check('the first advance sums both ranges up to the horizon', 'chip_drift' in adv and 'bbj_epoch' in adv, json.dumps(adv))
    check('the horizon is six hours back', q("SELECT bool_and(through_at BETWEEN now() - interval '6 hours 2 minutes' AND now() - interval '6 hours') FROM public.ca_ledger_audit_marks") == 't')
    check('the later pools are kept, the original pool is not', q("SELECT string_agg(pool_id::text, ',' ORDER BY pool_id) FROM public.ca_ledger_audit_bbj_pool") == 'b0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000002')
    check('an opening older than the horizon keeps its absorbed legs; an unopened pool does not',
          q("SELECT string_agg(pool_id::text || ':' || (absorbed_to IS NOT NULL)::text, ',' ORDER BY pool_id) FROM public.ca_ledger_audit_bbj_pool") == 'b0000000-0000-0000-0000-000000000001:true,b0000000-0000-0000-0000-000000000002:false')
    same('after the first advance')

    # Legs exactly at the checkpoint and after it.
    q("""INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at)
         SELECT 'club_treasury', 'c1000000-0000-0000-0000-000000000001', 'player_wallet', '00000000-0000-0000-0000-0000000000b1', 3.33, 'transfer',
                'c1000000-0000-0000-0000-000000000001', through_at FROM public.ca_ledger_audit_marks WHERE metric = 'chip_drift';
         INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at)
         SELECT 'system_mint', NULL, 'bbj_pool', 'b0000000-0000-0000-0000-000000000001', 6.66, 'bbj_seed', 'c1000000-0000-0000-0000-000000000001', through_at
           FROM public.ca_ledger_audit_marks WHERE metric = 'bbj_epoch';
         INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at)
         SELECT 'bbj_pool', 'b0000000-0000-0000-0000-000000000000', 'player_wallet', '00000000-0000-0000-0000-0000000000a1', 1.11, 'bbj_payout', 'c1000000-0000-0000-0000-000000000001', through_at + interval '1 second'
           FROM public.ca_ledger_audit_marks WHERE metric = 'bbj_epoch';
         INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
         VALUES ('player_wallet', '00000000-0000-0000-0000-0000000000a1', 'table_stack', NULL, 7.77, 'buyin', 'c1000000-0000-0000-0000-000000000001'),
                ('bbj_pool', 'b0000000-0000-0000-0000-000000000002', 'system_burn', NULL, 2.22, 'bbj_burn', 'c2000000-0000-0000-0000-000000000002');""")
    same('legs at the checkpoint and after it')

    # A later pool joins after the checkpoint: read whole until the next advance keeps it.
    q("""INSERT INTO public.bbj_pools (id, club_id, created_at, main_balance) VALUES ('b0000000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000002', now() - interval '9 hours', 10);
         INSERT INTO public.chip_ledger (from_type, to_type, to_entity_id, amount, category, club_id, created_at)
         VALUES ('system_mint', 'bbj_pool', 'b0000000-0000-0000-0000-000000000004', 10, 'bbj_seed', 'c2000000-0000-0000-0000-000000000002', now() - interval '1 hour');
         INSERT INTO public.ca_bbj_pool_snapshots (pool_id, taken_at, is_baseline, main) VALUES ('b0000000-0000-0000-0000-000000000002', now() - interval '1 hour', true, 100);""")
    same('a later pool joins after the checkpoint')
    q('SELECT pg_sleep(2)')
    q('SELECT public.fn_ca_ledger_audit_checkpoint_advance()')
    check('the second advance keeps the new pool and moves past the checkpoint legs',
          q("SELECT count(*) FROM public.ca_ledger_audit_bbj_pool WHERE pool_id = 'b0000000-0000-0000-0000-000000000004'") == '1'
          and q("SELECT bool_and(legs > 0) FROM public.ca_ledger_audit_marks") == 't')
    same('after the second advance')

    # The starting points move: the checkpoint is ignored, then rebuilt.
    q("INSERT INTO public.ca_bbj_pool_snapshots (pool_id, taken_at, is_baseline, main) VALUES ('b0000000-0000-0000-0000-000000000000', now() - interval '19 days', true, 700);"
      "INSERT INTO public.ca_chip_baseline VALUES ('c2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a2', 50, 0, 0, now() - interval '25 days');")
    same('the epoch and the baseline moved, checkpoint not yet rebuilt')
    q('SELECT public.fn_ca_ledger_audit_checkpoint_advance()')
    check('the checkpoint is rebuilt from the new starting points',
          q("SELECT string_agg(metric || ':' || (from_at < now() - interval '18 days 12 hours')::text, ',' ORDER BY metric) FROM public.ca_ledger_audit_marks") == 'bbj_epoch:true,chip_drift:true')
    same('after the rebuild')

    # The sweep advances first and still runs every check.
    marks = q('SELECT string_agg(advanced_at::text, \',\' ORDER BY metric) FROM public.ca_ledger_audit_marks')
    q('SELECT pg_sleep(1)')
    sweep = json.loads(q('SELECT public.fn_ca_conservation_sweep()'))
    check('the sweep runs all 29 checks', sweep.get('checks_run') == 29 and sweep.get('ok') is True, json.dumps(sweep))
    check('the sweep advanced the checkpoint first', q('SELECT string_agg(advanced_at::text, \',\' ORDER BY metric) FROM public.ca_ledger_audit_marks') != marks)
    check('the advance did not fail inside the sweep', q("SELECT count(*) FROM public.test_incidents WHERE source LIKE '%checkpoint_advance%'") == '0')
    check('the changed checks did not fail inside the sweep',
          q("SELECT count(*) FROM public.test_incidents WHERE split_part(key, ':', 1) = 'sweepfail' AND split_part(key, ':', 2) IN ('fn_chip_integrity_report', 'fn_bbj_conservation_check', 'fn_ca_payout_rows_without_money', 'fn_tournament_prize_disbursement_audit')") == '0',
          q("SELECT string_agg(key || ' ' || detail::text, ' | ') FROM public.test_incidents WHERE key LIKE 'sweepfail:%'"))
    check('the seat-exit finding still counts both uncredited exits, the horse\'s among them',
          q("SELECT detail FROM public.fn_chip_integrity_report() WHERE check_name = 'unaccounted_seat_exits'").startswith('2 seat exit(s)'))
    same('after the sweep')
    results['ok'] = True
finally:
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    try:
        command(as_owner + [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    except Exception:
        pass
    shutil.rmtree(cluster, ignore_errors=True)
