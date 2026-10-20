#!/usr/bin/env python3
"""Rebuild all captured schemas in a disposable PG17 Unix-only cluster.
No URL/credential input or existing database target is supported.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'supabase/bootstrap'
class Refused(RuntimeError):pass
def q(x):return '"'+x.replace('"','""')+'"'
def lit(x):return "'"+str(x).replace("'","''")+"'"
def canonical(value):
 if isinstance(value,dict):
  return {k:canonical(v) for k,v in value.items()}
 if isinstance(value,list):return [canonical(x) for x in value]
 return value
def compare(expected,actual):
 # Compare independently captured source metadata, not a second local dump.
 differences=[]
 for category in sorted(set(expected)|set(actual)):
  e=canonical(expected.get(category));a=canonical(actual.get(category))
  if e!=a:
   es={json.dumps(x,sort_keys=True) for x in e or []};as_={json.dumps(x,sort_keys=True) for x in a or []}
   differences.append({'category':category,'expectedCount':len(e or []),'actualCount':len(a or []),'missingOrChanged':len(es-as_),'extraOrChanged':len(as_-es)})
 return differences
def validate_parent(path):
 path=Path(path).absolute()
 if not path.is_dir() or path.resolve()!=path:raise Refused('Owned real scratch directory required')
 if sys.platform=='darwin' and not path.is_relative_to('/Volumes/SmarterWork/agent-work'):raise Refused('Mac scratch must be on external SSD')
 if len(str(path).encode())>76:raise Refused('Use shorter scratch path for native Unix socket')
 return path
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--scratch',required=True);ap.add_argument('--result',required=True);ap.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));args=ap.parse_args()
 parent=validate_parent(args.scratch);output=Path(args.result).absolute()
 if sys.platform=='darwin' and not any(output.is_relative_to(root) for root in ['/Volumes/SmarterWork/agent-work','/Volumes/SmarterArchives/agent-evidence']):raise Refused('Mac result must be on an external task volume')
 if output.exists() or not output.parent.is_dir() or output.parent.resolve()!=output.parent:raise Refused('New result file in a real existing directory required')
 output.write_text(json.dumps({'schemaRebuilt':False,'status':'started'})+'\n');os.chmod(output,0o600)
 pg=Path(args.pg_bin);manifest=json.loads((BASE/'pokeriq-baseline.json').read_text());contract=json.loads((BASE/'pokeriq-role-contract.json').read_text());platform=json.loads((BASE/'pokeriq-platform-contract.json').read_text())['database'];source=(BASE/manifest['schemaFile']).read_bytes()
 if hashlib.sha256(source).hexdigest()!=manifest['schemaSHA256']:raise Refused('Baseline source checksum differs')
 if any(os.environ.get(k) for k in ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','DATABASE_URL','SUPABASE_DB_URL']):raise Refused('Remote or caller-provided database settings are forbidden')
 if os.geteuid()==0:raise Refused('Run PostgreSQL as an unprivileged local user')
 work=Path(tempfile.mkdtemp(prefix='sr-',dir=parent));data=work/'d';socket=work/'s';socket.mkdir(mode=0o700);env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGAPPNAME']='isolated-schema-rebuild';started=False
 def run(command,input=None,limit=180):
  r=subprocess.run([str(x) for x in command],input=input,text=True,capture_output=True,env=env,timeout=limit)
  if r.returncode:
   # Provider source never appears in output. Exact local diagnostic retained
   # privately in owned scratch; final report carries only SQLSTATE/line.
   (work/'failure.log').write_text(r.stderr);os.chmod(work/'failure.log',0o600)
   diagnostic={'schemaRebuilt':False,'status':'failed','phase':Path(str(command[0])).name,'sqlstate':(re.search(r'(?m)^ERROR:\s+([A-Z0-9]{5}):',r.stderr).group(1) if re.search(r'(?m)^ERROR:\s+([A-Z0-9]{5}):',r.stderr) else None),'line':(int(re.search(r':(\d+): (?:ERROR|FATAL):',r.stderr).group(1)) if re.search(r':(\d+): (?:ERROR|FATAL):',r.stderr) else None),'rawDiagnostic':'ephemeral owned scratch only; never uploaded'}
   output.write_text(json.dumps(diagnostic)+'\n')
   raise Refused('Local PostgreSQL command failed; private diagnostic '+str(work/'failure.log'))
  return r.stdout.strip()
 try:
  version=run([pg/'postgres','--version'])
  if not re.search(r'\b17\.',version):raise Refused('PostgreSQL17 required')
  run([pg/'initdb','-D',data,'-U','schema_restore_owner','--auth-local=trust','--auth-host=reject','--locale-provider=icu','--icu-locale='+platform['locale'],'--lc-collate='+platform['collate'],'--lc-ctype='+platform['ctype'],'-E',platform['encoding']])
  with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+lit(socket)+"\nshared_buffers='32MB'\nshared_preload_libraries='pg_cron,pg_net,pg_stat_statements,supautils'\ncron.database_name='postgres'\ncron.launch_active_jobs=off\n")
  runtime=json.loads((BASE/'pokeriq-extension-runtime.json').read_text())
  allowed={'supautils.privileged_extensions','supautils.privileged_extensions_superuser','supautils.privileged_role','supautils.superuser'}
  with (data/'postgresql.conf').open('a') as f:
   for setting in runtime['settings']:
    if setting['name'] not in allowed:raise Refused('Unreviewed extension runtime setting')
    f.write(setting['name']+'='+lit(setting['setting'])+'\n')
  run([pg/'pg_ctl','-D',data,'-l',work/'server.log','-w','start']);started=True
  cmd=[pg/'psql','-X','-qAt','-h',socket,'-U','schema_restore_owner','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
  def sql(s):return run(cmd,s)
  available=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('name',name,'version',version)) FROM pg_available_extension_versions;"));have={(x['name'],x['version']) for x in available}
  missing=[(x['name'],x['version']) for x in contract['extensions'] if (x['name'],x['version']) not in have]
  if missing:raise Refused('Faithful extension runtime unavailable: '+json.dumps(missing))
  # Match source role capabilities and membership. Login is always refused in
  # the disposable target; no source passwords or role authentication exist.
  for role in contract['roles']:
   name=role['name']
   if name.startswith('pg_'):continue
   flags=['SUPERUSER' if role['superuser'] else 'NOSUPERUSER','INHERIT' if role['inherit'] else 'NOINHERIT','CREATEROLE' if role['createrole'] else 'NOCREATEROLE','CREATEDB' if role['createdb'] else 'NOCREATEDB','REPLICATION' if role['replication'] else 'NOREPLICATION','BYPASSRLS' if role['bypassrls'] else 'NOBYPASSRLS','NOLOGIN','CONNECTION LIMIT '+str(role['connectionlimit'])]
   sql('CREATE ROLE '+q(name)+' '+' '.join(flags)+';')
   for setting in role.get('config') or []:
    key,value=setting.split('=',1)
    if not re.fullmatch(r'[a-z_][a-z0-9_.]*',key):raise Refused('Invalid captured role setting name')
    sql('BEGIN;SELECT set_config('+lit(key)+','+lit(value)+',true);ALTER ROLE '+q(name)+' SET '+q(key)+' FROM CURRENT;COMMIT;')
  for member in contract['memberships']:
   sql('GRANT '+q(member['role'])+' TO '+q(member['member'])+' WITH ADMIN '+str(member['admin']).upper()+', INHERIT '+str(member['inherit']).upper()+', SET '+str(member['set']).upper()+' GRANTED BY '+q(member['grantor'])+';')
  sql('ALTER DATABASE postgres OWNER TO '+q(platform['owner'])+';')
  actualplatform=json.loads(sql("SELECT jsonb_build_object('owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',to_jsonb(d)->>'datlocale','collation_version',datcollversion,'icu_rules',to_jsonb(d)->>'daticurules') FROM pg_database d WHERE datname=current_database();"))
  if actualplatform!=platform:raise Refused('Source database locale/collation runtime differs: '+json.dumps(actualplatform))
  # Provider extensions are real installed versions, created under their exact
  # captured owner. This explicit baseline normalization changes no app DDL.
  builtin=next(x for x in contract['extensions'] if x['name']=='plpgsql')
  sql('DROP EXTENSION plpgsql;SET ROLE '+q(builtin['owner'])+';CREATE EXTENSION plpgsql WITH SCHEMA '+q(builtin['schema'])+' VERSION '+lit(builtin['version'])+';RESET ROLE;')
  rendered=source.decode()
  for extension in contract['extensions']:
   if extension['name']=='plpgsql':continue
   pattern=r'^CREATE EXTENSION IF NOT EXISTS '+re.escape(q(extension['name']) if '-' in extension['name'] else extension['name'])+r' WITH SCHEMA [^;]+;'
   replacement='SET ROLE '+q(extension['owner'])+';\nCREATE EXTENSION IF NOT EXISTS '+q(extension['name'])+' WITH SCHEMA '+q(extension['schema'])+' VERSION '+lit(extension['version'])+';\nRESET ROLE;'
   rendered,n=re.subn(pattern,lambda m:replacement,rendered,flags=re.M)
   if n!=1:raise Refused('Extension baseline anchor differs: '+extension['name'])
  # Fresh setup has no Supabase default grants before any object is created.
  sql("CREATE TABLE public.__no_default_probe(id int);DO $$ BEGIN IF has_table_privilege('anon','public.__no_default_probe','SELECT') OR has_table_privilege('authenticated','public.__no_default_probe','INSERT') OR has_table_privilege('service_role','public.__no_default_probe','SELECT') THEN RAISE EXCEPTION 'Unexpected default API privilege'; END IF; END $$;DROP TABLE public.__no_default_probe;")
  restore=work/'restore.sql';restore.write_text(rendered);os.chmod(restore,0o600)
  run(cmd+['--single-transaction','-f',restore],limit=300)
  # Compare role capabilities/configuration independently; NOLOGIN is the only
  # declared containment difference from source. Passwords are never queried.
  rolequery="SELECT jsonb_agg(jsonb_build_object('name',rolname,'inherit',rolinherit,'canlogin',rolcanlogin,'createdb',rolcreatedb,'bypassrls',rolbypassrls,'superuser',rolsuper,'createrole',rolcreaterole,'replication',rolreplication,'connectionlimit',rolconnlimit,'config',rolconfig) ORDER BY rolname) FROM pg_roles WHERE rolname IN ("+','.join(lit(r['name']) for r in contract['roles'])+");"
  actualroles=json.loads(sql(rolequery));expectedroles=[]
  for role in contract['roles']:
   role=dict(role)
   if not role['name'].startswith('pg_'):role['canlogin']=False
   expectedroles.append(role)
  for roles in [actualroles,expectedroles]:
   for role in roles:role['config']=sorted(role.get('config') or [])
  if sorted(actualroles,key=lambda x:x['name'])!=sorted(expectedroles,key=lambda x:x['name']):raise Refused('Source role capability/configuration comparison differs')
  actualmembers=json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option)),'[]'::jsonb) FROM pg_auth_members;"))
  if {json.dumps(x,sort_keys=True) for x in actualmembers}!={json.dumps(x,sort_keys=True) for x in contract['memberships']}:raise Refused('Source role membership comparison differs')
  catalog=json.loads(sql((ROOT/'scripts/schema-rebuild/catalog.sql').read_text()));
  if any(x['count'] for x in catalog['unsupported_objects']):raise Refused('Catalog contains unsupported object families')
  expected=json.loads((BASE/'pokeriq-catalog-reference.json').read_text());differences=compare(expected,catalog)
  receipt={'schemaRebuilt':not differences,'baselineSHA256':manifest['schemaSHA256'],'counts':{k:len(v or []) for k,v in catalog.items()},'differences':differences,'noHistoricalDataReplay':True,'remoteConnections':False,'applicationFixtureRowsInserted':False,'extensionVersionsExact':True,'databasePlatformExact':True,'roleLoginContainment':'all source roles NOLOGIN; local Unix-only bootstrap owner','roleCapabilitiesAndMembershipsCompared':True,'defaultGrantBoundary':'Fresh empty-cluster probe denies API rights before baseline; fidelity restore retains captured default ACLs. Existing caller grant fixtures separately qualify withdrawal.'}
  output.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
  if differences:raise Refused('Independent source catalog comparison differs')
 finally:
  if 'receipt' not in locals() and json.loads(output.read_text()).get('status')=='started':output.write_text(json.dumps({'schemaRebuilt':False,'status':'failed','rawDiagnostic':'ephemeral owned scratch only; never uploaded'})+'\n')
  if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
  # Failed private diagnostics stay only in owned scratch for diagnosis. No
  # running cluster survives a failure, and successful scratch is removed.
  if 'receipt' in locals() and receipt.get('schemaRebuilt'):shutil.rmtree(work)
if __name__=='__main__':
 try:main()
 except (Refused,OSError,subprocess.SubprocessError) as exc:print(str(exc),file=sys.stderr);sys.exit(1)
