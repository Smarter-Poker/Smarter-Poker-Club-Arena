#!/usr/bin/env python3
"""Native PG17, socket-only maintenance integration on the sealed accounting fixture.
No production DSN or network host option is accepted. External dependency bytes
are copied once and fingerprinted before any local SQL executes.
"""
from pathlib import Path
import argparse, hashlib, json, os, subprocess, tarfile, tempfile
root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--fixture',type=Path,required=True)
p.add_argument('--provider-migration',type=Path,required=True)
p.add_argument('--evidence',type=Path,required=True)
p.add_argument('--integration-script',type=Path,help='Independent owned native composition script; same socket-only fixture contract')
a=p.parse_args()
integration=a.integration_script.resolve(strict=True) if a.integration_script else root/'tests/maintenance/integration.mjs'
input_files=[Path(__file__).resolve(),integration,*sorted((root/'tests/maintenance').glob('current-*.json'))]
input_hashes={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in input_files}
assert hashlib.sha256(a.fixture.read_bytes()).hexdigest()=='6be71661c49edd736ad78bf62582389ecce5cf06b46eb44237ff8a69833693c1'
pg=Path('/opt/homebrew/opt/postgresql@17/bin')
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
work=Path(tempfile.mkdtemp(prefix='ca-e2-owned-',dir='/tmp'));socket=work/'socket';socket.mkdir(mode=0o700)
runtime=work/'source';runtime.mkdir();a.evidence.mkdir(parents=True,exist_ok=True)
state={'cluster':str(work),'socket':str(socket),'port':55496,'database':'e2_bee519fa'}
with tarfile.open(a.fixture) as archive:
 for member in archive.getmembers():
  assert member.isfile() and Path(member.name).name==member.name
  (runtime/member.name).write_bytes(archive.extractfile(member).read())
(runtime/'cluster.json').write_text(json.dumps(state))
provider=runtime/'provider.sql';provider.write_bytes(a.provider_migration.read_bytes())
migration=runtime/'maintenance.sql';migration.write_bytes((root/'supabase/migrations/20260911170215_durable_operation_maintenance_authority.sql').read_bytes())
state['migration_file']=str(migration)
base=[str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-h',str(socket),'-p','55496','-U','postgres']
def command(args,**kw):
 r=subprocess.run(args,env=env,text=True,capture_output=True,**kw)
 if r.returncode:raise RuntimeError((r.stderr+r.stdout)[-7000:])
 return r.stdout

def sql(q,db='e2_bee519fa'):return command(base+['-d',db,'-Atc',q]).strip()
def file(path):return command(base+['-d','e2_bee519fa','-f',str(path)])
started=False
try:
 version=command([str(pg/'postgres'),'--version']).strip();assert ' 17.' in version
 command([str(pg/'initdb'),'-D',str(work/'data'),'--no-locale','-E','UTF8','-U','postgres'])
 command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-l',str(work/'postgres.log'),'-o',f"-h '' -k {socket} -p 55496",'-w','start']);started=True
 sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;','postgres')
 for script in ['load-local.py','seed-local.py']:
  (a.evidence/(script+'.log')).write_text(command(['python3',str(runtime/script)],cwd=runtime))
 # Complete only the four ancillary relations omitted by the tournament fixture,
 # using exact current catalog columns/defaults/constraints. No mocked worker.
 for seq in json.loads((root/'tests/maintenance/current-gameplay-sequences.json').read_text()):
  assert seq['relname']=='ca_seat_stack_rebases_id_seq' and not seq['seqcycle']
  sql('CREATE SEQUENCE public.'+seq['relname']+' AS '+seq['type']+' START '+str(seq['seqstart'])+' INCREMENT '+str(seq['seqincrement'])+' MINVALUE '+str(seq['seqmin'])+' MAXVALUE '+str(seq['seqmax'])+' CACHE '+str(seq['seqcache'])+' NO CYCLE')
 catalogs=json.loads((root/'tests/maintenance/current-ancillary-catalog.json').read_text())['rows']+json.loads((root/'tests/maintenance/current-gameplay-catalog.json').read_text())+json.loads((root/'tests/maintenance/current-gameplay-settlement-catalog.json').read_text())
 generated={(r['relname'],r['attname']):r['attgenerated'] for r in json.loads((root/'tests/maintenance/current-gameplay-generated-columns.json').read_text())}
 for table in catalogs:
  if sql("SELECT to_regclass('public."+table['relname']+"') IS NOT NULL")=='t':continue
  columns=[]
  for col in table['columns']:
   generation=generated.get((table['relname'],col['name']))
   assert generation in (None,'s')
   expression=(' GENERATED ALWAYS AS ('+col['default']+') STORED') if generation else (' DEFAULT '+col['default'] if col['default'] else '')
   columns.append('"'+col['name']+'" '+col['type']+expression+(' NOT NULL' if col['notnull'] else ''))
  columns += ['CONSTRAINT "'+c['name']+'" '+c['definition'] for c in table['constraints'] or []]
  sql('CREATE TABLE public.'+table['relname']+'('+','.join(columns)+');')
  for trigger in table.get('triggers') or []:
   assert trigger['enabled']=='O'
   sql(trigger['function_definition']+';'+trigger['definition']+';')
 for t in json.loads((root/'tests/maintenance/current-ancillary-triggers.json').read_text())['rows']:
  sql(t['function_definition']+'; '+t['definition']+';')
 # Install exact observed source and ACLs, including live 35-second RPC config.
 for r in json.loads((root/'tests/maintenance/current-authority.json').read_text())+json.loads((root/'tests/maintenance/current-gameplay-authority.json').read_text()):
  sig='public.'+r['signature'];sql(r['definition']+';')
  acl=r['proacl'];acl=acl if isinstance(acl,list) else acl.strip('{}').split(',')
  grantees=[]
  for entry in acl:
   who,rights=entry.split('=',1)
   if 'X' in rights.split('/')[0]:grantees.append(who or 'PUBLIC')
  sql('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+(' GRANT EXECUTE ON FUNCTION '+sig+' TO '+','.join(grantees)+';' if grantees else ''))
  assert sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+sig+"'::regprocedure")==r['body_md5']
 file(root/'supabase/migrations/20260911151748_private_global_release_journal.sql')
 file(provider)
 # Negative catalog precondition happens on the actual migration transaction.
 sql('CREATE DATABASE maintenance_preflight TEMPLATE e2_bee519fa','postgres')
 file(migration)
 (a.evidence/'cluster.json').write_text(json.dumps(state))
 result=command(['node',str(integration),str(a.evidence/'cluster.json'),str(a.evidence)],cwd=root)
 assert all(hashlib.sha256(path.read_bytes()).hexdigest()==input_hashes[str(path)] for path in input_files),'native proof inputs changed during execution'
 (a.evidence/'native.log').write_text(result)
 receipt={'status':'passed','postgres':version,'source_fixture_sha256':hashlib.sha256(a.fixture.read_bytes()).hexdigest(),
  'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'integration_sha256':hashlib.sha256(integration.read_bytes()).hexdigest(),'provider_sha256':hashlib.sha256(provider.read_bytes()).hexdigest(),
  'input_sha256':input_hashes,'cases':json.loads((a.evidence/'cases.json').read_text())}
 (a.evidence/'result.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
finally:
 if started:command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-m','fast','-w','stop'])
