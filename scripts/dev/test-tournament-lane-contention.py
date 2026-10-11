#!/usr/bin/env python3
"""Real PG17 try-lock/trigger regression on captured production bodies.

The ticket and mixed-custody bodies are compiled and their complete definitions,
ACLs and configurations checked before/after. Their financial paths are unchanged
and are not represented as executed by this narrowly scoped lock rehearsal.
"""
import argparse
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='lp13-busy-', dir=os.environ.get('TMPDIR')))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
port = os.environ.get('TOURNAMENT_LANE_TEST_PORT', '55671')
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cmd = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', port, '-U', 'postgres', '-d', 'postgres']
rows = json.loads((ROOT/'scripts/dev/fixtures/tournament-lane-contention-preimages.json').read_text())
migration = (ROOT/'supabase/migrations/20261011185301_busy_tournament_lanes_return_lock_contention_to_their_caller.sql').read_text()
require_hash = 'e9094e105d8e337435f47cc17f9b5fb868b6ff9b8c32f51018ac5ef44c13a3b8'
if hashlib.sha256(migration.encode()).hexdigest() != require_hash:
    raise RuntimeError('qualified migration bytes changed')
results = {'passed': False, 'cases': []}
tournament = '00000000-0000-4000-8000-000000000099'
table = '00000000-0000-4000-8000-000000000002'
global_lane = 'ca:tournament-terminal-settlement:v1'
table_lane = global_lane + ':' + tournament

def execute(argv, sql=None):
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=30)

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def run(name, sql, expected=None, error=None):
    before = time.monotonic()
    r = execute(cmd, sql)
    (out/(name+'.log')).write_text(r.stdout+r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    elapsed = time.monotonic()-before
    results['cases'].append({'name': name, 'passed': passed, 'elapsedSeconds': elapsed})
    require(passed, name+': '+r.stdout[-500:]+r.stderr[-1500:])
    if error:
        require(elapsed < 2, name+' did not return contention promptly')
    return r.stdout.rstrip('\n')

def probe(name, sql, expected=None, error=None):
    return run(name, 'BEGIN;\n'+sql+'\nROLLBACK;', expected, error)

@contextmanager
def holder(lane):
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        p.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('"+lane+"',0)); SELECT pg_advisory_lock(11185301);\n")
        p.stdin.flush()
        deadline = time.monotonic()+5
        while execute(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=11185301 AND granted);").stdout.strip() != 't':
            require(p.poll() is None and time.monotonic()<deadline, 'holder barrier absent')
            time.sleep(.02)
        yield
    finally:
        if p.poll() is None:
            p.stdin.write('ROLLBACK;\n')
            p.stdin.close()
            p.wait(timeout=5)
        require(p.returncode == 0, 'holder failed')

snapshot = "SELECT jsonb_build_object('cards',(SELECT jsonb_agg(c) FROM public.guard_cards c),'commits',(SELECT jsonb_agg(c) FROM public.guard_commits c),'seats',(SELECT jsonb_agg(c) FROM public.table_seats c));"
metadata = "SELECT jsonb_agg(jsonb_build_object('sig',oid::regprocedure::text,'owner',proowner,'definer',prosecdef,'config',proconfig,'acl',proacl::text) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ("+','.join("'"+(r['signature'] if r['signature'].startswith('smarter_private.') else 'public.'+r['signature'])+"'::regprocedure" for r in rows)+");"
attempts = [
    ('allocator', "SELECT smarter_private.f06_try_lane('"+tournament+"');"),
    ('cards', "INSERT INTO public.guard_cards VALUES('"+table+"',7);"),
    ('accepted-hand', "INSERT INTO public.guard_commits VALUES('"+table+"',7);"),
    ('source-payload', 'UPDATE public.table_seats SET stack=101,table_id=table_id;'),
    ('source-identity', 'UPDATE public.table_seats SET user_id=gen_random_uuid();'),
]

try:
    require('PostgreSQL) 17.' in execute([pg/'postgres','--version']).stdout, 'PG17 required')
    r = execute([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    r = execute([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-w','-o',"-k "+str(socket)+" -p "+port+" -h '' -c shared_buffers=16MB -c max_connections=10",'start'])
    require(r.returncode == 0, r.stderr)
    # Table boundaries needed by the actual three trigger bodies. No RPC/auth
    # replacement is used in the executed paths. Composite-only relations let
    # PG compile the unchanged ticket/custody definitions without financial data.
    run('ground', '''
CREATE SCHEMA smarter_private;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.tables(id uuid,tournament_id uuid);
CREATE TABLE public.tournaments(id uuid);
CREATE TABLE public.tournament_tickets(id uuid);
CREATE TABLE public.tournament_escrow(tournament_id uuid);
CREATE TABLE smarter_private.f06_manager_custody_transfers(transfer_id uuid);
CREATE TABLE smarter_private.f06_manager_custody_completions(transfer_id uuid);
CREATE TABLE smarter_private.f06_hand_permits(table_id uuid,hand_number bigint,tournament_id uuid);
CREATE TABLE smarter_private.f06_unsettled_hand_aborts(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_generation_abort_hands(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_mixed_abort_hands(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_prepared_hand_cancellations(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_no_start_continuations(table_id uuid,hand_number bigint);
CREATE TABLE public.guard_cards(table_id uuid,hand_number bigint);
CREATE TABLE public.guard_commits(table_id uuid,hand_number bigint);
CREATE TABLE public.table_seats(id uuid,table_id uuid,user_id uuid,seat_number integer,stack numeric,left_at timestamptz,status text);
'''+"INSERT INTO public.tables VALUES('"+table+"','"+tournament+"');\n"+
        "INSERT INTO smarter_private.f06_hand_permits VALUES('"+table+"',7,'"+tournament+"');\n"+
        "INSERT INTO public.table_seats VALUES(gen_random_uuid(),'"+table+"',gen_random_uuid(),1,100,NULL,'active');")
    for i,r in enumerate(rows):
        sig = r['signature'] if r['signature'].startswith('smarter_private.') else 'public.'+r['signature']
        grants = 'REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC;\n'
        if 'service_role=X' in r['acl']:
            grants += 'GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;\n'
        run('preimage-'+str(i), r['definition']+';\n'+grants)
        run('exact-preimage-'+str(i), "SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure));", r['definition_hash'])
    run('bindings', '''
CREATE TRIGGER cards BEFORE INSERT ON public.guard_cards FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard();
CREATE TRIGGER commits BEFORE INSERT ON public.guard_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
CREATE TRIGGER source BEFORE UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
''')
    before = run('state-before',snapshot)
    meta = run('metadata-before',metadata)
    for label,lane in [('global',global_lane),('tournament',table_lane)]:
        with holder(lane):
            for name,sql in attempts:
                probe('before-'+label+'-'+name,sql,error='40001: F06_RETRY_CANONICAL_LANE')
    run('preimage-drift-refused', "BEGIN; ALTER FUNCTION smarter_private.f06_try_lane(uuid) SET search_path=public;\n"+migration,error='tournament lane preimage drift')
    run('install',migration)
    run('exact-replay-noop',migration)
    run('metadata-preserved',metadata,meta)
    run('no-state-rewritten',snapshot,before)
    for label,lane in [('global',global_lane),('tournament',table_lane)]:
        with holder(lane):
            for name,sql in attempts:
                probe('after-'+label+'-'+name,sql,error='55P03: F06_RETRY_CANONICAL_LANE')
    # Unrelated tournament work still proceeds behind another tournament's
    # exclusive lane. Contention does not become a global player lockout.
    with holder(global_lane+':00000000-0000-4000-8000-000000000098'):
        for name,sql in attempts[:4]:
            probe('unrelated-lane-'+name,sql)
    for name,sql in attempts[:4]:
        probe('released-lane-'+name,sql)
    probe('cancelled-hand-still-fenced',"INSERT INTO smarter_private.f06_prepared_hand_cancellations VALUES('"+table+"',7); INSERT INTO public.guard_cards VALUES('"+table+"',7);",error='55000: F06_CANCELLED_PREPARATION_FENCED')
    probe('aborted-hand-still-fenced',"INSERT INTO smarter_private.f06_unsettled_hand_aborts VALUES('"+table+"',7); INSERT INTO public.guard_commits VALUES('"+table+"',7);",error='55000: F06_ABORTED_HAND_FENCED')
    run('all-probes-rolled-back',snapshot,before)
    results['passed'] = True
finally:
    execute([pg/'pg_ctl','-D',cluster/'data','-m','immediate','stop'])
    shutil.rmtree(cluster)
    (out/'result.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS tournament lane contention: '+str(len(results['cases']))+' real PostgreSQL cases')
