#!/usr/bin/env python3
"""Qualify exact post-capture opening DDL metadata, never business execution."""
import importlib.util,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
import forward,governance
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
forward.validate(v.ROOT,forward.entries());source=(v.ROOT/forward.OPENING_PATH).read_text();native=(v.BASE/'pokeriq-20261020.sql').read_text()
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));work=Path(tempfile.mkdtemp(prefix='open-',dir=parent));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
def run(args,text=None):
 r=subprocess.run([str(x) for x in args],input=text,text=True,capture_output=True,env=env,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
try:
 run([pg/'initdb','-D',work/'d','-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
 def sql(s):return run(cmd,s)
 def definition(name):
  m=re.search(r'CREATE FUNCTION public\.'+name+r'\(.*?AS (\$\w*\$)(.*?)\1;',native,re.S)
  assert m,name
  return m[0]
 sql('CREATE ROLE postgres;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;GRANT CREATE ON SCHEMA public TO postgres;SET ROLE postgres;ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;SET check_function_bodies=off;'+definition('fn_complete_club_opening_setup')+definition('fn_ca_guard_watchlist')+'REVOKE ALL ON FUNCTION public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean) FROM PUBLIC,anon;')
 # Empty metadata fixture, no function body is invoked. Full runtime gate later
 # applies this same exact file with normal body validation on complete schema.
 # Keep the real writer detector/event guard enabled, rather than bypass it.
 registry=re.search(r'CREATE TABLE public\.ca_money_rpc_registry \(.*?\n\);',native,re.S)[0]
 sql('SET ROLE postgres;'+registry+'ALTER TABLE public.ca_money_rpc_registry ENABLE ROW LEVEL SECURITY;'+definition('fn_ca_money_rpc_balance_columns')+definition('fn_ca_money_rpc_writes_balances')+definition('fn_ca_money_rpc_registry_guard'))
 sql("CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();")
 for wrong in [False,True]:
  if wrong:sql("SET ROLE postgres;INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES('wrong_proname','approved','Does not authorize the target');")
  try:sql('SET ROLE postgres;SET check_function_bodies=off;'+source)
  except RuntimeError as exc:assert '42501' in str(exc) and 'not in ca_money_rpc_registry' in str(exc)
  else:raise AssertionError('Actual guard accepted missing/wrong governance target')
  if wrong:sql("SET ROLE postgres;DELETE FROM public.ca_money_rpc_registry WHERE proname='wrong_proname';")
 # Plain PostgreSQL lacks Supautils delegation to a non-superuser event owner.
 # Keep its real bootstrap owner here; the full image checks captured postgres.
 import copy
 native_contract=copy.deepcopy(governance.load(v.BASE,v.ROOT));native_contract['eventTriggers'][0]['owner']='supabase_admin'
 contract=governance.restore_authorization(sql,native_contract)
 expected=json.loads((v.BASE/'post-capture-opening-catalog.json').read_text())
 before=json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
 opening=[r for r in before['routines'] if r['name']==expected['before']['name']]
 assert opening==[expected['before']]
 assert not any(r['name']=='fn_club_opening_defaults_ready' for r in before['routines'])
 assert v.compare({'routines':expected['routines']},{'routines':opening}),'Missing post-capture delta did not fail'
 sql('SET ROLE postgres;SET check_function_bodies=off;'+source)
 actual=json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
 names={r['name'] for r in expected['routines']};actualr=[r for r in actual['routines'] if r['name'] in names]
 assert actualr==expected['routines'],'Independent two-routine catalog differs'
 governance.verify(sql,contract)
 try:governance.restore_authorization(sql,native_contract)
 except ValueError:pass
 else:raise AssertionError('Existing governance row accepted')
 assert v.compare(forward.opening_expected(before,v.BASE),actual)==[],'Other catalog fields changed'
 try:sql('SET ROLE postgres;'+source)
 except RuntimeError as exc:assert 'QUICK_START_OPENING_PREIMAGE_DRIFT' in str(exc)
 else:raise AssertionError('Already changed preimage accepted')
 bad=json.loads(json.dumps(before));next(r for r in bad['routines'] if r['name']==expected['before']['name'])['owner']='wrong_owner'
 try:forward.opening_expected(bad,v.BASE)
 except ValueError:pass
 else:raise AssertionError('Changed security preimage accepted')
 print('PASS: absent delta fails; exact source DDL matches independent2routine metadata/allothercatalog; changed preimage/security refuse; one governance authorization row; no application rows/business calls.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
