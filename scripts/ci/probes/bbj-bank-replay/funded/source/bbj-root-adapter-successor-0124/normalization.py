"""Exact empty owned-fixture ACL provisioning; no function bodies/schema rewritten."""
from pathlib import Path
import copy,json,importlib.util,sys,re
from binding import require,assert_complete_preflight
from catalog_queries import literal,function_query,relation_extra_query
HERE=Path(__file__).resolve().parent

def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def original_preflight(c,pins):
    schema=Path(pins['schema_fixture']);fixture=Path(pins['fixture']);pre=load_module('bbj_original_preflight',schema/'preflight.py')
    sys.path.insert(0,str(fixture))
    try:registry=load_module('bbj_original_registry',fixture/'registry_preflight.py')
    finally:sys.path.pop(0)
    report=pre.check(c,json.loads((schema/'FUNCTION-OVERLAY-INPUTS.json').read_text()),json.loads((schema/'TABLE-OVERLAY-INPUTS.json').read_text()))
    report['prerequisites']=pre.check_prerequisites(c,json.loads((schema/'NAMESPACE-AND-SEQUENCE-INPUTS.json').read_text()))
    report['expression_identity']=pre.check_expression_identity(c,json.loads((schema/'CONTEXT-AND-IDENTITY-INPUTS.json').read_text()),(schema/'NATIVE-EXPRESSION-IDENTITY-QUERY.sql').read_text())
    report['registry']=registry.check_registry(c)
    report['boundary']=c.one("SELECT jsonb_build_object('database',current_database(),'role',current_user,'socket_only',inet_server_addr() IS NULL,'server_version',current_setting('server_version'),'replication_role',current_setting('session_replication_role'),'users',(SELECT count(*) FROM auth.users),'clubs',(SELECT count(*) FROM public.clubs),'legs',(SELECT count(*) FROM public.chip_ledger),'snapshots',(SELECT count(*) FROM public.ca_account_snapshots))")
    report['passed']=report['passed'] and report['prerequisites']['passed'] and report['expression_identity']['passed'] and report['registry']['passed']
    assert_complete_preflight(report,schema,fixture)
    return report

def collect(c,functions,tables):
    records={'functions':[],'tables':[],'errors':[]}
    for kind,rows in [('functions',functions),('tables',tables)]:
        for e in rows:
            name=e['signature'] if kind=='functions' else e['relation'];r={'identity':name};records[kind].append(r)
            try:
                if kind=='functions':r['actual']=c.one(function_query(name))
                else:
                    query=(HERE/'RELATION-QUERY.sql').read_text().strip().rstrip(';').replace('{relation_literal}',literal(name))
                    r['actual']=c.one("SELECT COALESCE(("+query+"),'null'::jsonb)");r['extra']=c.one(relation_extra_query(name))
            except Exception as exc:r['error']=str(exc);records['errors'].append({'identity':name,'error':str(exc)})
    return records

def validate(records,functions,tables,phase,checker):
    require(not records['errors'] and len(records['functions'])==12 and len(records['tables'])==6,'Complete finite catalog capture required')
    for got,e in zip(records['functions'],functions):
        a=got.get('actual');require(got['identity']==e['signature'] and type(a)is dict,'Missing/changed function identity')
        require(all(a.get(k)==v for k,v in e[phase].items()),'Unknown full function '+phase+' mismatch: '+e['signature'])
    for got,e in zip(records['tables'],tables):
        require(got['identity']==e['relation'] and type(got.get('actual'))is dict and type(got.get('extra'))is dict,'Missing/changed relation identity')
        class Reader:
            def sql(self,query):require(query=="SELECT pg_catalog.set_config('search_path','pg_catalog,public,extensions',false)",'Unexpected comparator command')
            def one(self,query):return got['actual']
        result=checker.check(Reader(),[],[e[phase]]);got['comparison_'+phase]=result
        require(result['passed'],'Unknown full relation '+phase+' mismatch: '+e['relation'])
        raw=got['extra']['raw_pg_class'];require(all(raw[k]==e[phase][k] for k in ['relpersistence','relreplident']),'Relation identity flags differ')

def invariant_catalog(c):
    return c.one("SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'sha',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.oid) FROM pg_proc p),'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid::text,'sha',encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex')) ORDER BY c.oid) FROM pg_class c),'event_triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.evtname,'event',e.evtevent,'enabled',e.evtenabled,'tags',e.evttags,'owner',pg_get_userbyid(e.evtowner),'function_schema',n.nspname,'function_name',p.proname) ORDER BY e.evtname) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace),'[]'::jsonb),'default_acl',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),'[]'::jsonb))")

def assert_only_acl_changes(before,after,baseline,final):
    require(before['event_triggers']==after['event_triggers'] and before['default_acl']==after['default_acl']==[],'Event guards or default privileges changed')
    allowed_f=set();allowed_t=set()
    for b,a in zip(baseline['functions'],final['functions']):
        old=b['actual']['raw_pg_proc'];new=a['actual']['raw_pg_proc'];require({k:v for k,v in old.items() if k!='proacl'}=={k:v for k,v in new.items() if k!='proacl'},'Function non-ACL metadata changed')
        allowed_f.add(str(old['oid']))
    for b,a in zip(baseline['tables'],final['tables']):
        old=copy.deepcopy(b['extra']);new=copy.deepcopy(a['extra']);allowed_t.add(str(old['raw_pg_class']['oid']))
        old['raw_pg_class'].pop('relacl',None);new['raw_pg_class'].pop('relacl',None);require(old==new,'Relation non-ACL metadata changed')
    for key,allowed in [('functions',allowed_f),('relations',allowed_t)]:
        old={x['oid']:x['sha'] for x in before[key]};new={x['oid']:x['sha'] for x in after[key]}
        require(set(old)==set(new) and all(new[k]==v for k,v in old.items() if k not in allowed),'Unexpected owned catalog side effect outside finite ACL set')

def normalize_owned_fixture(c,expected_oid,physical):
    pins=json.loads((HERE/'SOURCE-PINS.json').read_text());functions=json.loads((HERE/'FUNCTION-TRANSITIONS.json').read_text());tables=json.loads((HERE/'TABLE-TRANSITIONS.json').read_text())
    require(type(expected_oid)is str and re.fullmatch('[1-9][0-9]*',expected_oid) is not None and int(expected_oid)<=4294967295,'Exact created base OID required')
    report={'status':'RUNNING','before':None,'after':None,'statements':[],'commit_status':'NOT_ATTEMPTED','cleanup_errors':[],'bodies_changed':False,'financial_rows_written':False}
    try:
        c.sql("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'; SET LOCAL search_path=pg_catalog,public,extensions")
        boundary=c.one("SELECT jsonb_build_object('database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'socket',inet_server_addr() IS NULL,'replication',current_setting('session_replication_role'),'data_directory',current_setting('data_directory'),'socket_directory',current_setting('unix_socket_directories'),'allow_privileged_anon_grant',current_setting('app.allow_privileged_anon_grant',true))")
        report['boundary']=boundary
        require(all(boundary[k]==v for k,v in {'database':'fixture_base','oid':expected_oid,'role':'postgres','superuser':True,'socket':True,'replication':'origin',**physical}.items()),'Wrong root-owned empty fixture identity')
        require(boundary['allow_privileged_anon_grant'] in (None,'','off'),'Event-guard bypass setting present')
        c.sql('LOCK TABLE '+','.join(e['relation'] for e in tables)+' IN ACCESS EXCLUSIVE MODE')
        report['original_before']=original_preflight(c,pins)
        empty_query="SELECT jsonb_build_object("+','.join(literal(e['relation'])+",(SELECT count(*) FROM "+e['relation']+")" for e in tables)+")"
        report['empty_before']=c.one(empty_query);require(all(type(v)is int and v==0 for v in report['empty_before'].values()),'Supplemental seed rows already exist')
        report['catalog_before']=invariant_catalog(c)
        expected_events=json.loads((HERE/'EVENT-TRIGGERS-EXPECTED.json').read_text())
        require(report['catalog_before']['event_triggers']==expected_events and report['catalog_before']['default_acl']==[],'Exact original event guard/default privilege contract differs')
        report['before']=collect(c,functions,tables)
        checker=load_module('bbj_transition_original_checker',Path(pins['schema_fixture'])/'preflight.py')
        validate(report['before'],functions,tables,'before',checker)
        for e in functions+tables:
            for sql in e['statements']:
                report['statements'].append({'sql':sql,'status':'ATTEMPTED'});c.sql(sql);report['statements'][-1]['status']='RETURNED'
        report['after']=collect(c,functions,tables);validate(report['after'],functions,tables,'after',checker)
        report['catalog_after']=invariant_catalog(c);assert_only_acl_changes(report['catalog_before'],report['catalog_after'],report['before'],report['after'])
        report['empty_after']=c.one(empty_query);require(report['empty_after']==report['empty_before'],'Unexpected supplemental financial/config rows during ACL provisioning')
        report['original_after']=original_preflight(c,pins)
        report['commit_status']='ATTEMPTED';c.sql('COMMIT');report['commit_status']='COMMITTED';report['status']='EXACT_ACL_TRANSITIONS_COMMITTED'
    except Exception as exc:
        if report['commit_status']=='ATTEMPTED':report['commit_status']='UNCERTAIN'
        report.update(status='FAIL',error_type=type(exc).__name__,error=str(exc))
        try:c.sql('ROLLBACK')
        except Exception as cleanup:report['cleanup_errors'].append({'action':'rollback','error':str(cleanup)})
        exc.normalization_report=report;raise
    return report
