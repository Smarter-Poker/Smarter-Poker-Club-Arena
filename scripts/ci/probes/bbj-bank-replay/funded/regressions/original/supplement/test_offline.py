"""Offline protocol/model tests only. No native or financial execution."""
from pathlib import Path
from types import ModuleType
from decimal import Decimal
import json,copy,hashlib,re
P=Path(__file__).resolve().parent
s=ModuleType('bbj_test_supplemental');s.__file__=str(P/'supplemental.py');exec(compile((P/'supplemental.py').read_text(),s.__file__,'exec'),s.__dict__)
a=s.read(P/'SOURCE-AUTHORITY.json');m=s.read(P/'EXPECTED.json');C=Path(a['case']);A=Path(a['adapter0124'])
checks=[]
def check(name,fn):fn();checks.append({'name':name,'passed':True})
def refuses(fn):
 try:fn()
 except Exception:return
 raise AssertionError('Accepted a fault')
def eq(x,y):assert x==y,(x,y)
# Test source models against preexisting current captures where available, never against native calls.
def fixtures(phase):
 raw={'functions':[],'tables':[],'sequences':[],'errors':[],'foreign_keys':[],'ri_triggers':[]}
 fs=s.read(C/'CURRENT-FUNCTIONS.json');ts=s.read(C/'CURRENT-TRIGGER-FUNCTIONS.json');rs=s.read(C/'CURRENT-RELATIONS.json')
 captures=[x['metadata']['raw_pg_proc'] for x in fs]+[x['raw_pg_proc'] for x in ts[5:]]+[x['raw_pg_proc'] for x in ts[:5]]
 for i,(x,src) in enumerate(zip(m['functions']+m['builtins'],captures)):
  v=copy.deepcopy(x[phase]);p=copy.deepcopy(src);p['oid']=str(90000+i);p['proowner']='10'
  p['proacl']=None if v['acl']is None else v['acl'][1:-1].split(',');p['prosrc']=v['definition'].split('$function$')[1]
  v['raw_pg_proc']=p;raw['functions'].append({'identity':x['signature'],'actual':v})
 for i,x in enumerate(m['tables']):
  v=copy.deepcopy(x[phase])
  if i<3:extra=copy.deepcopy(rs[i]['extra'])
  else:
   extra=dict(raw_pg_class={'oid':str(91000+i),'relacl':None,'relname':x['relation'].split('.')[1]},attributes=[{'attname':q['name']} for q in v['columns']],constraint_records=[{'conname':q['name']} for q in v['constraints']],index_records=[{'definition':q['definition']} for q in v['indexes']],all_triggers_including_RI=[{'tgisinternal':False,'tgname':q['name']} for q in v['triggers']])
  extra['raw_pg_class']['oid']=str(91000+i);extra['raw_pg_class']['relacl']=None if v['acl']is None else v['acl'][1:-1].split(',');extra['all_triggers_including_RI']=[t for t in extra['all_triggers_including_RI'] if not t['tgisinternal']]
  raw['tables'].append(dict(identity=x['relation'],actual=v,extra=extra,envelope=s.expected_envelope(x)))
 raw['pool_endpoint']={'identity':'public.bbj_pools','extra':dict(raw_pg_class={'oid':'91999','relacl':[]},all_triggers_including_RI=[])}
 for i,x in enumerate(m['sequences']):
  v=copy.deepcopy(x[phase]);raw['sequences'].append(dict(identity=x['name'],actual=dict(model=v,raw_pg_class={'oid':str(92000+i),'relacl':None if v['acl']is None else v['acl'][1:-1].split(',')},raw_pg_sequence={'seqmax':'9223372036854775807'},dependencies=[])))
 for x in m['foreign_keys']:raw['foreign_keys'].append({'model':copy.deepcopy(x),'all_equality_arrays_equal':True,'raw':{'conname':x['name']}})
 for i,x in enumerate(m['ri_triggers']):
  t=dict(oid=str(93000+i),tgisinternal=True,tgname='RI_ConstraintTrigger_'+str(93000+i),tgenabled='O',tgtype=x['type']);raw['ri_triggers'].append({'model':copy.deepcopy(x),'raw':t})
  r=next(z for z in raw['tables']+[raw['pool_endpoint']] if z['identity']==x['relation']);r['extra']['all_triggers_including_RI'].append(copy.deepcopy(t))
 raw['overloads']=sorted(x['signature'].replace(',',', ') for x in m['functions']);return raw
before=fixtures('before');after=fixtures('after')
check('complete_source_before',lambda:s.validate_backup(before,m,'either'))
check('complete_source_after',lambda:s.validate_backup(after,m,'after'))
check('historical_refused_as_current',lambda:refuses(lambda:s.validate_backup(before,m,'after')))
for phase,raw in [('before',before),('after',after)]:
 for kind in ['functions','tables','sequences','foreign_keys','ri_triggers','overloads']:
  for i in range(len(raw[kind])):
   v=copy.deepcopy(raw);v[kind].pop(i);check(f'{phase}_missing_{kind}_{i}',lambda v=v:refuses(lambda:s.validate_backup(v,m,'either' if phase=='before' else 'after')))
for i in range(9):
 for field,value in [('body_md5','wrong'),('definition','wrong'),('acl','{}'),('owner','anon'),('strict',True),('cost',2),('settings',['search_path=evil'])]:
  v=copy.deepcopy(after);v['functions'][i]['actual'][field]=value
  if value==after['functions'][i]['actual'][field]:continue
  check(f'function_{i}_{field}_drift',lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
for i in range(6):
 for field,value in [('acl','{}'),('owner','anon'),('rls',False),('columns',[]),('constraints',[]),('indexes',[]),('triggers',[{}]),('policies',[{}])]:
  v=copy.deepcopy(after);v['tables'][i]['actual'][field]=value
  if value==after['tables'][i]['actual'][field]:continue
  check(f'table_{i}_{field}_drift',lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
 for field,value in [('persistence','u'),('replident','f'),('access_method','evil'),('parents',['public.evil']),('rules',['evil']),('attributes',[])]:
  v=copy.deepcopy(after);v['tables'][i]['envelope'][field]=value;check(f'table_{i}_{field}_envelope',lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
for i in range(12):
 for field,value in [('enabled','D'),('relation','public.evil'),('function_name','RI_FKey_noaction_del'),('type',1),('index_matches_constraint',False)]:
  v=copy.deepcopy(after);v['ri_triggers'][i]['model'][field]=value;check(f'RI_{i}_{field}',lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
for i in range(2):
 for field,value in [('maximum',9223372036854775807),('maximum','9223372036854776000'),('type','integer'),('cycle',True),('cache','2'),('owned_by',[]),('acl','{}')]:
  v=copy.deepcopy(after);v['sequences'][i]['actual']['model'][field]=value;check(f'sequence_{i}_{field}_{value}',lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
for field in ['probin','prosupport','proargdefaults','provariadic']:
 v=copy.deepcopy(after);v['functions'][0]['actual']['raw_pg_proc'][field]='evil';check('raw_function_'+field,lambda v=v:refuses(lambda:s.validate_backup(v,m,'after')))
v=copy.deepcopy(after);v['pool_endpoint']['extra']['all_triggers_including_RI'][0]['tgenabled']='D';check('pool_endpoint_raw_join',lambda:refuses(lambda:s.validate_backup(v,m,'after')))
# Replay the real saved0124 original/opening query responses into the unchanged comparators.
# Supplemental answers below are synthetic source models, so this is source-only testing.
fixture_path=A/'execution-runs/ec5d102b7b694b0abedf9d7afbdea441/PREFLIGHT.json'
old=s.read(fixture_path);answers={}
for e in old['events']:
 if len(e.get('stdout',[]))==1:
  try:answers[e['sql']]=json.loads(e['stdout'][0],parse_float=Decimal)
  except Exception:pass
queries=s.libraries(a)[4];template=(A/'RELATION-QUERY.sql').read_text().strip().rstrip(';')
boundary=dict(database='fixture_base',database_oid='910',system_identifier='911',role='postgres',session_role='postgres',superuser=True,socket_only=True,server_version='17.11 (Homebrew)',replication_role='origin',data_directory='/private/tmp/offline/data',socket_directory='/private/tmp/offline/sock',allow_privileged_anon_grant=None,users=0,clubs=0,legs=0,snapshots=0)
class Connection:
 def __init__(self,raw,fault=None):self.raw=copy.deepcopy(raw);self.fault=fault;self.calls=[];self.commands=[]
 def one(self,q):
  self.calls.append(q)
  if self.fault==q:raise RuntimeError('offline injected raw transport failure')
  if q=="SELECT to_jsonb(current_setting('search_path'))":return 'pg_catalog,public,extensions'
  if q==s.Q.BOUNDARY_QUERY:return copy.deepcopy(boundary)
  if q==s.A.CONTEXT:return {'protocol_model_only':True}
  if q==s.A.NO_NESTED_SWEEP:return {'eligible_grant_sweep':0,'graphql_oid_collision':0}
  for x in self.raw['functions']:
   if q==queries.function_query(x['identity']):return copy.deepcopy(x['actual'])
  for x in self.raw['tables']:
   if q=="SELECT COALESCE(("+template.replace('{relation_literal}',s.Q.literal(x['identity']))+"),'null'::jsonb)":return copy.deepcopy(x['actual'])
   if q==queries.relation_extra_query(x['identity']):return copy.deepcopy(x['extra'])
   if q==s.Q.envelope_query(x['identity']):return copy.deepcopy(x['envelope'])
  if q==queries.relation_extra_query('public.bbj_pools'):return copy.deepcopy(self.raw['pool_endpoint']['extra'])
  for x in self.raw['sequences']:
   if q==s.Q.sequence_query(x['identity']):return copy.deepcopy(x['actual'])
  for k,query in [('foreign_keys',s.Q.foreign_key_query()),('ri_triggers',s.Q.ri_query()),('overloads',s.Q.overload_query([x['signature'].split('.')[1].split('(')[0] for x in m['functions']]))]:
   if q==query:return copy.deepcopy(self.raw[k])
  if q in answers:return copy.deepcopy(answers[q])
  raise AssertionError('Unexpected SQL in offline collector: '+q)
 def sql(self,q):self.commands.append(q)
connection=Connection(after);result=s._collect(connection,'offline_current',a,'after')
if not result['passed']:raise AssertionError(result['errors'])
check('whole_collector_original327_edges2957_registry16_opening18',lambda:eq([result['original_identity_count'],result['original_edge_count'],result['registry_checks'],len(result['raw_opening_supplemental']['comparisons'])],[327,2957,16,18]))
case=s.libraries(a)[5];check('exact_case0002_callback_contract',lambda:case.metadata(None,lambda c:result))
for category,index,part,q in [('function',0,'actual',queries.function_query(m['functions'][0]['signature'])),('relation',0,'actual',"SELECT COALESCE(("+template.replace('{relation_literal}',s.Q.literal(m['tables'][0]['relation']))+"),'null'::jsonb)"),('sequence',0,'actual',s.Q.sequence_query(m['sequences'][0]['name'])),('RI',0,'model',s.Q.ri_query())]:
 conn=Connection(after,q);r=s._collect(conn,'offline_failed_'+category,a,'after')
 check('whole_collector_'+category+'_failure_retained',lambda r=r:eq(r['passed'],False))
 check('whole_collector_'+category+'_captures_all_later_objects',lambda r=r:eq([len(r['backup']['raw_catalog'][k]) for k in ['functions','tables','sequences']],[9,6,2]))
 check('whole_collector_'+category+'_raw_error_retained',lambda r=r:eq(len(r['backup']['raw_catalog']['errors']),1))
# Boolean source expectations reject numeric-one, including successful-looking wrappers.
v=copy.deepcopy(after);v['tables'][0]['actual']['rls']=1;check('bool_is_not_one',lambda:refuses(lambda:s.validate_backup(v,m,'after')))
# Provisioning protocol probes with mock metadata: exercise statement ordering, zero mutation
# on preimage refusal, unknown commit, rollback error retention. No SQL is executed.
s.verify_sources=lambda:a
real_collect=s._collect;real_libs=s.libraries;real_delta=s.assert_delta
# Isolate the inherited installer orchestration checks. The actual new audit
# comparator is covered separately by test_audit_contract.py and native plans.
real_audit=s.A
class ProtocolAudit:
 AUDIT=real_audit.AUDIT;LOCKS=real_audit.LOCKS;CONTEXT=real_audit.CONTEXT;NO_NESTED_SWEEP=real_audit.NO_NESTED_SWEEP
 def capture(self,c,report,q):report.update(protocol_model_only=True);return report
 def validate_capture(self,*args):return None
 def planned_events(self,*args):return {'protocol_model_only':True}
 def assert_transition(self,*args):return {'protocol_model_only':True}
 def assert_legacy_sequences(self,*args):return None
s.A=ProtocolAudit()
class Case:
 def capture(self,c,in_writer):return {'raw':{x['relation']:[] for x in m['tables']},'sequences':[]}
 def raw_equal(self,b,c):eq(b,c)
s.libraries=lambda a:(None,None,None,None,None,Case())
meta_before={'passed':True,'backup_preimage_selection':s.validate_backup(before,m,'either'),'backup':{'raw_catalog':before}}
meta_after={'passed':True,'backup':{'raw_catalog':after}}
s._collect=lambda c,stage,a,phase:copy.deepcopy(meta_before if phase=='either' else meta_after)
s.assert_delta=lambda *args:None
class Installer:
 def __init__(self,fail=None,rollback_failure=False):self.commands=[];self.fail=fail;self.rollback_failure=rollback_failure
 def one(self,q):
  if q==s.Q.BOUNDARY_QUERY:return copy.deepcopy(boundary)
  if q==s.A.CONTEXT:return {'protocol_model_only':True}
  if q==s.A.NO_NESTED_SWEEP:return {'eligible_grant_sweep':0,'graphql_oid_collision':0}
  if q==s.CATALOG_QUERY:return dict(event_triggers=s.read(A/'EVENT-TRIGGERS-EXPECTED.json'),default_acl=[])
  raise AssertionError(q)
 def sql(self,q):
  self.commands.append(q)
  if q==self.fail or q=='ROLLBACK' and self.rollback_failure:raise RuntimeError('offline injected '+q)
def log():return {'expected_identity':{k:boundary[k] for k in ['database','database_oid','system_identifier','data_directory','socket_directory']}}
i=Installer();l=log();s.install(i,l);check('installer_expected_source_changes',lambda:eq(len(l['statements']),23));check('installer_commit',lambda:eq(l['commit_status'],'COMMITTED'))
# 1 exact body, eight function ACL statements, ten table grants, four sequence grants.
check('installer_original_current_helper_exact_bytes',lambda:eq(l['statements'][2]['sql'],Path(next(x['path'] for x in a['pins'] if x['path'].endswith('/20260912070357_bbj_bank_move_replay_matches_payload.sql'))).read_text()))
for x in m['functions']:
 revoke='REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC;';grant='GRANT EXECUTE ON FUNCTION '+x['signature']+' TO service_role;'
 check('revoke_before_grant_'+x['signature'],lambda revoke=revoke,grant=grant:eq(i.commands.index(revoke)<i.commands.index(grant),True))
s._collect=lambda c,stage,a,phase:{'passed':False} if phase=='either' else meta_after
i=Installer();l=log();refuses(lambda:s.install(i,l));check('preimage_refusal_no_ddl',lambda:eq(l['statements'],[]));check('preimage_refusal_rollback',lambda:eq(i.commands[-1],'ROLLBACK'))
s._collect=lambda c,stage,a,phase:copy.deepcopy(meta_before if phase=='either' else meta_after)
i=Installer('COMMIT',True);l=log();refuses(lambda:s.install(i,l));check('ambiguous_commit_is_uncertain',lambda:eq(l['commit_status'],'UNCERTAIN'));check('rollback_failure_retained',lambda:eq(len(l['cleanup_errors']),1));check('no_commit_retry',lambda:eq(i.commands.count('COMMIT'),1))
i=Installer(m['functions'][0]['statements'][1]);l=log();refuses(lambda:s.install(i,l));check('statement_failure_stops_later_grants',lambda:eq(len(l['statements']),2));check('statement_failure_retained',lambda:eq(l['statements'][-1]['status'],'ERROR'))
noop=copy.deepcopy(meta_before);noop['backup_preimage_selection']={k:['after']*len(v) for k,v in meta_before['backup_preimage_selection'].items()}
s._collect=lambda c,stage,a,phase:noop if phase=='either' else meta_after
i=Installer();l=log();s.install(i,l);check('exact_current_noop',lambda:eq(l['statements'],[]))
# Compare before/after actual catalog preservation oracle independently, with full raw source records.
s.assert_delta=real_delta
s.A=real_audit
catalog_before={'functions':[{'oid':x['actual']['raw_pg_proc']['oid'],'sha':'before'} for x in before['functions']]+[{'oid':'99990','sha':'other'}],'relations':[{'oid':x['extra']['raw_pg_class']['oid'],'sha':'before'} for x in before['tables']]+[{'oid':x['actual']['raw_pg_class']['oid'],'sha':'before'} for x in before['sequences']]+[{'oid':'99991','sha':'other'}],'event_triggers':[],'default_acl':[]}
catalog_after=copy.deepcopy(catalog_before)
for k in ['functions','relations']:
 for x in catalog_after[k]:
  if x['sha']=='before' and (k!='functions' or int(x['oid'])<90004):x['sha']='after'
check('finite_catalog_delta',lambda:s.assert_delta(catalog_before,catalog_after,before,after))
for category in ['functions','relations']:
 v=copy.deepcopy(catalog_after);v[category][-1]['sha']='altered';check('foreign_'+category+'_delta_refused',lambda v=v:refuses(lambda:s.assert_delta(catalog_before,v,before,after)))
v=copy.deepcopy(after);v['sequences'][0]['actual']['raw_pg_class']['oid']='999';check('sequence_oid_change_refused',lambda:refuses(lambda:s.assert_delta(catalog_before,catalog_after,before,v)))
for f in P.glob('*.py'):compile(f.read_text(),str(f),'exec')
if __name__=='__main__':
 print(json.dumps({'passed':True,'checks':len(checks),'collector_query_count':len(connection.calls),'qualification':'Offline source/model/protocol evidence only; synthetic supplemental catalogs and historical saved0124 original/opening responses. No new native SQL.','results':checks},indent=2))
