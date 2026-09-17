"""Bounded offline integration checks. No DB/process/network or financial subject execution.
Mocks isolate adapter orchestration; financial bodies/oracles remain unchanged and unexecuted.
"""
import ast
import hashlib
import importlib.util
import json
import sys
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import binding
import case_module as adapter
import build_adapter
checks=[]
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append({'name':name,'passed':True})
def refused(name,fn):
    try:fn()
    except Exception:
        check(name,True);return
    raise AssertionError('Did not refuse: '+name)
def source_functions(path):
    return {n.name:n for n in ast.parse(path.read_text()).body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))}
def body_dump(n):
    v=deepcopy(n)
    if v.body and isinstance(v.body[0],ast.Expr) and isinstance(v.body[0].value,ast.Constant) and isinstance(v.body[0].value.value,str):v.body=v.body[1:]
    return ast.dump(v,include_attributes=False)

pins=binding.load(HERE/'SOURCE-PINS.json');parent=Path(pins['opening_adapter'])
original=(parent/'run_integration.py').read_text();candidate=(HERE/'run_integration.py').read_text()
rendered,transforms=build_adapter.render(original)
check('Candidate is exact declared source transform',rendered==candidate)
for i,t in enumerate(reversed(transforms)):
    check('Reverse transform unique '+str(i),rendered.count(t['after'])==1)
    rendered=rendered.replace(t['after'],t['before'],1)
check('Reverse transforms recover every parent source byte',rendered==original)
check('Original combined request byte identical',(HERE/'COMBINED-COMMAND.sql').read_bytes()==(parent/'COMBINED-COMMAND.sql').read_bytes())
funcs=source_functions(HERE/'case_module.py');oldfuncs=source_functions(parent/'case_module.py')
check('Independent accepted cleanup function AST retained',body_dump(funcs['cleanup_connection'])==body_dump(oldfuncs['cleanup_connection']))
oldmain=source_functions(parent/'run_integration.py')['main'];newmain=source_functions(HERE/'run_integration.py')['main']
for name in ('command','admit','write','catalog','cleanup_probe'):
    old=next(n for n in ast.walk(oldmain) if isinstance(n,ast.FunctionDef) and n.name==name)
    new=next(n for n in ast.walk(newmain) if isinstance(n,ast.FunctionDef) and n.name==name)
    check('Original resource/evidence/catalog function AST '+name,body_dump(old)==body_dump(new))
marker='# Stop only the freshly-created owned cluster.'
check('Entire original physical cleanup/evidence tail byte identical',original[original.index(marker):]==candidate[candidate.index(marker):])
for name in ['binding.py','case_module.py','run_integration.py','build_adapter.py']:
    tree=ast.parse((HERE/name).read_text());check('Parses '+name,True)
check('Exact phase command count five','combined_count!=5' in candidate)
check('No seed/opening financial writer transplanted into adapter','fn_bbj_move_between_banks(' not in candidate and 'fn_complete_club_opening_setup(' not in candidate)
check('Original Psql constructor exact delegation','Psql.__init__(c, args, env, label, events)' in (HERE/'case_module.py').read_text())
check('Registration precedes constructor', (HERE/'case_module.py').read_text().index('registry.append(row)') < (HERE/'case_module.py').read_text().index('Psql.__init__(c'))
check('All existing 438 parent input rows inherited',pins['inputs'][:438]==binding.load(parent/'SOURCE-PINS.json')['inputs'])
refused('False author template refuses before seal/native',lambda:binding.verify_binding(binding.load(HERE/'AUTHORIZATION-TEMPLATE.json')))

sample_pins={'backup_integrity_sha256':'b'*64,'opening_adapter_integrity_sha256':'o'*64,'supplemental_integrity_sha256':'s'*64}
auth={'integrity_sha256':'a'*64}
decision={'accepted_for_isolated_native_execution':True,'source_review_complete':True,'adapter_integrity_sha256':'a'*64,'author_integrity_sha256':'b'*64,'opening_adapter_integrity_sha256':'o'*64,'supplemental_integrity_sha256':'s'*64,'supplemental_source_accepted':True}
binding.validate_root_decision(decision,auth,sample_pins);check('Exact root source decision shape allowed',True)
for key in decision:
    d=deepcopy(decision);d.pop(key);refused('Missing decision '+key,lambda d=d:binding.validate_root_decision(d,auth,sample_pins))
    d=deepcopy(decision);d[key]='true' if isinstance(d[key],bool) else 'f'*64
    refused('Wrong type/hash decision '+key,lambda d=d:binding.validate_root_decision(d,auth,sample_pins))

identity={'database':'fixture_base','database_oid':'123','system_identifier':'1234567890123456789','data_directory':'/private/tmp/owned/data','socket_directory':'/private/tmp/owned/sock'}
actual={**identity,'role':'postgres','session_role':'postgres','socket':True,'replication':'origin','server_version':'17.11','pid':321,'backend_start':'2026-09-14 00:00:00+00'}
adapter.validate_physical(actual,identity);check('Exact physical endpoint passes source predicate',True)
for key in actual:
    changed=deepcopy(actual);changed[key]=False if key=='socket' else None if key=='backend_start' else 'different'
    refused('Physical mismatch '+key,lambda changed=changed:adapter.validate_physical(changed,identity))
for oid in ('0123','0','4294967296',123,True):
    changed=deepcopy(identity);changed['database_oid']=oid
    observation={**actual,**changed}
    refused('Noncanonical OID '+repr(oid),lambda:adapter.validate_physical(observation,changed))

class Process:
    def __init__(self,exit=None):self.exit=exit
    def poll(self):return self.exit
class Pipe:
    def __init__(self,fail=(),exit=None):self.label='owned';self.errors=[];self.p=Process(exit);self.calls=[];self.fail=fail
    def sql(self,sql):
        self.calls.append(sql)
        if sql in self.fail:raise RuntimeError('fault:'+sql)
    def close(self):
        self.calls.append('close')
        if 'close' in self.fail:raise RuntimeError('fault:close')
        self.p.exit=0
for failures in [(),('ROLLBACK',),('SELECT pg_advisory_unlock_all()',),('close',),('ROLLBACK','SELECT pg_advisory_unlock_all()','close')]:
    pipe=Pipe(failures);r=adapter.cleanup_connection(pipe)
    check('Every cleanup attempted '+repr(failures),pipe.calls==['ROLLBACK','SELECT pg_advisory_unlock_all()','close'])
    check('All cleanup failures preserved '+repr(failures),sum(x['status']=='ERROR' for x in r)==len(failures))
pipe=Pipe(exit=0);registry=[dict(connection=pipe,label='closed',events=[{'a':1}],constructor_status='RETURNED',physical=actual)]
r=adapter.cleanup_registry(registry);check('Already exited original client positively closed without broken-pipe SQL',pipe.calls==[] and r[0]['exit_after_cleanup']==0 and not adapter.registry_failed(r))
check('Shared SQL event logs not duplicated per cleanup row','events' not in r[0] and r[0]['event_count']==1)
for failures in [('ROLLBACK',),('close',)]:
    pipe=Pipe(failures);other=Pipe();rs=[dict(connection=x,label='x',events=[],constructor_status='RETURNED',physical=actual) for x in (pipe,other)]
    r=adapter.cleanup_registry(rs);check('Cleanup failure does not skip other connection '+repr(failures),other.calls==['ROLLBACK','RESET ALL','SELECT pg_advisory_unlock_all()','close'] and adapter.registry_failed(r))
partial=SimpleNamespace();r=adapter.cleanup_registry([dict(connection=partial,label='partial',events=[{'attempt':'constructor'}],constructor_status='FAILED',physical=None)])
check('Partial constructor retained/fails with own attempted events',adapter.registry_failed(r) and r[0]['failed_constructor_events']==[{'attempt':'constructor'}])

class Constructed:
    init_error=False
    def __init__(self,args,env,label,record):
        self.label=label;self.record=record;self.p=Process();self.errors=[]
        if self.init_error:raise RuntimeError('constructor-fault')
    def one(self,sql):return actual
    def sql(self,sql):return []
    def close(self):self.p.exit=0
reg=[];obj=adapter.owned_connect(Constructed,[],{},'fresh',[],reg,identity)
check('Actual factory returns same original-type object registered before boundary',reg[0]['connection'] is obj and type(obj)is Constructed and reg[0]['constructor_status']=='RETURNED')
Constructed.init_error=True;reg=[]
refused('Constructor fault propagated',lambda:adapter.owned_connect(Constructed,[],{},'partial',[],reg,identity))
check('Constructor fault ownership retained',len(reg)==1 and reg[0]['constructor_status']=='FAILED' and hasattr(reg[0]['connection'],'p'))
Constructed.init_error=False

# Adapter-only choreography probes. No authored financial function/oracle is imported or called.
original_verify=adapter.verify_binding;original_parent=adapter.parent_modules;original_backup=adapter.backup_module
funding={'case':'SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP','status':'PASS_IMPLEMENTED_SUBSET','cleanup_errors':[],'actual_decimal_token':Decimal('100.00')}
new_names=['ca_bbj_bucket_moves','bbj_payouts','bbj_unclaimed_shares','bbj_hand_evidence_log','bbj_ledger_deletions','bbj_payout_recipients']
raw={n:[] for n in ['auth.users','public.clubs','public.chip_ledger','public.ca_account_snapshots','public.ca_currency_meter']+['public.'+x for x in new_names]}
try:
    adapter.verify_binding=lambda *a,**k:None
    for mode in ['success','funding_fail','funding_throw','backup_fail','backup_throw','phase_throw','extra_seed','metadata_fail','preseed_cleanup_fail']:
        counts={'seed':0,'opening':0,'backup':0,'phase':[]};token=deepcopy(funding);pipes=[]
        def opening_call(case,connect,seed,driver,auth,combined,metadata):
            counts['opening']+=1
            if mode=='funding_throw':raise RuntimeError('original opening failure')
            seed()
            if mode=='extra_seed':seed()
            if mode=='funding_fail':return dict(token,status='FAIL',saved='complete-original-failure')
            for _ in range(3):combined()
            return token
        opening=SimpleNamespace(CASE='SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP',__file__=str(Path(pins['author_packet'])/'case_module.py'),execute_prepared_case=opening_call)
        def backup_call(case,connect,seed,driver,auth,combined,metadata,opening_arg,funding_arg):
            counts['backup']+=1
            check('Funding object identity/Decimal preserved '+mode,funding_arg is token and funding_arg['actual_decimal_token']==Decimal('100.00') and opening_arg is opening)
            if mode=='backup_throw':raise RuntimeError('backup-entry-failure')
            if mode=='backup_fail':return {'status':'FAIL','raw_evidence':'complete-backup-failure'}
            combined();combined();return {'status':'PASS_IMPLEMENTED_SUBSET','raw_evidence':'complete-backup-result'}
        backup=SimpleNamespace(capture=lambda c:dict(raw=raw),read=lambda name:{'new_supporting_relations':new_names},execute_prepared_case=backup_call)
        adapter.parent_modules=lambda:(None,None,opening,None);adapter.backup_module=lambda:backup
        def connect(label,events):
            p=Pipe(('ROLLBACK',) if mode=='preseed_cleanup_fail' else ());pipes.append(p);return p
        def seed():counts['seed']+=1
        def combined(phase):
            counts['phase'].append(phase)
            if mode=='phase_throw':raise RuntimeError('saved dispatch failure')
            return {'source_probe_only':True}
        def metadata(c):
            if mode=='metadata_fail':raise RuntimeError('catalog fault')
            return {'source_probe_only':True}
        authorization={'opening_operation_id':'a5aeb906-ff62-4a41-9a00-f43249b1b3d6','move_operation':'new-move','move_reason':'synthetic backup reason'}
        result=adapter.execute_prepared_case(adapter.CASE,connect,seed,SimpleNamespace(),authorization,combined,metadata,adapter.CASE.lower(),'123')
        check('Adapter verdict '+mode,result['status']==('PASS_IMPLEMENTED_SUBSET' if mode=='success' else 'FAIL'))
        check('Single seed upper bound '+mode,counts['seed']<=1)
        if mode=='success':
            check('Genuine interface order exactly opening3 backup2',counts=={'seed':1,'opening':1,'backup':1,'phase':['opening:BEFORE','opening:FIRST-POSITIVE','opening:STABLE','backup:FIRST-BACKUP-POSITIVE','backup:STABLE-BACKUP']})
            check('Full original result retained without serialization',result['funding_result'] is token)
        if mode in ('funding_fail','funding_throw','phase_throw','extra_seed','metadata_fail','preseed_cleanup_fail'):
            check('Backup withheld after original prerequisite failure '+mode,counts['backup']==0)
        if mode=='funding_fail':check('Full original failure retained',result['funding_result']['saved']=='complete-original-failure')
        if mode=='backup_fail':check('Full backup failure retained',result['backup_result']['raw_evidence']=='complete-backup-failure')
        if mode=='preseed_cleanup_fail':check('Preseed all cleanup attempted before any seed',pipes[0].calls==['ROLLBACK','SELECT pg_advisory_unlock_all()','close'] and counts['seed']==0)
finally:
    adapter.verify_binding=original_verify;adapter.parent_modules=original_parent;adapter.backup_module=original_backup

# Exercise the actual accepted backup metadata predicate through the new transaction wrapper.
actual_backup=adapter.backup_module()
metadata_model={'passed':True,'original_identity_count':327,'original_edge_count':2957,'registry_checks':16,'prerequisites_passed':True,
 'opening_supplemental_12_functions_6_relations_passed':True,'backup':{
 'passed':True,'source_model_sha256':actual_backup.sha(actual_backup.HERE/'DEPENDENCY-CONTRACT.json'),
 'raw_catalog_observations_retained':True,'historical_support_scope_matched':True,
 'functions':[{k:v for k,v in (x['metadata']|{'signature':x['signature']}).items() if k!='raw_pg_proc'} for x in actual_backup.read('CURRENT-FUNCTIONS.json')],
 'relations':[{'relation':x['relation'],'metadata':x['metadata']} for x in actual_backup.read('CURRENT-RELATIONS.json')],
 'trigger_functions':actual_backup.read('SUPPLEMENTAL-TRIGGER-MODELS.json'),
 'all_internal_RI_trigger_modes_and_constraints_passed':True,'sequence_max_text':'9223372036854775807','sequence_config_ownership_acl_passed':True}}
class MetadataPipe(Pipe):
    def one(self,sql):self.calls.append(sql);return 'original_path'
original_supp=adapter.supplemental_module
try:
    for mode in ['pass','false_metadata','fake_true','commit_failure','rollback_failure','restore_failure']:
        model=deepcopy(metadata_model)
        if mode=='false_metadata':model['backup']['passed']=False
        if mode=='fake_true':model['backup']['sequence_config_ownership_acl_passed']='true'
        failure={'commit_failure':'COMMIT','rollback_failure':'ROLLBACK','restore_failure':"SELECT set_config('search_path','original_path',false)"}.get(mode)
        conn=MetadataPipe((failure,) if failure else ())
        adapter.supplemental_module=lambda:SimpleNamespace(collect=lambda conn,stage:model)
        if mode=='pass':
            out=adapter.backup_preflight(conn,'offline_contract');check('Actual backup predicate returns validated supplemental result',out is model)
        else:
            try:adapter.backup_preflight(conn,'offline_contract')
            except Exception as exc:
                check('Metadata full report preserved '+mode,getattr(exc,'backup_metadata_report',{}).get('catalog') is model)
                check('Metadata rollback and restore independently attempted '+mode,'ROLLBACK' in conn.calls and conn.calls[-1]=="SELECT set_config('search_path','original_path',false)")
            else:raise AssertionError('metadata wrapper did not refuse '+mode)
finally:adapter.supplemental_module=original_supp

# Installer wrapper uses the same mutable supplemental report, preserving exact failures.
original_metadata=adapter.backup_preflight
original_audit=adapter.audit_postflight
try:
    # Orthogonal installer protocol checks; actual audit reader faults below.
    adapter.audit_postflight=lambda *a:{'capture':{'modeled_audit':True}}
    adapter.verify_binding=lambda *a,**k:None
    adapter.parent_modules=lambda:(None,SimpleNamespace(normalize_owned_fixture=lambda *a:{'status':'EXACT_ACL_TRANSITIONS_COMMITTED'}),None,None)
    adapter.backup_preflight=lambda *a:metadata_model
    for mode in ['pass','throw','returned_failed','uncertain','new_object']:
        conn=Pipe();conn.one=lambda sql:actual
        captured={}
        def install(c,report):
            captured['report']=report
            report.update(status='INSTALLED_OR_EXACT_NOOP',commit_status='COMMITTED',cleanup_errors=[],raw_before={'retained':True},audit_after={'modeled_audit':True})
            if mode=='throw':
                exc=RuntimeError('install failure');exc.supplemental_report=report;raise exc
            if mode=='returned_failed':report['status']='FAIL'
            if mode=='uncertain':report['commit_status']='UNCERTAIN'
            return dict(report) if mode=='new_object' else report
        adapter.supplemental_module=lambda:SimpleNamespace(install=install,A=SimpleNamespace(assert_persisted=lambda *a:None))
        post_conn=Pipe();post_conn.one=lambda sql:actual
        result=adapter.install_supplemental_owned(lambda label,events:post_conn if label=='bbj_install_failure_postflight' else conn,{},'123',identity)
        check('Installer result '+mode,result['status']==('INSTALLED_OR_EXACT_NOOP' if mode=='pass' else 'FAIL'))
        check('Installer same mutable report/failure preserved '+mode,result['backup_installation'] is captured['report'] and result['backup_installation']['raw_before']=={'retained':True})
        check('Installer always attempts all connection cleanup '+mode,conn.calls==['ROLLBACK','RESET ALL','SELECT pg_advisory_unlock_all()','close'])
        if mode!='pass':check('Installer failure attempts separate postflight and retains FAIL '+mode,'failure_postflight' in result and result['status']=='FAIL' and post_conn.calls[-4:]==['ROLLBACK','RESET ALL','SELECT pg_advisory_unlock_all()','close'])
finally:
    adapter.verify_binding=original_verify;adapter.parent_modules=original_parent;adapter.backup_preflight=original_metadata;adapter.supplemental_module=original_supp;adapter.audit_postflight=original_audit

# Pending protected checks for failure-path evidence retention. These are source
# additions; the retained OFFLINE-CHECKS.json predates them and is not new proof.
original_backup=adapter.backup_module
try:
    adapter.audit_postflight=lambda *a:{'capture':{'modeled_audit':True}}
    for mode in ['catalog_failure','raw_failure','constructor_failure','physical_failure','after_physical_failure','cleanup_failure']:
        pipe=Pipe(('ROLLBACK','RESET ALL') if mode=='cleanup_failure' else ())
        activity=[]
        physical_reads=[0]
        def physical_read(sql):
            physical_reads[0]+=1
            return {**actual,'database':'wrong'} if mode=='physical_failure' or (mode=='after_physical_failure' and physical_reads[0]==2) else actual
        pipe.one=physical_read
        def fresh_connect(label,events):
            activity.append('constructor')
            if mode=='constructor_failure':raise RuntimeError('original constructor failure')
            return pipe
        def catalog_read(connection,stage):
            activity.append('catalog')
            if mode=='catalog_failure':
                exc=RuntimeError('current metadata mismatch');exc.backup_metadata_report={'raw_catalog':'retained'};raise exc
            return {'complete_catalog':'retained'}
        def raw_read(connection):
            activity.append('raw')
            if mode=='raw_failure':
                exc=RuntimeError('raw capture failure');exc.capture_cleanup_errors=['original cleanup error'];raise exc
            return {'all57':'retained'}
        adapter.backup_preflight=catalog_read
        adapter.backup_module=lambda:SimpleNamespace(capture=raw_read)
        saved=adapter.capture_failed_postflight(fresh_connect,identity,'source_fault')
        if mode in ['constructor_failure','physical_failure']:
            check('Unknown constructor/endpoint prevents catalog and raw '+mode,activity==['constructor'] and saved['status']=='FAIL')
        else:
            check('Catalog and raw attempted independently '+mode,activity==['constructor','catalog','raw'])
        if mode=='catalog_failure':
            check('Catalog failure preserves exact report and raw57',saved['backup_metadata_report']=={'raw_catalog':'retained'} and saved['raw']=={'all57':'retained'} and saved['status']=='CAPTURED_WITH_FAILURES')
        if mode=='raw_failure':
            check('Raw failure preserves full original cleanup error',saved['errors'][0]['capture_cleanup_errors']==['original cleanup error'] and saved['status']=='CAPTURED_WITH_FAILURES')
        if mode=='after_physical_failure':
            check('Changed endpoint after capture retains evidence and fails',saved['raw']=={'all57':'retained'} and saved['status']=='FAIL')
        if mode!='constructor_failure':
            check('Every independent failure reader cleanup attempted '+mode,pipe.calls==['ROLLBACK','RESET ALL','SELECT pg_advisory_unlock_all()','close'])
        if mode=='cleanup_failure':
            check('Both cleanup errors retained without erasing raw',saved['raw']=={'all57':'retained'} and saved['status']=='CLEANUP_FAILED' and sum(x['status']=='ERROR' for x in saved['cleanup'])==2)
finally:
    adapter.backup_preflight=original_metadata;adapter.backup_module=original_backup;adapter.audit_postflight=original_audit

report={'status':'PASS','scope':'Offline source transformations, parsed authorization/identity, constructor/cleanup and adapter-only orchestration. Modeled schedules are not financial/native proof.','checks':checks,'check_count':len(checks),'native_calls':0,'financial_subject_execution':False,'normal_author_tests_rerun':False,'supplemental_composition_sealed':pins.get('supplemental_integrity_sha256') is not None,'python':sys.version,'platform':sys.platform}
if (HERE/'INTEGRITY.json').exists():
    # The protected lane retains this complete fresh report outside the sealed
    # source packet. Never overwrite the predecessor's saved check evidence.
    print(json.dumps({**report,'sealed_report_preserved':True},indent=2))
else:
    (HERE/'OFFLINE-CHECKS.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':'PASS','checks':len(checks),'native_calls':0}))
