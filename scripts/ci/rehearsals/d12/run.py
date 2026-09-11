"""Offline-only E2: create, use, and stop a private socket-only PG17 cluster.

No production destination argument, DSN, password, or network client exists.
The sole optional argument is the local PostgreSQL 17 binary directory.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse, hashlib, json, os, subprocess, tempfile

base = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pg-bin', default='/opt/homebrew/opt/postgresql@17/bin')
parser.add_argument('--migration',type=Path,required=True)
args = parser.parse_args()
migration=args.migration.resolve()
assert migration.is_file()
migration_hash=hashlib.sha256(migration.read_bytes()).hexdigest()
pg = Path(args.pg_bin).resolve()
assert subprocess.check_output([str(pg/'postgres'),'--version'],text=True).startswith('postgres (PostgreSQL) 17.')
manifest = json.loads((base/'fixture-manifest.json').read_text())
for filename, expected in manifest['sha256'].items():
    assert Path(filename).name == filename
    assert hashlib.sha256((base/filename).read_bytes()).hexdigest() == expected, filename
# Python subprocess helpers intentionally use the known installation path.
# Other installations are supported by rewriting only this local runtime path
# in a temporary working copy of the scripts, never modifying source fixtures.
work = Path(tempfile.mkdtemp(prefix='ca-e2-owned-',dir='/tmp'))
data, sock = work/'data', work/'socket'
sock.mkdir(mode=0o700)
state = {'cluster':str(work),'socket':str(sock),'port':55498,'database':'e2_bee519fa'}
runtime = work/'rehearsal'
runtime.mkdir()
for filename in manifest['sha256']:
    content = (base/filename).read_bytes()
    if filename.endswith('.py'):
        content=content.replace(b'/opt/homebrew/opt/postgresql@17/bin',str(pg).encode())
    (runtime/filename).write_bytes(content)
(runtime/'cluster.json').write_text(json.dumps(state))
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['PGTZ']='UTC'
def run(command, filename):
    result=subprocess.run(command,cwd=runtime,env=env,text=True,capture_output=True)
    (runtime/filename).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(f'{filename}: '+(result.stderr or result.stdout)[-2500:])
    return result.stdout
started = False
try:
    run([str(pg/'initdb'),'-D',str(data),'--no-locale','-E','UTF8','-U','postgres'],'init.log')
    run([str(pg/'pg_ctl'),'-D',str(data),'-l',str(work/'postgres.log'),'-o',f"-h '' -k {sock} -p 55498",'-w','start'],'start.log')
    started=True
    psql=[str(pg/'psql'),'-X','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55498','-U','postgres']
    run(psql+['-d','postgres','-c','CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'],'roles.log')
    for script in ['load-local.py','verify-pins.py','seed-local.py']:
        run(['python3',str(runtime/script)],script+'.log')
    run(psql+['-d','e2_bee519fa','-f',str(runtime/'entry-close-trigger-function.sql')],'entry-close-trigger.log')
    run(psql+['-d','e2_bee519fa','-f',str(runtime/'lifecycle-tables.sql')],'lifecycle-table.log')
    run(psql+['-d','e2_bee519fa','-f',str(runtime/'lifecycle-functions.sql')],'lifecycle-source.log')
    run(psql+['-d','e2_bee519fa','-c','REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;REVOKE ALL ON FUNCTION public.fn_tournament_finish_readiness(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;REVOKE ALL ON FUNCTION public.trg_tournament_atomic_place_completion_guard() FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.trg_tournament_atomic_place_completion_guard() TO service_role;REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO service_role;REVOKE ALL ON FUNCTION public.trg_freeze_batched_tournament_place() FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.trg_freeze_batched_tournament_place() TO service_role;'],'d12-observed-acls.log')
    metadata_refusals=[]
    for label,mutation in [('client-grant','GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO authenticated;'),('wrong-owner','ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) OWNER TO service_role;')]:
        attempt=subprocess.run(psql+['-d','e2_bee519fa','-c','BEGIN;'+mutation,'-f',str(migration)],cwd=runtime,env=env,text=True,capture_output=True)
        assert attempt.returncode!=0 and 'D12 terminal claim entry-point metadata differs' in attempt.stderr,(label,attempt.stderr)
        metadata_refusals.append({'case':label,'refused':True,'transactionRolledBack':True})
    (runtime/'metadata-drift-receipt.json').write_text(json.dumps(metadata_refusals,indent=2)+'\n')
    run(psql+['-d','e2_bee519fa','-f',str(migration)],'d12-candidate.log')
    run(psql+['-d','e2_bee519fa','-f',str(runtime/'lifecycle-probe.sql')],'lifecycle-probe.log')
    run(psql+['-d','e2_bee519fa','-f',str(runtime/'future-finishes.sql')],'future-finishes.log')
    terminal=run(psql+['-d','e2_bee519fa','-Atc',"SELECT public.fn_complete_tournament_terminal('bee519fa-ff07-438c-9542-d386fc821908','8327a08a-77e7-4f33-be45-e086a718c9e2','places')"],'terminal.log')
    receipt=json.loads(terminal)
    assert receipt['status']=='COMPLETED'
    (runtime/'terminal-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    run(['python3',str(runtime/'verify-local.py')],'verify.log')
    run(['python3',str(runtime/'verify-guard-poststate.py')],'guard-poststate.log')
    assert hashlib.sha256(migration.read_bytes()).hexdigest()==migration_hash,'Migration changed during rehearsal'
    lifecycle=next(line.strip().split('=',1)[1] for line in (runtime/'lifecycle-probe.log').read_text().splitlines() if line.strip().startswith('D12_LIFECYCLE='))
    lifecycle=json.loads(lifecycle)
    assert len(lifecycle)==18 and sum(x['result'].get('refused') is True for x in lifecycle)==7
    (runtime/'lifecycle-receipt.json').write_text(json.dumps({'cases':lifecycle,'migrationSha256':migration_hash,'allDeferredConstraintsChecked':True,'syntheticLifecycleRolledBack':True},indent=2)+'\n')
    out = base/'runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out.mkdir(parents=True)
    for name in ['verification-receipt.json','terminal-receipt.json','pins-receipt.json','future-finishes.log','terminal.log','verify.log','lifecycle-probe.log','lifecycle-receipt.json','guard-poststate-receipt.json','metadata-drift-receipt.json']:
        (out/name).write_bytes((runtime/name).read_bytes())
    (out/'run.json').write_text(json.dumps({'status':'passed','migrationSha256':migration_hash,'runtime':str(runtime),'fixtureManifestSha256':hashlib.sha256((base/'fixture-manifest.json').read_bytes()).hexdigest()},indent=2)+'\n')
    print(json.dumps({'status':'passed','receiptDirectory':str(out)}))
finally:
    if started:
        subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],env=env,check=True,capture_output=True)
