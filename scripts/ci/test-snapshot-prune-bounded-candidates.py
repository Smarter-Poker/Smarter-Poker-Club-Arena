"""Native PostgreSQL regression for bounded, atomic snapshot retention scans.

Uses the existing eligibility stand-in from the age-bound fixture; the live
eligibility function is unchanged. No production connection or money writes.
"""
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
OUT = Path(os.environ.get('SNAPSHOT_TEST_OUTPUT', ROOT / 'artifacts/snapshot-prune-bounded'))
OUT.mkdir(parents=True, exist_ok=True)
cluster = Path(tempfile.mkdtemp(prefix='spb-'))
sock = cluster / 's'
sock.mkdir()
owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
if owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(sock, 'postgres')
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
psql = [PG / 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', sock,
        '-p', '55837', '-U', 'postgres', '-d', 'postgres']
checks = []


def cmd(args, sql=None, ok=True):
    p = subprocess.run(list(map(str, args)), input=sql, text=True,
                       capture_output=True, env=env, timeout=60)
    if ok and p.returncode:
        raise RuntimeError(p.stderr)
    return p


def run(sql):
    return cmd(psql, sql).stdout.strip()


def check(name, result):
    checks.append({'name': name, 'passed': bool(result)})
    assert result, name


def calls():
    return int(run("SELECT last_value::int FROM smarter_private.disposable_calls"))


def seed():
    run("""TRUNCATE hand_state_snapshots, smarter_private.horse_adaptive_disposal_certificates;
    INSERT INTO hand_state_snapshots(id,table_id,hand_number,created_at,updated_at,players_json)
    SELECT md5(g::text)::uuid,md5('table')::uuid,g,
      now()-interval '10 days'+g*interval '1 second',now()-interval '10 days',
      CASE WHEN g<=600 THEN '[{"is_horse":false}]'::jsonb ELSE '[{"is_horse":true}]'::jsonb END
      FROM generate_series(1,650) g;
    INSERT INTO smarter_private.horse_adaptive_disposal_certificates
      SELECT gen_random_uuid(),table_id,hand_number FROM hand_state_snapshots;
    ANALYZE hand_state_snapshots; ANALYZE smarter_private.horse_adaptive_disposal_certificates;
    """)


try:
    cmd(owner+[PG/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust',
               '--auth-host=reject','--no-locale','--encoding=UTF8'])
    cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',
               f"-k {sock} -p 55837 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
    module = ast.parse((ROOT/'scripts/ci/test-snapshot-prune-reads-its-age-bound.py').read_text())
    schema = next(ast.literal_eval(n.value) for n in module.body
                  if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id=='SCHEMA' for t in n.targets))
    run(schema)
    run((ROOT/'scripts/ci/fixtures/snapshot-prune-bounded-preimage.sql').read_text())
    run('REVOKE ALL ON FUNCTION sp_prune_hand_state_snapshots(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION sp_prune_hand_state_snapshots(integer) TO service_role;')
    seed()
    before = calls()
    check('baseline-deletes-50-after-unbounded-eligibility-work', run('SELECT sp_prune_hand_state_snapshots(250)')=='50' and calls()-before>600)
    seed()
    meta = run("SELECT oid::text||':'||proacl::text FROM pg_proc WHERE oid='sp_prune_hand_state_snapshots(integer)'::regprocedure")
    migration = next((ROOT/'supabase/migrations').glob('*_snapshot_retention_traverses_bounded_candidates_before_eligi.sql')).read_text()
    run(migration)
    check('function-identity-and-access-preserved', meta==run("SELECT oid::text||':'||proacl::text FROM pg_proc WHERE oid='sp_prune_hand_state_snapshots(integer)'::regprocedure"))
    before=calls()
    check('first-retained-page-bounded', run('SELECT sp_prune_hand_state_snapshots(250)')=='0' and calls()-before<=250)
    before=calls()
    check('cursor-passes-retained-page', run('SELECT sp_prune_hand_state_snapshots(250)')=='0' and calls()-before<=250)
    check('later-disposable-rows-not-starved', run('SELECT sp_prune_hand_state_snapshots(250)')=='50')
    check('human-witnesses-retained', run('SELECT count(*) FROM hand_state_snapshots')=='600')
    check('pass-wraps', run("SELECT sp_prune_hand_state_snapshots(250); SELECT through_at='-infinity' FROM smarter_private.snapshot_retention_scan")=='0\nt')
    run("UPDATE hand_state_snapshots SET players_json='[{\"is_horse\":true}]' WHERE hand_number=1;")
    cursor=run('SELECT row_to_json(s) FROM smarter_private.snapshot_retention_scan s')
    run('BEGIN; SELECT sp_prune_hand_state_snapshots(250); ROLLBACK;')
    check('cursor-and-deletion-roll-back-together', cursor==run('SELECT row_to_json(s) FROM smarter_private.snapshot_retention_scan s') and run('SELECT count(*) FROM hand_state_snapshots WHERE hand_number=1')=='1')
    check('previously-held-row-revisited', run('SELECT sp_prune_hand_state_snapshots(250)')=='1')
    check('new-private-state-has-no-public-access', run("SELECT NOT has_table_privilege('anon','smarter_private.snapshot_retention_scan','SELECT') AND NOT has_table_privilege('authenticated','smarter_private.snapshot_retention_scan','UPDATE')")=='t')
    check('migration-replay-refused', cmd(psql,migration,False).returncode!=0)
    print(json.dumps({'checks':checks,'production_mutations':False,
                      'postimage_md5':run("SELECT md5(pg_get_functiondef('sp_prune_hand_state_snapshots(integer)'::regprocedure))")}))
finally:
    (OUT/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False},indent=2))
    cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'],ok=False)
    shutil.rmtree(cluster)
