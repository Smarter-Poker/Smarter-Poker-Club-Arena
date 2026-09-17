"""Dormant accepted BBJ0123 adapter. No import-time native operations."""
import importlib.util,json,sys
from pathlib import Path
from uuid import UUID
from binding import verify_binding,verify_seal,require,assert_complete_preflight
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
SELECTED=('SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP',)

def author_modules():
    pins=json.loads((HERE/'SOURCE-PINS.json').read_text())
    directory=Path(pins['author_packet'])
    verify_seal(directory,pins['author_integrity_sha256'])
    names=('packet_contract','pair_support','supplemental','noninterference')
    require(not any(n in sys.modules for n in names),'Unexpected conflicting author import name')
    owned={}
    def load(name,file):
        spec=importlib.util.spec_from_file_location(name,directory/file)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
    try:
        for name in names:
            owned[name]=load(name,name+'.py');sys.modules[name]=owned[name]
        case=load('immutable_bbj_case0123','case_module.py')
        require(case.SELECTED==SELECTED,'Author case selection differs')
        return case,owned['supplemental'],pins
    finally:
        for name,module in owned.items():
            require(sys.modules.get(name) is module,'Author module binding changed during import')
            del sys.modules[name]


def cleanup_connection(connection):
    """Attempt all three operations independently; preserve every failure."""
    outcomes=[]
    if connection is None:return outcomes
    for action,operation in (
        ('rollback',lambda:connection.sql('ROLLBACK')),
        ('unlock',lambda:connection.sql('SELECT pg_advisory_unlock_all()')),
        ('close',lambda:connection.close())):
        row={'connection':connection.label,'action':action,'status':'ATTEMPTED'}
        outcomes.append(row)
        try:operation();row['status']='RETURNED'
        except Exception as exc:row.update(status='ERROR',error_type=type(exc).__name__,error=str(exc))
    return outcomes


def complete_original_metadata(connection,preflight,check_registry,schema_fixture,fixture,database,oid):
    boundary=connection.one("SELECT jsonb_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,'socket_only',inet_server_addr() IS NULL,'server_version',current_setting('server_version'),'replication_role',current_setting('session_replication_role'),'users',(SELECT count(*) FROM auth.users),'clubs',(SELECT count(*) FROM public.clubs),'legs',(SELECT count(*) FROM public.chip_ledger),'snapshots',(SELECT count(*) FROM public.ca_account_snapshots))")
    require(boundary['database_oid']==oid,'Metadata connection has wrong physical database OID')
    pf=preflight.check(connection,json.loads((schema_fixture/'FUNCTION-OVERLAY-INPUTS.json').read_text()),json.loads((schema_fixture/'TABLE-OVERLAY-INPUTS.json').read_text()))
    pf['prerequisites']=preflight.check_prerequisites(connection,json.loads((schema_fixture/'NAMESPACE-AND-SEQUENCE-INPUTS.json').read_text()))
    pf['expression_identity']=preflight.check_expression_identity(connection,json.loads((schema_fixture/'CONTEXT-AND-IDENTITY-INPUTS.json').read_text()),(schema_fixture/'NATIVE-EXPRESSION-IDENTITY-QUERY.sql').read_text())
    pf['registry']=check_registry(connection);pf['boundary']=boundary
    pf['passed']=pf['passed'] and pf['prerequisites']['passed'] and pf['expression_identity']['passed'] and pf['registry']['passed']
    assert_complete_preflight(pf,schema_fixture,fixture,expected_database=database,require_empty=False)
    return {'passed':True,'original_identity_count':len(pf['comparisons']),'original_edge_count':pf['expression_identity']['actual_count'],'registry_checks':len(pf['registry']['comparisons']),'prerequisites_passed':pf['prerequisites']['passed'],'raw_original':pf}


def supplemental_preflight(connection):
    _,supplemental,_=author_modules()
    result=supplemental.supplemental_preflight(connection)
    require(result.get('passed') is True and len(result.get('comparisons',[]))==18,'Complete BBJ12+6 supplement required')
    return result


def install_supplemental_owned(connect,authorization,expected_oid,physical):
    verify_binding(authorization)
    from normalization import normalize_owned_fixture
    report={'status':'RUNNING','events':[],'normalization':None,'cleanup_outcomes':[]};connection=None
    try:
        connection=connect('bbj_exact_acl_install',report['events'])
        report['normalization']=normalize_owned_fixture(connection,expected_oid,physical)
        require(report['normalization']['status']=='EXACT_ACL_TRANSITIONS_COMMITTED','Exact ACL transition not established')
        report['status']='INSTALLED_OR_EXACT_NOOP'
    except Exception as exc:
        report.update(status='FAIL',error_type=type(exc).__name__,error=str(exc))
        if hasattr(exc,'normalization_report'):report['normalization']=exc.normalization_report
    finally:
        report['cleanup_outcomes']=cleanup_connection(connection)
        if connection is not None:report['connection_stderr']=list(connection.errors)
        if any(r['status']=='ERROR' for r in report['cleanup_outcomes']):report['status']='FAIL'
    return report


def execute_prepared_case(case,connect,seed,base_driver,authorization,combined=None,metadata_check=None,database=None,database_oid=None):
    verify_binding(authorization,base_driver,case)
    require(callable(combined) and callable(metadata_check),'Original combined and full metadata callbacks required')
    require(database==case.lower() and type(database_oid) is str and database_oid.isdecimal() and str(int(database_oid))==database_oid and 0<int(database_oid)<=4294967295,'Root created physical case identity required')
    operation=str(UUID(authorization['operation_id']))
    module,_,pins=author_modules()
    derived={'authorized':True,'case':case,'case_review_accepted':True,'root_adapter_review_accepted':True,'packet_sha256':pins['author_integrity_sha256'],'seed_sha256':pins['seed_sha256'],'database':database,'database_oid':database_oid,'operation_id':operation}
    return module.execute_prepared_case(case,connect,seed,base_driver,derived,combined,metadata_check)
