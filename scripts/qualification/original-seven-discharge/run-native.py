#!/usr/bin/env python3
"""Own one disposable native cluster; qualify the finite original7 money door."""
import argparse,json,os,pathlib,shutil,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path,required=True);args=parser.parse_args()
out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
pg=pathlib.Path(os.environ.get('PG_BIN',str(pathlib.Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
if sys.platform=='darwin':
 base=pathlib.Path('/Volumes/SmarterWork/agent-work')
 if not base.is_dir() or not pathlib.Path('/Volumes/SmarterWork').is_mount():raise RuntimeError('SSD required')
else:
 base=pathlib.Path(os.environ.get('TMPDIR',str(out.parent))).resolve()
 if str(base).startswith('/tmp') and sys.platform=='darwin':raise RuntimeError('internal scratch refused')
cluster=pathlib.Path(tempfile.mkdtemp(prefix='seven-money-',dir=base));socket=cluster/'s';socket.mkdir(mode=0o700)
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C';env['TZ']='UTC';env['PG_BIN']=str(pg)
port='55943';started=False
def execute(argv,stdin=None):return subprocess.run([str(x) for x in argv],input=stdin,text=True,capture_output=True,env=env,timeout=45)
try:
 for name,argv in [('initdb',[pg/'initdb','-D',cluster/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']),('start',[pg/'pg_ctl','-D',cluster/'d','-l',cluster/'server.log','-o',f"-k {socket} -p {port} -h ''",'-w','start'])]:
  r=execute(argv);(out/(name+'.log')).write_text(r.stdout+r.stderr)
  if r.returncode:raise RuntimeError(name+': '+r.stderr)
  if name=='start':started=True
 r=execute([pg/'createdb','-h',socket,'-p',port,'-U','postgres','discharge_native'])
 if r.returncode:raise RuntimeError(r.stderr)
 command=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','discharge_native']
 files=['bootstrap-complete.sql','actual-seven-source-schema.sql','actual-seven-source-rows.sql','actual-seven-source-cases.sql','actual-seven-source-getters.sql']
 for file in files:
  r=execute(command+['-f',root/'fixtures'/file]);(out/(file+'.log')).write_text(r.stdout+r.stderr)
  if r.returncode:raise RuntimeError(file+': '+r.stderr)
 r=execute(command+['-f',root/'discharge.sql']);(out/'install.log').write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(r.stderr)
 consumer=root.parent/'original-retirement-boundary'/'original-erased-discharge-flow-proposal.sql'
 r=execute(command,"CREATE TABLE public.union_pnl_original_flows(ledger_id uuid PRIMARY KEY,transaction_id xid8 NOT NULL,recognized_at timestamptz NOT NULL,game_scope jsonb NOT NULL,ledger_snapshot jsonb NOT NULL);"+consumer.read_text())
 if r.returncode:raise RuntimeError(r.stderr)
 held=root.parent/'original-retirement-boundary'/'original-erased-receivable-proposal.sql'
 r=execute(command,"CREATE TABLE smarter_private.original_inventory_restoration_certificates(event_id bigint PRIMARY KEY,boundary timestamptz,witness_md5 text,original_witness jsonb,proof jsonb,proof_md5 text);INSERT INTO smarter_private.original_inventory_restoration_certificates SELECT event_id,'2026-10-12 07:00:00Z',witness_md5,original_witness,smarter_private.original_erased_cash_base_proof(original_witness,'2026-10-12 07:00:00Z'),md5(smarter_private.original_erased_cash_base_proof(original_witness,'2026-10-12 07:00:00Z')::text) FROM smarter_private.original_inventory_restoration_cases;"+held.read_text())
 (out/'current-seven-consumer-install.log').write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(r.stderr)
 expected=json.loads((root/'monetary-function-pins.json').read_text())
 source_pins=[]
 for signature,expected_md5 in expected.items():
  qualified=signature if signature.startswith('auth.') else 'public.'+signature
  r=execute(command,"SELECT md5(pg_get_functiondef('"+qualified+"'::regprocedure));")
  observed=r.stdout.strip();source_pins.append({'signature':qualified,'expected':expected_md5,'actual':observed,'equal':observed==expected_md5})
  if r.returncode or observed!=expected_md5:raise RuntimeError('actual monetary source changed:'+qualified)
 (out/'source-pins.json').write_text(json.dumps(source_pins,indent=2))
 r=execute([sys.executable,root/'test-discharge.py','--socket',socket,'--port',port,'--database','discharge_native','--output',out/'cases'])
 (out/'native.log').write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(r.stderr)
 (out/'result.json').write_text(json.dumps({'status':'passed','money_functions':len(source_pins),'actual_original_refs':101,'cases':json.loads((out/'cases/results.json').read_text()),'boundary':'isolated_native_not_production'},indent=2))
 print('Finite original seven maintained money request: PASS')
finally:
 if started:
  r=execute([pg/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop']);(out/'stop.log').write_text(r.stdout+r.stderr)
  if r.returncode:raise RuntimeError('own native cluster did not stop: '+r.stderr)
 if (cluster/'server.log').exists():shutil.copyfile(cluster/'server.log',out/'server.log')
 shutil.rmtree(cluster)
