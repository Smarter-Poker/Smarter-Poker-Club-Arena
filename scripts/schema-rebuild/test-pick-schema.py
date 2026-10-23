#!/usr/bin/env python3
"""One exact post-capture routine DDL; no prize/choice or business execution."""
import importlib.util,json,os,re,shutil,subprocess,tempfile,copy,hashlib
from pathlib import Path
import forward
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
forward.validate(v.ROOT,forward.entries());source=(v.ROOT/forward.PICK_PATH).read_text();native=(v.BASE/'pokeriq-20261020.sql').read_text();delta=json.loads((v.BASE/'post-capture-pick-catalog.json').read_text())
assert hashlib.md5(re.search(r'AS \$fn\$(.*?)\$fn\$;',source,re.S)[1].encode()).hexdigest()==delta['source']['bodyMD5']
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));work=Path(tempfile.mkdtemp(prefix='pick-',dir=parent));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
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
 original=re.search(r'CREATE FUNCTION public\.fn_mystery_bounty_pick\(.*?AS (\$\w*\$)(.*?)\1;',native,re.S)[0]
 sql('CREATE ROLE postgres;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;GRANT CREATE ON SCHEMA public TO postgres;SET ROLE postgres;SET check_function_bodies=off;'+original+'REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pick(uuid,integer) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pick(uuid,integer) TO authenticated,service_role;')
 # Metadata expectation only: bodies remain uncalled. Actual complete-schema
 # application later retains normal function-body validation and event guards.
 query=(v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text();before=json.loads(sql(query));actualbefore=next(r for r in before['routines'] if r['name']==delta['before']['name']);assert actualbefore==delta['before']
 expected=forward.pick_expected(before,v.BASE);assert v.compare(expected,before),'Missing post-capture routine change accepted'
 sql('SET ROLE postgres;SET check_function_bodies=off;'+source)
 actual=json.loads(sql(query));assert v.compare(expected,actual)==[],'Independent1routine/allothercatalog differs'
 for key,value in [('owner','wrong_owner'),('definition_md5','0'*32)]:
  bad=copy.deepcopy(before);bad['routines'][0][key]=value
  try:forward.pick_expected(bad,v.BASE)
  except ValueError:pass
  else:raise AssertionError('Changed full preimage accepted')
 altered=copy.deepcopy(expected);altered['routines'][0]['acl']=[];assert v.compare(altered,actual),'Lost execution ACL accepted'
 print('PASS: old routine fails expected postimage; exact original source matches independent1routine/allothercatalog; changed preimage/security/ACL refuse; zero rows/business calls.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
