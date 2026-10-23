#!/usr/bin/env python3
"""Rebuild all captured schemas in a disposable PG17 Unix-only cluster.
No URL/credential input or existing database target is supported.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
import fidelity,forward,governance
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'supabase/bootstrap'
AUDITED_SOURCE_REVISION='ffa19fa61761da13c73b4442558a477704cbccca'
QUALIFICATION_SCOPE='fixed audit schema-only baseline plus four declared transitions; later migrations excluded'
class Refused(RuntimeError):pass
def q(x):return '"'+x.replace('"','""')+'"'
def lit(x):return "'"+str(x).replace("'","''")+"'"
def canonical(value):
 if isinstance(value,dict):
  return {k:canonical(v) for k,v in value.items()}
 if isinstance(value,list):return [canonical(x) for x in value]
 return value
def metadata_value(value,field):
 # SQL expressions/comments may contain arbitrary literals. Identify their
 # differences without ever uploading expression text or routine bodies.
 encoded=json.dumps(value,sort_keys=True,separators=(',',':'))
 if isinstance(value,(dict,list)) or field in {'definition','view','default','comment','settings'} or len(encoded)>240:
  return {'sha256':hashlib.sha256(encoded.encode()).hexdigest(),'characters':len(encoded)}
 if isinstance(value,str):
  if re.search(r'(?:https?|postgres(?:ql)?)://|eyJ[A-Za-z0-9_-]+\.|(?:sbp_|sb_secret_|sk_live_|sk_test_|ghp_|github_pat_)',value,re.I):return '[redacted value]'
 return value
def field_differences(expected,actual,path='',limit=24):
 fields=[];count=0
 def walk(e,a,p,field):
  nonlocal count
  if e==a:return
  if isinstance(e,dict) and isinstance(a,dict):
   for key in sorted(set(e)|set(a)):walk(e.get(key),a.get(key),p+'.'+key if p else key,key)
  elif isinstance(e,list) and isinstance(a,list):
   if all(isinstance(x,dict) and 'name' in x for x in e+a):
    em={x['name']:x for x in e};am={x['name']:x for x in a}
    if len(em)==len(e) and len(am)==len(a):
     for name in sorted(set(em)|set(am)):walk(em.get(name),am.get(name),p+'['+name+']',field)
     if set(em)==set(am) and e!=a and all(em[k]==am[k] for k in em):walk('captured order','different order',p,field)
     return
   for index in range(max(len(e),len(a))):walk(e[index] if index<len(e) else None,a[index] if index<len(a) else None,p+'['+str(index)+']',field)
  else:
   count+=1
   if len(fields)<limit:fields.append({'field':p,'expected':metadata_value(e,field),'actual':metadata_value(a,field)})
 walk(expected,actual,path,'')
 return {'fields':fields,'fieldCount':count,'omittedFields':max(0,count-len(fields))}
def object_identity(value):
 if isinstance(value,dict):
  if 'name' in value:return '.'.join(str(value[k]) for k in ['schema','name'] if k in value)+(('('+value['args']+')') if 'args' in value else '')
  if 'object' in value:return str(value['object'])
 return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
def compare(expected,actual):
 # Every value still participates in strict comparison. Diagnostics are bounded
 # metadata-only object/field identities, never a reason to ignore a mismatch.
 differences=[];remaining=100
 for category in sorted(set(expected)|set(actual)):
  e=canonical(expected.get(category));a=canonical(actual.get(category))
  # Comments are an unordered catalog collection; retain duplicates and every
  # field while avoiding Python versus database ICU collation differences.
  if category=='comments':
   key=lambda value:json.dumps(value,sort_keys=True,separators=(',',':'))
   if isinstance(e,list):e=sorted(e,key=key)
   if isinstance(a,list):a=sorted(a,key=key)
  if e!=a:
   es={json.dumps(x,sort_keys=True) for x in e or []};as_={json.dumps(x,sort_keys=True) for x in a or []}
   em={object_identity(x):x for x in e or []};am={object_identity(x):x for x in a or []};details=[];changed=0
   for identity in sorted(set(em)|set(am)):
    if em.get(identity)!=am.get(identity):
     changed+=1
     if remaining:
      details.append(dict(object=metadata_value(identity,'object'),**field_differences(em.get(identity),am.get(identity))))
      remaining-=1
   differences.append({'category':category,'expectedCount':len(e or []),'actualCount':len(a or []),'missingOrChanged':len(es-as_),'extraOrChanged':len(as_-es),'objectDifferences':details,'omittedObjects':changed-len(details),'arrayOrderDiffers':es==as_})
 return differences
def validate_parent(path):
 path=Path(path).absolute()
 if not path.is_dir() or path.resolve()!=path:raise Refused('Owned real scratch directory required')
 if sys.platform=='darwin' and not path.is_relative_to('/Volumes/SmarterWork/agent-work'):raise Refused('Mac scratch must be on external SSD')
 if len(str(path).encode())>76:raise Refused('Use shorter scratch path for native Unix socket')
 return path
def derive_lock_budget(reference,max_connections=100):
 relations=reference.get('relations') or []
 explicit=len(relations)+sum(len(r.get('indexes') or []) for r in relations)
 # A stored relation can additionally create a TOAST table and its index.
 toast=2*sum(r.get('kind') in ('r','m') for r in relations)
 named=sum(len(reference.get(k) or []) for k in ['routines','types','schemas','event_triggers','publications','defaults','extensions'])+sum(len(r.get(k) or []) for r in relations for k in ['constraints','triggers','policies','rules'])
 # One tag per named object, implicit physical relation, and an additional
 # explicit-relation/index allowance for dependency/catalog locks.
 slots=explicit+toast+named+explicit
 value=64
 while value*max_connections<slots:value*=2
 if value>16384:raise Refused('Captured schema exceeds bounded isolated lock budget')
 return {'maxConnections':max_connections,'explicitRelationsAndIndexes':explicit,'sequencesIncludedInRelations':sum(r.get('kind')=='S' for r in relations),'implicitToastAllowance':toast,'namedObjectAllowance':named,'dependencyMargin':explicit,'minimumLockSlots':slots,'maxLocksPerTransaction':value}
def safe_error_line(value,context):
 allowed={str(x) for x in context.values()}|{'max_locks_per_transaction'}
 value=re.sub(r'(?:https?|postgres(?:ql)?)://[^\s]+','[redacted-url]',value,flags=re.I)
 value=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[redacted-token]',value)
 value=re.sub(r'(?<![A-Za-z0-9_])(?:sbp_|sb_secret_|sk_live_|sk_test_|ghp_|github_pat_)[A-Za-z0-9_]+','[redacted-token]',value)
 value=re.sub(r'"([^"\n]*)"',lambda m:'"'+m[1]+'"' if m[1] in allowed else '"[redacted]"',value)
 value=re.sub(r"'[^'\n]*'","'[redacted]'",value)
 value=re.sub(r'(?<![A-Za-z0-9_])[A-Za-z0-9_/+=-]{32,}(?![A-Za-z0-9_])','[redacted-token]',value)
 return value[:240]
def failure_diagnostic(stderr,phase,context,command):
 header=re.search(r'(?:ERROR|FATAL):\s+([A-Z0-9]{5}):\s*([^\n]*)',stderr)
 result={'auditedSourceRevision':AUDITED_SOURCE_REVISION,'qualificationScope':QUALIFICATION_SCOPE,'laterMigrationsExcluded':True,'schemaRebuilt':False,'status':'failed','phase':phase,'context':context,'command':Path(str(command)).name,'sqlstate':header[1] if header else None,'message':safe_error_line(header[2],context) if header else 'PostgreSQL rejected the command; raw source and detail are omitted','line':int(re.search(r':(\d+): (?:ERROR|FATAL):',stderr)[1]) if re.search(r':(\d+): (?:ERROR|FATAL):',stderr) else None,'rawDiagnostic':'ephemeral owned scratch only; never uploaded'}
 hint=re.search(r'^HINT:\s*([^\n]*)',stderr,re.M)
 if hint:result['hint']=safe_error_line(hint[1],context)
 return result
def render_event_trigger_owners(source,reference,contract):
 owners={r['name'] for r in contract['roles']};routines={(r['schema']+'.'+r['name']+'()'):r for r in reference['routines'] if not r['args']}
 for trigger in reference['event_triggers']:
  name=trigger['name'];owner=trigger['owner'];function=trigger['function']
  if owner not in owners or function not in routines or routines[function]['owner']!=owner:raise Refused('Captured event trigger owner/function contract differs: '+name)
  identifier=q(name) if not re.fullmatch(r'[a-z_][a-z0-9_]*',name) else name
  pattern=r'^CREATE EVENT TRIGGER '+re.escape(identifier)+r' ON '+re.escape(trigger['event'])+r'\n.*?;'
  matches=list(re.finditer(pattern,source,re.M|re.S))
  if len(matches)!=1 or not re.search(r'EXECUTE FUNCTION\s+'+re.escape(function)+r';$',matches[0][0]):raise Refused('Event trigger baseline anchor differs: '+name)
  statement=matches[0][0];source=source[:matches[0].start()]+'SET ROLE '+q(owner)+';\n'+statement+'\nRESET ROLE;'+source[matches[0].end():]
 if len(re.findall(r'^CREATE EVENT TRIGGER ',source,re.M))!=len(reference['event_triggers']):raise Refused('Uncaptured event trigger baseline statement')
 return source
def bootstrap_roles(sql,contract,bootstrap):
 for role in contract['roles']:
  name=role['name']
  if name.startswith('pg_'):continue
  flags=['SUPERUSER' if role['superuser'] else 'NOSUPERUSER','INHERIT' if role['inherit'] else 'NOINHERIT','CREATEROLE' if role['createrole'] else 'NOCREATEROLE','CREATEDB' if role['createdb'] else 'NOCREATEDB','REPLICATION' if role['replication'] else 'NOREPLICATION','BYPASSRLS' if role['bypassrls'] else 'NOBYPASSRLS','NOLOGIN','CONNECTION LIMIT '+str(role['connectionlimit'])]
  sql(('ALTER ROLE ' if name==bootstrap else 'CREATE ROLE ')+q(name)+' '+' '.join(flags)+';',phase='role-capabilities',role=name)
  for setting in role.get('config') or []:
   key,value=setting.split('=',1)
   if not re.fullmatch(r'[a-z_][a-z0-9_.]*',key):raise Refused('Invalid captured role setting name')
   if key=='search_path':
    identifier=r'(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)'
    if not re.fullmatch(r'\s*'+identifier+r'(?:\s*,\s*'+identifier+r')*\s*',value):raise Refused('Captured search_path is not a safe identifier list')
    rendered=value
   else:rendered=lit(value)
   sql('ALTER ROLE '+q(name)+' SET '+q(key)+' TO '+rendered+';',phase='role-setting',role=name,setting=key)
 for member in contract['memberships']:
  sql('SET ROLE '+q(member['grantor'])+';GRANT '+q(member['role'])+' TO '+q(member['member'])+' WITH ADMIN '+str(member['admin']).upper()+', INHERIT '+str(member['inherit']).upper()+', SET '+str(member['set']).upper()+' GRANTED BY '+q(member['grantor'])+';RESET ROLE;',phase='role-membership',role=member['role'],member=member['member'],grantor=member['grantor'])
def require_builtin_extension(sql,expected):
 actual=json.loads(sql("SELECT jsonb_build_object('name',e.extname,'owner',pg_get_userbyid(e.extowner),'schema',n.nspname,'version',e.extversion) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname="+lit(expected['name'])+';',phase='extension-initial-contract',extension=expected['name'],owner=expected['owner']))
 if actual!=expected:raise Refused('Initial builtin extension differs from captured metadata: '+json.dumps(actual))
 return actual
def apply_pending_schema(run,cmd,root,work,entries,before_apply=None):
 forward.validate(root,entries)
 if not work.is_dir() or work.resolve()!=work:raise Refused('Pending schema requires real owned scratch')
 for index,entry in enumerate(entries):
  if before_apply:before_apply(entry)
  source=(root/entry['path']).read_bytes()
  if hashlib.sha256(source).hexdigest()!=entry['sha256']:raise Refused('Pending schema changed before staging')
  # PostgreSQL wrappers see only the bind-mounted scratch, never host sources.
  staged=work/('pending-'+str(index)+'.sql')
  fd=os.open(staged,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as output:output.write(source)
  run(cmd+['-c','SET ROLE postgres;','-f',staged,'-c','RESET ROLE;'],limit=300,phase='pending-schema-restore',context={'sourceFile':entry['path']})
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--scratch',required=True);ap.add_argument('--result',required=True);ap.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));args=ap.parse_args()
 parent=validate_parent(args.scratch);output=Path(args.result).absolute()
 if sys.platform=='darwin' and not any(output.is_relative_to(root) for root in ['/Volumes/SmarterWork/agent-work','/Volumes/SmarterArchives/agent-evidence']):raise Refused('Mac result must be on an external task volume')
 if output.exists() or not output.parent.is_dir() or output.parent.resolve()!=output.parent:raise Refused('New result file in a real existing directory required')
 output.write_text(json.dumps({'auditedSourceRevision':AUDITED_SOURCE_REVISION,'qualificationScope':QUALIFICATION_SCOPE,'laterMigrationsExcluded':True,'schemaRebuilt':False,'status':'started'})+'\n');os.chmod(output,0o600)
 pg=Path(args.pg_bin);manifest=json.loads((BASE/'pokeriq-baseline.json').read_text());contract=json.loads((BASE/'pokeriq-role-contract.json').read_text());platform=json.loads((BASE/'pokeriq-platform-contract.json').read_text())['database'];source=(BASE/manifest['schemaFile']).read_bytes()
 if hashlib.sha256(source).hexdigest()!=manifest['schemaSHA256']:raise Refused('Baseline source checksum differs')
 if any(os.environ.get(k) for k in ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','DATABASE_URL','SUPABASE_DB_URL']):raise Refused('Remote or caller-provided database settings are forbidden')
 if os.geteuid()==0:raise Refused('Run PostgreSQL as an unprivileged local user')
 work=Path(tempfile.mkdtemp(prefix='sr-',dir=parent));data=work/'d';socket=work/'s';socket.mkdir(mode=0o700);env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGAPPNAME']='isolated-schema-rebuild';started=False;last_operation={'phase':'setup','context':{}}
 def run(command,input=None,limit=180,phase=None,context=None):
  last_operation.update(phase=phase or Path(str(command[0])).name,context=context or {})
  r=subprocess.run([str(x) for x in command],input=input,text=True,capture_output=True,env=env,timeout=limit)
  if r.returncode:
   # Provider source never appears in output. Exact local diagnostic retained
   # privately in owned scratch; final report carries only SQLSTATE/line.
   (work/'failure.log').write_text(r.stderr);os.chmod(work/'failure.log',0o600)
   diagnostic=failure_diagnostic(r.stderr,last_operation['phase'],last_operation['context'],command[0])
   output.write_text(json.dumps(diagnostic)+'\n')
   raise Refused('Local PostgreSQL command failed; private diagnostic '+str(work/'failure.log'))
  return r.stdout.strip()
 try:
  version=run([pg/'postgres','--version'])
  if not re.search(r'\b17\.',version):raise Refused('PostgreSQL17 required')
  run([pg/'initdb','-D',data,'-U',platform['bootstrap_role'],'--auth-local=trust','--auth-host=reject','--locale-provider=icu','--icu-locale='+platform['locale'],'--lc-collate='+platform['collate'],'--lc-ctype='+platform['ctype'],'-E',platform['encoding']])
  expected=json.loads((BASE/'pokeriq-catalog-reference.json').read_text());lock_budget=derive_lock_budget(expected)
  with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+lit(socket)+"\nshared_buffers='32MB'\nmax_connections="+str(lock_budget['maxConnections'])+"\nmax_locks_per_transaction="+str(lock_budget['maxLocksPerTransaction'])+"\nshared_preload_libraries='pg_cron,pg_net,pg_stat_statements,supautils'\ncron.database_name='postgres'\ncron.launch_active_jobs=off\n")
  runtime=json.loads((BASE/'pokeriq-extension-runtime.json').read_text())
  allowed={'supautils.privileged_extensions','supautils.privileged_extensions_superuser','supautils.privileged_role','supautils.superuser'}
  with (data/'postgresql.conf').open('a') as f:
   for setting in runtime['settings']:
    if setting['name'] not in allowed:raise Refused('Unreviewed extension runtime setting')
    f.write(setting['name']+'='+lit(setting['setting'])+'\n')
  run([pg/'pg_ctl','-D',data,'-l',work/'server.log','-w','start']);started=True
  cmd=[pg/'psql','-X','-qAt','-h',socket,'-U','schema_restore_owner','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
  run([pg/'psql','-X','-qAt','-h',socket,'-U',platform['bootstrap_role'],'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],'CREATE ROLE schema_restore_owner LOGIN SUPERUSER;',phase='role-create-local-supervisor',context={'role':'schema_restore_owner','bootstrap':platform['bootstrap_role']})
  def sql(s,phase='catalog-read',**context):return run(cmd,s,phase=phase,context=context)
  actual_locks=json.loads(sql("SELECT jsonb_build_object('maxConnections',current_setting('max_connections')::int,'maxLocksPerTransaction',current_setting('max_locks_per_transaction')::int);",phase='isolated-lock-budget'))
  if any(actual_locks[k]!=lock_budget[k] for k in actual_locks):raise Refused('Isolated lock settings differ from derived inventory budget')
  available=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('name',name,'version',version)) FROM pg_available_extension_versions;"));have={(x['name'],x['version']) for x in available}
  missing=[(x['name'],x['version']) for x in contract['extensions'] if (x['name'],x['version']) not in have]
  if missing:raise Refused('Faithful extension runtime unavailable: '+json.dumps(missing))
  # Match source role capabilities and membership. Login is always refused in
  # the disposable target; no source passwords or role authentication exist.
  bootstrap_roles(sql,contract,platform['bootstrap_role'])
  sql('ALTER DATABASE postgres OWNER TO '+q(platform['owner'])+';',phase='database-owner',owner=platform['owner'])
  actualplatform=json.loads(sql("SELECT jsonb_build_object('bootstrap_role',(SELECT rolname FROM pg_roles WHERE oid=10),'owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',to_jsonb(d)->>'datlocale','collation_version',datcollversion,'icu_rules',to_jsonb(d)->>'daticurules') FROM pg_database d WHERE datname=current_database();",phase='database-platform'))
  if actualplatform!=platform:raise Refused('Source database locale/collation runtime differs: '+json.dumps(actualplatform))
  # Provider extensions are real installed versions, created under their exact
  # captured owner. This explicit baseline normalization changes no app DDL.
  builtin=next(x for x in contract['extensions'] if x['name']=='plpgsql')
  # The captured bootstrap principal already owns the initializer's builtin.
  # Provider hooks need this language, so never drop/recreate an exact match.
  require_builtin_extension(sql,builtin)
  rendered=source.decode()
  for extension in contract['extensions']:
   if extension['name']=='plpgsql':continue
   pattern=r'^CREATE EXTENSION IF NOT EXISTS '+re.escape(q(extension['name']) if '-' in extension['name'] else extension['name'])+r' WITH SCHEMA [^;]+;'
   replacement='SET ROLE '+q(extension['owner'])+';\nCREATE EXTENSION IF NOT EXISTS '+q(extension['name'])+' WITH SCHEMA '+q(extension['schema'])+' VERSION '+lit(extension['version'])+';\nRESET ROLE;'
   rendered,n=re.subn(pattern,lambda m:replacement,rendered,flags=re.M)
   if n!=1:raise Refused('Extension baseline anchor differs: '+extension['name'])
  # Supautils requires trigger creator and callback owner authority to agree.
  rendered=render_event_trigger_owners(rendered,expected,contract)
  # Fresh setup has no Supabase default grants before any object is created.
  sql("CREATE TABLE public.__no_default_probe(id int);DO $$ BEGIN IF has_table_privilege('anon','public.__no_default_probe','SELECT') OR has_table_privilege('authenticated','public.__no_default_probe','INSERT') OR has_table_privilege('service_role','public.__no_default_probe','SELECT') THEN RAISE EXCEPTION 'Unexpected default API privilege'; END IF; END $$;DROP TABLE public.__no_default_probe;")
  restore=work/'restore.sql';restore.write_text(rendered);os.chmod(restore,0o600)
  run(cmd+['--single-transaction','-f',restore],limit=300,phase='baseline-restore',context={'sourceFile':manifest['schemaFile']})
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
  fidelity.restore_provider_metadata(sql,expected)
  catalog=json.loads(sql((ROOT/'scripts/schema-rebuild/catalog.sql').read_text()));
  invalid_restored=fidelity.restore_omitted_invalid_index(sql,expected,catalog)
  if invalid_restored:catalog=json.loads(sql((ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
  inherited_restored=fidelity.restore_inherited_primary_keys(sql,expected,catalog)
  if inherited_restored:catalog=json.loads(sql((ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
  semantic_expected,semantic_actual,expressions_parsed=fidelity.normalize_expressions(sql,expected,catalog)

  if any(x['count'] for x in catalog['unsupported_objects']):raise Refused('Catalog contains unsupported object families')
  differences=compare(semantic_expected,semantic_actual)
  if differences:
   output.write_text(json.dumps(dict(auditedSourceRevision=AUDITED_SOURCE_REVISION,qualificationScope=QUALIFICATION_SCOPE,laterMigrationsExcluded=True,schemaRebuilt=False,status='failed',phase='baseline-catalog-comparison',differences=differences))+'\n')
   raise Refused('Independent source catalog comparison differs before pending schema application: '+json.dumps(differences))
  # Four exact reviewed DDL files follow baseline fidelity; no business routine
  # is invoked. The hourly-sweep concurrent-index preamble stays outside its
  # original transaction; opening, concurrent index and bounty-pick DDL follow.
  pending=forward.validate(ROOT,json.loads((BASE/'forward-schema.json').read_text())['arena'])
  proposed=forward.pick_expected(forward.journal_expected(forward.opening_expected(forward.expected_catalog(expected,forward.load_delta(BASE)),BASE),BASE),BASE)
  restored_governance=[]
  def prepare(entry):
   if entry['path']==forward.OPENING_PATH:restored_governance.append(governance.restore(sql,BASE,ROOT))
  apply_pending_schema(run,cmd,ROOT,work,pending,before_apply=prepare)
  if len(restored_governance)!=1:raise Refused('Exactly one governance authorization required')
  governance.verify(sql,restored_governance[0])
  finalroles=json.loads(sql(rolequery))
  for role in finalroles:role['config']=sorted(role.get('config') or [])
  if sorted(finalroles,key=lambda x:x['name'])!=sorted(expectedroles,key=lambda x:x['name']):raise Refused('Pending DDL changed source role capabilities/configuration')
  finalmembers=json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option)),'[]'::jsonb) FROM pg_auth_members;"))
  if {json.dumps(x,sort_keys=True) for x in finalmembers}!={json.dumps(x,sort_keys=True) for x in contract['memberships']}:raise Refused('Pending DDL changed source role memberships')
  catalog=json.loads(sql((ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
  semantic_expected,semantic_actual,parsed=fidelity.normalize_expressions(sql,proposed,catalog);expressions_parsed+=parsed
  differences=compare(semantic_expected,semantic_actual)
  if differences:
   output.write_text(json.dumps(dict(auditedSourceRevision=AUDITED_SOURCE_REVISION,qualificationScope=QUALIFICATION_SCOPE,laterMigrationsExcluded=True,schemaRebuilt=False,status='failed',phase='pending-catalog-comparison',differences=differences))+'\n')
   raise Refused('Independent pending schema catalog comparison differs: '+json.dumps(differences))
  receipt={'auditedSourceRevision':AUDITED_SOURCE_REVISION,'qualificationScope':QUALIFICATION_SCOPE,'laterMigrationsExcluded':True,'schemaRebuilt':not differences,'baselineSHA256':manifest['schemaSHA256'],'counts':{k:len(v or []) for k,v in catalog.items()},'differences':differences,'pendingSchemaInputsApplied':pending,'independentBaselineCatalogPassed':True,'nativeExpressionsParsed':expressions_parsed,'inheritedPrimaryKeysRestored':inherited_restored,'omittedInvalidIndexesRestored':invalid_restored,'noHistoricalDataReplay':True,'remoteConnections':False,'applicationFixtureRowsInserted':False,'governanceConfigurationRowsInserted':1,'extensionVersionsExact':True,'databasePlatformExact':True,'bootstrapPrincipal':platform['bootstrap_role'],'isolatedLockBudget':lock_budget,'roleLoginContainment':'all source roles NOLOGIN; local Unix-only bootstrap owner','roleCapabilitiesAndMembershipsCompared':True,'defaultGrantBoundary':'Fresh empty-cluster probe denies API rights before baseline; fidelity restore retains captured default ACLs. Existing caller grant fixtures separately qualify withdrawal.'}
  output.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
  if differences:raise Refused('Independent source catalog comparison differs')
 finally:
  if 'receipt' not in locals() and json.loads(output.read_text()).get('status')=='started':output.write_text(json.dumps(dict(auditedSourceRevision=AUDITED_SOURCE_REVISION,qualificationScope=QUALIFICATION_SCOPE,laterMigrationsExcluded=True,schemaRebuilt=False,status='failed',**last_operation,rawDiagnostic='ephemeral owned scratch only; never uploaded'))+'\n')
  if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
  # Failed private diagnostics stay only in owned scratch for diagnosis. No
  # running cluster survives a failure, and successful scratch is removed.
  if 'receipt' in locals() and receipt.get('schemaRebuilt'):shutil.rmtree(work)
if __name__=='__main__':
 try:main()
 except (Refused,OSError,subprocess.SubprocessError) as exc:print(str(exc),file=sys.stderr);sys.exit(1)
