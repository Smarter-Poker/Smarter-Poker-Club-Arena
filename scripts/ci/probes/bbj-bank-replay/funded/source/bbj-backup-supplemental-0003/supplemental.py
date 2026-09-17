"""Inert metadata/support provisioning. Root alone supplies and owns the connection.
No process, connector, seed, business-helper invocation, or automatic retry exists here.
"""
from pathlib import Path
from types import ModuleType
from contextlib import contextmanager
import json,hashlib,re,sys,copy
HERE=Path(__file__).resolve().parent

def require(value,message):
 if not value:raise AssertionError(message)
def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(name,path):
 m=ModuleType(name);m.__file__=str(path);exec(compile(Path(path).read_text(),str(path),'exec'),m.__dict__);return m
Q=load('bbj_backup_supplemental_queries',HERE/'queries.py')
A=load('bbj_backup_audit_contract',HERE/'audit_contract.py')

def exact(a,b):
 if type(b)is bool:return type(a)is bool and a is b
 if b is None:return a is None
 if type(b)is dict:return type(a)is dict and set(a)==set(b) and all(exact(a[k],v) for k,v in b.items())
 if type(b)is list:return type(a)is list and len(a)==len(b) and all(exact(x,y) for x,y in zip(a,b))
 if type(b)is int:return type(a)is int and a==b
 return type(a)is type(b) and a==b

def unordered(rows):
 require(type(rows)is list and all(type(x)is dict for x in rows),'Complete record array required')
 return sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))
def relation_model(row):
 require(type(row)is dict,'Missing relation metadata');value=copy.deepcopy(row)
 for key in ['triggers','constraints','indexes','policies']:
  rows=value.get(key);require(type(rows)is list and all(type(x)is dict and type(x.get('name'))is str for x in rows),'Missing named '+key)
  require(len({x['name'] for x in rows})==len(rows),'Duplicate named '+key)
  value[key]=sorted(rows,key=lambda x:x['name'])
 return value

def verify_sources():
 authority=read(HERE/'SOURCE-AUTHORITY.json')
 for p in authority['pins']:require(sha(p['path'])==p['sha256'],'Referenced source changed: '+p['path'])
 seal=read(HERE/'INTEGRITY.json');require(type(seal.get('files'))is dict and bool(seal['files']),'Sealed supplemental packet required')
 for n,h in seal['files'].items():
  p=(HERE/n).resolve();require(p.is_relative_to(HERE) and p.is_file() and sha(p)==h,'Supplemental source changed: '+n)
 return authority

@contextmanager
def imported(modules):
 previous={k:sys.modules.get(k) for k in modules}
 try:
  for key,module in modules.items():
   require(previous[key] is None or getattr(previous[key],'__file__',None)==module.__file__,'Conflicting inherited module '+key)
   sys.modules[key]=module
  yield
 finally:
  for key,value in previous.items():
   if value is None:sys.modules.pop(key,None)
   else:sys.modules[key]=value

def libraries(a):
 schema=Path(a['schema_fixture']);fixture=Path(a['registry_fixture']);opening=Path(a['opening']);adapter=Path(a['adapter0124'])
 pre=load('backup_original_preflight',schema/'preflight.py');binding=load('backup_0124_assertions',adapter/'binding.py')
 builder=load('build_registry',fixture/'build_registry.py')
 with imported({'build_registry':builder}):registry=load('backup_registry_preflight',fixture/'registry_preflight.py')
 contract=load('packet_contract',opening/'packet_contract.py')
 with imported({'packet_contract':contract}):supp=load('backup_opening_supplemental',opening/'supplemental.py')
 queries=load('backup_0124_queries',adapter/'catalog_queries.py')
 case=load('backup_sealed_case',Path(a['case'])/'case_module.py')
 return pre,binding,registry,supp,queries,case

def expected_envelope(table):
 m=table['after'];attributes=[]
 for i,c in enumerate(m['columns'],1):attributes.append(dict(name=c['name'],position=i,dropped=False,hasdefault=c['default']is not None,dimensions=0,statistics=None,local=True,inheritance_count=0,collation_is_type_default=True,storage_is_type_default=True,compression='',options=None,fdwoptions=None,hasmissing=False,missingvalue=None))
 indexes=[]
 for x in sorted(m['indexes'],key=lambda x:x['name']):indexes.append(dict(name=x['name'],unique=x['definition'].startswith('CREATE UNIQUE INDEX '),primary=x['name']==table['relation'].split('.')[1]+'_pkey',exclusion=False,immediate=True,clustered=False,valid=True,checkxmin=False,ready=True,live=True,replident=False,nulls_not_distinct=False))
 return dict(persistence='p',replident='d',access_method='heap',partition=False,typed='0',tablespace='0',rules=[],parents=[],attributes=attributes,indexes=indexes)

def validate_backup(raw,models,phase):
 require(phase in ('either','after'),'Fixed metadata phase required')
 require(type(raw)is dict and raw.get('errors')==[],'Complete raw supplemental capture required')
 chosen={'functions':[],'tables':[],'sequences':[]}
 for kind,identity in [('functions','signature'),('tables','relation'),('sequences','name')]:
  expected=models[kind]+(models['builtins'] if kind=='functions' else [])
  records=raw.get(kind);require(type(records)is list and len(records)==len(expected),'Exact '+kind+' count required')
  for got,wanted in zip(records,expected):
   require(got.get('identity')==wanted[identity] and type(got.get('actual'))is dict,'Missing/changed '+kind+' identity')
   actual=got['actual']
   if kind=='functions':
    require(type(actual.get('raw_pg_proc'))is dict,'Full raw function record required');value={k:v for k,v in actual.items() if k!='raw_pg_proc'}
    require(set(actual['raw_pg_proc'])==set(wanted['raw_fixed'])|{'oid','proowner','pronamespace','prolang','prosrc','proacl','proargtypes','proallargtypes','prorettype'},'Raw pg_proc field inventory differs')
    require(type(actual['raw_pg_proc']['oid'])is str and re.fullmatch('[1-9][0-9]*',actual['raw_pg_proc']['oid'])is not None,'Raw local function OID required')
    require(hashlib.md5(actual['raw_pg_proc']['prosrc'].encode()).hexdigest()==actual['body_md5'],'Raw function body join differs')
    require(exact({k:v for k,v in actual['raw_pg_proc'].items() if k not in ['oid','proowner','pronamespace','prolang','prosrc','proacl','proargtypes','proallargtypes','prorettype']},wanted['raw_fixed']),'Raw fixed function attribute differs: '+wanted[identity])
   elif kind=='tables':
    value=relation_model(actual);require(exact(got.get('envelope'),expected_envelope(wanted)),'Unexpected complete relation envelope: '+wanted[identity])
    require(type(got.get('extra'))is dict and set(got['extra'])=={'raw_pg_class','attributes','all_triggers_including_RI','constraint_records','index_records'},'Full raw relation records required')
    extra=got['extra'];require(type(extra['raw_pg_class'])is dict and type(extra['raw_pg_class'].get('oid'))is str,'Raw local relation OID required')
    require(type(extra['attributes'])is list and len(extra['attributes'])==len(value['columns']) and [x.get('attname') for x in extra['attributes']]==[x['name'] for x in value['columns']],'Full raw attribute inventory differs')
    require(type(extra['constraint_records'])is list and sorted(x.get('conname') for x in extra['constraint_records'])==sorted(x['name'] for x in value['constraints']),'Full raw constraint inventory differs')
    require(type(extra['index_records'])is list and len(extra['index_records'])==len(value['indexes']),'Full raw index inventory differs')
    require(type(extra['all_triggers_including_RI'])is list and sorted(x.get('tgname') for x in extra['all_triggers_including_RI'] if x.get('tgisinternal')is False)==sorted(x['name'] for x in value['triggers']),'Full raw user-trigger inventory differs')
   else:
    require(type(actual.get('raw_pg_class'))is dict and type(actual.get('raw_pg_sequence'))is dict and type(actual.get('dependencies'))is list,'Full sequence catalogs required');value=actual.get('model')
   options=['after'] if phase=='after' else ['before','after'];match=[]
   for p in options:
    target=relation_model(wanted[p]) if kind=='tables' else wanted[p]
    if exact(value,target):match.append(p)
   require(bool(match),'Unknown exact '+phase+' preimage: '+wanted[identity]);chosen[kind].append('after' if 'after' in match else 'before')
 require(exact(unordered([x.get('model') for x in raw.get('foreign_keys',[])]),unordered(models['foreign_keys'])),'Exact three foreign key structures required')
 require(all(x.get('all_equality_arrays_equal')is True and type(x.get('raw'))is dict for x in raw['foreign_keys']),'Full foreign key raw/equality arrays required')
 require(exact(unordered([x.get('model') for x in raw.get('ri_triggers',[])]),unordered(models['ri_triggers'])),'Exact twelve RI endpoint modes/bindings required')
 require(all(type(x.get('raw'))is dict for x in raw['ri_triggers']),'Full raw RI triggers required')
 want=sorted(x['signature'].replace(',',', ') for x in models['functions'])
 require(exact(raw.get('overloads'),want),'Exact public overload set required')
 # Tie independent normalized RI query rows back to actual full relation catalogs,
 # including the separately captured original pool endpoint. No names/OIDs are portable.
 seen=[]
 for r in raw['tables']+[raw['pool_endpoint']]:
  require(type(r.get('extra'))is dict,'Missing endpoint raw catalog')
  for t in r['extra']['all_triggers_including_RI']:
   if t.get('tgisinternal')is True:seen.append(t)
 want_raw=[x['raw'] for x in raw['ri_triggers']]
 require(len(seen)==len(want_raw)==12,'Full raw RI endpoint inventory differs')
 for t in seen:
  matches=[r for r in want_raw if r.get('oid')==t.get('oid')];require(len(matches)==1,'RI raw OID join missing/duplicate')
  require(exact({k:v for k,v in t.items() if k not in ('definition','function_identity')},matches[0]),'RI raw endpoint join differs')
 return chosen

def _collect(c,stage,a,phase):
 models=read(HERE/'EXPECTED.json');pre,binding,registry,supp,queries,case=libraries(a)
 result=dict(stage=stage,passed=False,original_identity_count=0,original_edge_count=0,registry_checks=0,prerequisites_passed=False,opening_supplemental_12_functions_6_relations_passed=False,errors=[],backup={'passed':False})
 raw={'functions':[],'tables':[],'sequences':[],'errors':[]};result['backup']['raw_catalog']=raw
 def attempt(name,fn,target=result):
  try:target[name]=fn();return target[name]
  except Exception as exc:
   result['errors'].append(dict(stage=name,type=type(exc).__name__,error=str(exc)));return None
 old_path=None
 try:
  old_path=c.one("SELECT to_jsonb(current_setting('search_path'))");require(type(old_path)is str,'Actual initial search path required')
  c.sql("SELECT pg_catalog.set_config('search_path','pg_catalog,public,extensions',false)")
  boundary=attempt('boundary',lambda:c.one(Q.BOUNDARY_QUERY))
  if boundary is not None:
   require(boundary['role']==boundary['session_role']=='postgres' and boundary['superuser']is True and boundary['socket_only']is True and boundary['replication_role']=='origin' and boundary['server_version'].startswith('17.11'),'Original private role/version boundary differs')
   require(boundary['allow_privileged_anon_grant'] in (None,'','off'),'Original event guard bypass present')
  original={};result['raw_original']=original
  base=attempt('catalog',lambda:pre.check(c,read(Path(a['schema_fixture'])/'FUNCTION-OVERLAY-INPUTS.json'),read(Path(a['schema_fixture'])/'TABLE-OVERLAY-INPUTS.json')),original)
  attempt('prerequisites',lambda:pre.check_prerequisites(c,read(Path(a['schema_fixture'])/'NAMESPACE-AND-SEQUENCE-INPUTS.json')),original)
  attempt('expression_identity',lambda:pre.check_expression_identity(c,read(Path(a['schema_fixture'])/'CONTEXT-AND-IDENTITY-INPUTS.json'),(Path(a['schema_fixture'])/'NATIVE-EXPRESSION-IDENTITY-QUERY.sql').read_text()),original)
  attempt('registry',lambda:registry.check_registry(c),original)
  original['boundary']=boundary
  if type(base)is dict:original.update({k:v for k,v in base.items() if k!='passed'})
  original['passed']=all(type(x)is dict and x.get('passed')is True for x in [base,original.get('prerequisites'),original.get('expression_identity'),original.get('registry')])
  attempt('original_validation',lambda:binding.assert_complete_preflight(original,Path(a['schema_fixture']),Path(a['registry_fixture']),expected_database=boundary['database'],require_empty=False))
  result['original_identity_count']=len(original.get('comparisons',[]));result['original_edge_count']=original.get('expression_identity',{}).get('actual_count',0);result['registry_checks']=len(original.get('registry',{}).get('comparisons',[]));result['prerequisites_passed']=original.get('prerequisites',{}).get('passed')is True
  opening=attempt('raw_opening_supplemental',lambda:supp.supplemental_preflight(c))
  result['opening_supplemental_12_functions_6_relations_passed']=type(opening)is dict and opening.get('passed')is True and len(opening.get('comparisons',[]))==18
  # Each individual raw query is attempted and recorded before validating any model.
  def raw_get(container,key,query):
   try:container[key]=c.one(query)
   except Exception as exc:raw['errors'].append(dict(identity=container.get('identity'),part=key,type=type(exc).__name__,error=str(exc)))
  for x in models['functions']+models['builtins']:
   r={'identity':x['signature']};raw['functions'].append(r);raw_get(r,'actual',queries.function_query(x['signature']))
  template=(Path(a['adapter0124'])/'RELATION-QUERY.sql').read_text().strip().rstrip(';')
  for x in models['tables']:
   r={'identity':x['relation']};raw['tables'].append(r)
   raw_get(r,'actual',"SELECT COALESCE(("+template.replace('{relation_literal}',Q.literal(x['relation']))+"),'null'::jsonb)")
   raw_get(r,'extra',queries.relation_extra_query(x['relation']));raw_get(r,'envelope',Q.envelope_query(x['relation']))
  raw['pool_endpoint']={'identity':'public.bbj_pools'};raw_get(raw['pool_endpoint'],'extra',queries.relation_extra_query('public.bbj_pools'))
  for x in models['sequences']:
   r={'identity':x['name']};raw['sequences'].append(r);raw_get(r,'actual',Q.sequence_query(x['name']))
  for k,q in [('foreign_keys',Q.foreign_key_query()),('ri_triggers',Q.ri_query()),('overloads',Q.overload_query([x['signature'].split('.')[1].split('(')[0] for x in models['functions']]))]:raw_get(raw,k,q)
  chosen=attempt('backup_preimage_selection',lambda:validate_backup(raw,models,phase))
  if chosen is not None:
   b=result['backup'];b.update(passed=True,source_model_sha256=sha(Path(a['case'])/'DEPENDENCY-CONTRACT.json'),raw_catalog_observations_retained=True,historical_support_scope_matched=True,all_internal_RI_trigger_modes_and_constraints_passed=True,sequence_config_ownership_acl_passed=True,sequence_max_text=raw['sequences'][0]['actual']['model']['maximum'])
   # Return checked actual current records in the exact case contract, not a PASS flag alone.
   b['functions']=[{**{k:v for k,v in x['actual'].items() if k!='raw_pg_proc'},'signature':x['identity']} for x in raw['functions'][:2]]
   b['relations']=[{'relation':x['identity'],'metadata':x['actual']} for x in raw['tables'][:3]]
   b['trigger_functions']=[]
   for x in raw['functions'][2:4]:
    v=x['actual'];p=v['raw_pg_proc'];b['trigger_functions'].append({k:v[k] for k in ['body_md5','definition','cost','kind','language','leakproof','owner','parallel','result','returns_set','rows','security_definer','settings','strict','volatility']}|{'identity':x['identity'],'acl':p['proacl'],'argument_types':p['proargtypes'],'support':p['prosupport']})
 except Exception as exc:result['errors'].append(dict(stage='collector',type=type(exc).__name__,error=str(exc)))
 finally:
  if old_path is not None:
   try:c.sql('SELECT pg_catalog.set_config(\'search_path\','+Q.literal(old_path)+',false)')
   except Exception as exc:result['errors'].append(dict(stage='restore_search_path',type=type(exc).__name__,error=str(exc)))
 result['passed']=not result['errors'] and result['backup']['passed']is True and result['opening_supplemental_12_functions_6_relations_passed']is True and result.get('raw_original',{}).get('passed')is True
 return result

def collect(conn,stage):
 require(type(stage)is str and 0<len(stage)<=100,'Bounded root stage required')
 return _collect(conn,stage,verify_sources(),'after')

CATALOG_QUERY="SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'sha',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.oid) FROM pg_proc p),'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid::text,'sha',encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex')) ORDER BY c.oid) FROM pg_class c),'event_triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.evtname,'event',e.evtevent,'enabled',e.evtenabled,'tags',e.evttags,'owner',pg_get_userbyid(e.evtowner),'function_schema',n.nspname,'function_name',p.proname) ORDER BY e.evtname) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace),'[]'::jsonb),'default_acl',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),'[]'::jsonb))"

def assert_delta(before,after,old,new):
 require(exact(before['event_triggers'],after['event_triggers']) and before['default_acl']==after['default_acl']==[],'Original event/default privileges changed')
 allowed={'functions':set(),'relations':set()}
 for b,a in zip(old['functions'],new['functions']):
  x=b['actual']['raw_pg_proc'];y=a['actual']['raw_pg_proc'];skip={'proacl'}
  if b['identity']=='public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)':skip.add('prosrc')
  require(exact({k:v for k,v in x.items() if k not in skip},{k:v for k,v in y.items() if k not in skip}),'Unexpected function nonapproved metadata/OID delta')
  if b['identity'].startswith('public.'):allowed['functions'].add(x['oid'])
 for b,a in zip(old['tables'],new['tables']):
  x=copy.deepcopy(b['extra']);y=copy.deepcopy(a['extra']);allowed['relations'].add(x['raw_pg_class']['oid'])
  x['raw_pg_class'].pop('relacl');y['raw_pg_class'].pop('relacl');require(exact(x,y),'Unexpected relation/OID/attachment delta')
 for b,a in zip(old['sequences'],new['sequences']):
  x=copy.deepcopy(b['actual']);y=copy.deepcopy(a['actual']);allowed['relations'].add(x['raw_pg_class']['oid'])
  for v in [x,y]:v['raw_pg_class'].pop('relacl');v['model'].pop('acl')
  require(exact(x,y),'Unexpected sequence/OID/ownership/configuration delta')
 require(exact(old['foreign_keys'],new['foreign_keys']) and exact(old['ri_triggers'],new['ri_triggers']) and exact(old['pool_endpoint'],new['pool_endpoint']),'Original RI/pool boundary changed')
 for key,permit in allowed.items():
  b={x['oid']:x['sha'] for x in before[key]};a={x['oid']:x['sha'] for x in after[key]}
  require(len(b)==len(before[key]) and len(a)==len(after[key]) and set(a)==set(b) and all(a[k]==v for k,v in b.items() if k not in permit),'Unexpected catalog delta outside finite source changes')

def capture_audit(conn,report):
 verify_sources()
 return A.capture(conn,report,Q.sequence_query)

def install(conn,log):
 """Root owns conn immediately, authorizes exact source, and always closes it.
 log.expected_identity binds the independently observed empty fixture identity.
 """
 require(type(log)is dict and set(log)=={'expected_identity'},'Fresh root-owned installation log required')
 expected=log['expected_identity'];keys={'database','database_oid','system_identifier','data_directory','socket_directory'}
 require(type(expected)is dict and set(expected)==keys and expected['database']=='fixture_base','Exact empty base identity required')
 for key in ['database_oid','system_identifier']:require(type(expected[key])is str and re.fullmatch('[1-9][0-9]*',expected[key])is not None,'Canonical '+key+' required')
 require(int(expected['database_oid'])<=4294967295,'OID range differs')
 for key in ['data_directory','socket_directory']:require(type(expected[key])is str and Path(expected[key]).is_absolute(),'Exact private physical path required')
 a=verify_sources();models=read(HERE/'EXPECTED.json');case=libraries(a)[-1]
 log.update(status='RUNNING',commit_status='NOT_ATTEMPTED',statements=[],errors=[],cleanup_errors=[],financial_helpers_invoked=False,seed_invoked=False)
 try:
  conn.sql("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'; SET LOCAL search_path=pg_catalog,public,extensions")
  b=conn.one(Q.BOUNDARY_QUERY);log['boundary']=b
  require(all(exact(b.get(k),v) for k,v in expected.items()),'Root owned original physical identity differs')
  require(b['role']==b['session_role']=='postgres' and b['superuser']is True and b['socket_only']is True and b['replication_role']=='origin' and b['server_version'].startswith('17.11') and b['allow_privileged_anon_grant'] in (None,'','off'),'Private original role/version/event boundary differs')
  require(all(type(b[k])is int and b[k]==0 for k in ['users','clubs','legs','snapshots']),'Must provision original empty base before seed')
  conn.sql('LOCK TABLE '+','.join(Q.endpoint_names()+[A.AUDIT,A.LOCKS])+' IN ACCESS EXCLUSIVE MODE')
  log['audit_context']=conn.one(A.CONTEXT)
  log['audit_before']={};A.capture(conn,log['audit_before'],Q.sequence_query)
  log['before']=_collect(conn,'support_install_before',a,'either')
  # Full57 extraction also happens before any mutation, even for an unknown model.
  log['raw_before']=case.capture(conn,True)
  log['catalog_before']=conn.one(CATALOG_QUERY)
  A.validate_capture(log['audit_before'])
  require(log['before']['passed']is True,'Full original/opening/backup preimage failed')
  require(exact(log['catalog_before']['event_triggers'],read(Path(a['adapter0124'])/'EVENT-TRIGGERS-EXPECTED.json')) and log['catalog_before']['default_acl']==[],'Exact original event/default-ACL preimage required')
  require(all(log['raw_before']['raw'][x['relation']]==[] for x in models['tables']),'All six support relations must be empty before seed')
  choice=log['before']['backup_preimage_selection']
  log['audit_plan']=A.planned_events(models,choice)
  for kind in ['functions','tables','sequences']:
   for x,phase in zip(models[kind],choice[kind]):
    if phase=='after':continue
    for sql in x['statements']:
     # The original GRANT sweep and GraphQL branch must remain ineligible.
     require(conn.one(A.NO_NESTED_SWEEP)=={'eligible_grant_sweep':0,'graphql_oid_collision':0},'Unmodeled nested DDL branch became eligible')
     entry=dict(sql=sql,status='ATTEMPTED');log['statements'].append(entry)
     try:conn.sql(sql);entry['status']='RETURNED'
     except Exception as exc:entry.update(status='ERROR',type=type(exc).__name__,error=str(exc));raise
  log['after']=_collect(conn,'support_install_after',a,'after')
  log['audit_after']={};A.capture(conn,log['audit_after'],Q.sequence_query)
  log['raw_after']=case.capture(conn,True);log['catalog_after']=conn.one(CATALOG_QUERY)
  require(log['after']['passed']is True,'Full source postimage/original/opening metadata failed')
  assert_delta(log['catalog_before'],log['catalog_after'],log['before']['backup']['raw_catalog'],log['after']['backup']['raw_catalog'])
  case.raw_equal(log['raw_before'],log['raw_after'])
  log['audit_transition']=A.assert_transition(log['audit_before'],log['audit_after'],log['audit_plan'],log['statements'],log['audit_context'])
  A.assert_legacy_sequences(log['raw_before'],log['raw_after'],log['audit_before'],log['audit_after'])
  log['commit_status']='ATTEMPTED';conn.sql('COMMIT');log['commit_status']='COMMITTED';log['status']='INSTALLED_OR_EXACT_NOOP'
 except Exception as exc:
  if log['commit_status']=='ATTEMPTED':log['commit_status']='UNCERTAIN'
  log['status']='FAIL';log['errors'].append(dict(type=type(exc).__name__,error=str(exc)))
  log['audit_failure_disposition']='UNQUALIFIED_ATTEMPT_RETAIN_ORIGINAL_ROWS_AND_NONTRANSACTIONAL_SEQUENCE_STATE_NO_RETRY'
  log['audit_effects_accepted']=False
  try:conn.sql('ROLLBACK')
  except Exception as e:log['cleanup_errors'].append(dict(action='rollback',type=type(e).__name__,error=str(e)))
  exc.supplemental_report=log;raise
 return log
