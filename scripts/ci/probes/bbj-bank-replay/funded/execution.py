"""Internal retained funded-case lifetime, called only by the existing BBJ replay entry point.

The original backup adapter body and physical cleanup are preserved. The finite
portable/current-operation substitutions are recorded in CALLER-TRANSFORMS.json.
This file has no command line entry point and accepts no external DSN or approval.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from types import SimpleNamespace

from deadline import install_driver_deadline


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def retain_teardown_failure(ledger, budget, stage, error):
    """Keep the first interruption and later failures without skipping owned cleanup."""
    chain=[]
    current=error
    while current is not None and len(chain)<8:
        chain.append({'error_type':type(current).__name__,'error':str(current)})
        current=current.__context__
    ledger.setdefault('teardown_failures',[]).append({'stage':stage,'errors':chain})
    ledger['status']='TEARDOWN_FAILED_OUTCOME_UNCERTAIN'
    ledger['financial_outcome']='UNQUALIFIED_OR_UNCERTAIN_NO_RETRY'
    if any(row['error_type'] in ('KeyboardInterrupt','SystemExit','DeadlineExpired','TimeoutError') for row in chain):
        budget.execution_refused=True


def finish_owned_teardown(ledger, budget, *, postflight, clients, helpers, physical, release, evidence):
    """The existing final stages always get their own bounded cleanup attempt."""
    ledger.setdefault('cleanup',{'inactive_proven':False,'owned_directory_removed':False})
    rows=ledger.setdefault('teardown_stages',[])
    for name,action in (('base_postflight',postflight),('owned_clients',clients),
                        ('owned_helpers',helpers),('physical_cleanup',physical),
                        ('reserve_release',release),('final_evidence',evidence)):
        row={'stage':name,'status':'ATTEMPTED'}
        rows.append(row)
        try:
            action()
            row['status']='RETURNED'
        except BaseException as error:
            retain_teardown_failure(ledger,budget,name,error)
            row.update(status='FAILED_OR_UNCERTAIN',error_type=type(error).__name__)
    if ledger.get('teardown_failures'):
        ledger['status']='TEARDOWN_FAILED_OUTCOME_UNCERTAIN'


def execute_retained_case(binding, review, evidence, pg_bin, temp_parent, regression_check):
    budget=binding.operation.case_deadline(binding.selected)
    with budget.bounded('case_source_binding',budget.remaining()):
        binding.verify_binding(review)
    BIN=Path(pg_bin)
    temp_parent=Path(temp_parent)
    fixture=binding.custody.group_path('registry')
    resource_fixture=binding.custody.group_path('resources')
    schema_fixture=binding.custody.group_path('schema')
    selected=[binding.selected]
    config=binding.checked_config()
    resource=binding.resource
    EvidenceStore,DiskBudgetError,space_probe=(resource.EvidenceStore,resource.DiskBudgetError,resource.space_probe)
    STARTUP_DATA_FREE,WORKING_HEADROOM=resource.STARTUP_DATA_FREE,resource.WORKING_HEADROOM
    canonical_oid,require_owned_database_identity=binding.identity.canonical_oid,binding.identity.require_owned_database_identity
    decode_catalog_result=binding.parser.decode_catalog_result
    check_registry=binding.registry.check_registry
    extension=binding.adapter
    seed_path=binding.custody.source_path('resources/seed.sql')
    driver=binding.driver
    preflight=binding.preflight
    Psql=install_driver_deadline(driver,budget,literal_dispatch=binding.literal_dispatch)
    check,check_prerequisites,check_expression_identity=(preflight.check,preflight.check_prerequisites,preflight.check_expression_identity)
    assert_complete_preflight=binding.binding.assert_complete_preflight
    runid=review['case_attempt_id']
    store=EvidenceStore(evidence)
    root=data=sock=None
    env=dict(binding.operation.child_env)
    ledger={'runid':runid,'current_accounting_ci':binding.operation.identity,'current_case_attempt':dict(review),
            'status':'ATTEMPTED_OUTCOME_UNCERTAIN','helper_choice':'original_current_capture',
            'no_remote_dsn':True,'current_capture_pg':'17.6','local_pg':'17.11',
            'runtime':binding.operation.runtime,'historical_authority_reused':False,
            'schema_fixture_integrity_sha256':config['schema_fixture_integrity_sha256'],
            'seed_sha256':digest(seed_path),'driver_sha256':digest(schema_fixture/'sequence_driver.py'),
            'fixture_integrity_sha256':config['fixture_integrity_sha256'],
            'selected_cases':selected,'whole_original_cases_qualified':[],
            'commands':[], 'cases':[], 'disk_checks':[], 'case_database_disposals':[]}
    def write(path,obj,emergency=False):
        ledger['deadline']=budget.report()
        ledger['evidence_reserve_released']=store.reserve_released
        ledger['evidence_space_exhausted']=store.space_exhausted
        with budget.bounded('evidence_write',budget.remaining(emergency),emergency):
            store.write(path,obj,emergency=emergency)
    def admit(stage,required):
        budget.checkpoint()
        with budget.bounded('source_and_space_admission',budget.remaining()):
            binding.operation.assert_pristine()
        row=space_probe(stage,root if root else temp_parent,evidence,required)
        ledger['disk_checks'].append(row)
        write(evidence/'RUN.json',ledger)
        if not row['admitted']:
            ledger['resource_admission_refused']=stage
            raise DiskBudgetError('Insufficient recorded disk headroom at '+stage)
    def command(argv, stdin=None, timeout=180, cleanup=False):
        if (store.space_exhausted or ledger.get('resource_admission_refused')) and not cleanup:
            raise DiskBudgetError('Further native work refused after storage admission/evidence failure')
        attempt={'argv':[str(x) for x in argv],'status':'ATTEMPTED','timeout_seconds':timeout}
        ledger['commands'].append(attempt)
        write(evidence/'RUN.json',ledger,emergency=cleanup)
        try:
            r=budget.run(argv,stdin=stdin,env=env,timeout=timeout,cleanup=cleanup)
        except subprocess.TimeoutExpired as exc:
            attempt.update(status='TIMEOUT',stdout=exc.stdout.decode(errors='replace') if isinstance(exc.stdout,bytes) else exc.stdout,
                           stderr=exc.stderr.decode(errors='replace') if isinstance(exc.stderr,bytes) else exc.stderr)
            write(evidence/'RUN.json',ledger,emergency=cleanup)
            raise
        except Exception as exc:
            attempt.update(status='LAUNCH_ERROR',error=str(exc))
            write(evidence/'RUN.json',ledger,emergency=cleanup)
            raise
        attempt.update(status='RETURNED',exit=r.returncode,stdout=r.stdout,stderr=r.stderr)
        write(evidence/'RUN.json',ledger,emergency=cleanup)
        if r.returncode: raise RuntimeError('Native command refused: '+r.stderr[-4000:])
        return r
    psql=[BIN/'psql','-X','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
    start_attempted=False
    pending_case_result=None
    base_oid=None
    base_physical=None
    base_preflight_complete=False
    owned_connections=[]
    try:
        admit('before_cluster',STARTUP_DATA_FREE)
        with budget.bounded('allocate_evidence_reserve',budget.remaining()):
            store.allocate_reserve()
        root=Path(tempfile.mkdtemp(prefix='bbj-funded-',dir=temp_parent))
        data,sock=root/'data',root/'sock'
        os.chmod(root,0o700)
        sock.mkdir(mode=0o700)
        env.update(PGHOST=str(sock),PGPORT='55472',PGUSER='postgres',PGDATABASE='postgres',PGCONNECT_TIMEOUT='5',PGAPPNAME='bbj-ci-'+review['case_attempt_id'],PGTZ='UTC')
        version=command([BIN/'postgres','--version']).stdout
        if not re.search(r'\(PostgreSQL\) 17\.11(?:\s|$)',version): raise RuntimeError('Unpinned PostgreSQL binary')
        command([BIN/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--no-locale'])
        with (data/'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nport=55472\n"+
                    "unix_socket_directories='"+str(sock)+"'\nunix_socket_permissions=0700\n"+
                    "max_connections=12\nshared_buffers='64MB'\nlog_min_error_statement=error\n")
        start_attempted=True
        command([BIN/'pg_ctl','-D',data,'-l',evidence/'postgres.log','-w','start'])
        command(psql+['-c','CREATE DATABASE fixture_base TEMPLATE template0'])
        base_oid=decode_catalog_result(command(psql+['-A','-t','-c',
            "SELECT to_jsonb(oid::text) FROM pg_database WHERE datname='fixture_base'"]).stdout,
            'created_oid',canonical_oid,())
        ledger['fixture_base_oid']=base_oid
        base_physical_raw=json.loads(command(psql+['-d','fixture_base','-A','-t','-c',extension.PHYSICAL_SQL]).stdout)
        base_physical={'database':'fixture_base','database_oid':base_oid,
                       'system_identifier':base_physical_raw['system_identifier'],
                       'data_directory':str(data),'socket_directory':str(sock)}
        extension.validate_physical(base_physical_raw,base_physical)
        runtime_minor=json.loads(command(psql+['-d','fixture_base','-A','-t','-c',
            "SELECT to_jsonb(current_setting('server_version_num')::integer)"]).stdout)
        if runtime_minor != 170011: raise RuntimeError('Actual server must be PostgreSQL17.11')
        ledger['actual_server_version_num']=runtime_minor
        ledger['physical_identity']=base_physical_raw
        def owned_connect(database,label,events,expected):
            return extension.owned_connect(Psql,[str(BIN/'psql'),'-d',database],env,label,events,owned_connections,expected)
        # Current functions precede constraints so their signatures are available
        # to expression planning. Only exact registry configuration is inserted;
        # account and financial seed data remain absent until preflight.
        for name in ('00-roles.sql','10-historical-schema.sql','15-current-prerequisites.sql','30-current-functions.sql',
                     '20-current-schema.sql','40-replay-candidate.sql',
                     '50-current-attachments-acl.sql','registry-overlay.sql','90-historical-event-triggers.sql','bbj_supplemental_callback'):
            admit('before_install:'+name,WORKING_HEADROOM)
            if name=='bbj_supplemental_callback':
                installation=extension.install_supplemental_owned(
                    lambda label,events:owned_connect('fixture_base',label,events,base_physical),
                    review,base_oid,physical=base_physical)
                ledger['bbj_supplemental_install']=installation
                write(evidence/'RUN.json',ledger,emergency=installation['status']=='FAIL')
                if installation['status']!='INSTALLED_OR_EXACT_NOOP':
                    raise RuntimeError('BBJ supplemental install/cleanup failed; full original report retained')
                continue
            install_path=binding.custody.source_path('registry/'+name if name=='registry-overlay.sql' else 'schema/build/'+name)
            command(psql+['-d','fixture_base','-f',install_path],timeout=300)
        preevents=[]
        pre=owned_connect('fixture_base','preflight',preevents,base_physical)
        pre_failed=False
        pf={'passed':False,'events':preevents}
        try:
            boundary=pre.one("SELECT jsonb_build_object('database',current_database(),'database_oid',"
               "(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,"
               "'socket_only',inet_server_addr() IS NULL,'server_version',current_setting('server_version'),"
               "'replication_role',current_setting('session_replication_role'),"
               "'users',(SELECT count(*) FROM auth.users),'clubs',(SELECT count(*) FROM public.clubs),"
               "'legs',(SELECT count(*) FROM public.chip_ledger),'snapshots',(SELECT count(*) FROM public.ca_account_snapshots))")
            if boundary['database_oid']!=base_oid or boundary['database']!='fixture_base' or boundary['role']!='postgres' or not boundary['socket_only'] or boundary['replication_role']!='origin' or any(boundary[x] for x in ('users','clubs','legs','snapshots')):
                raise RuntimeError('Private empty native boundary failed: '+repr(boundary))
            pf=check(pre,json.loads((schema_fixture/'FUNCTION-OVERLAY-INPUTS.json').read_text()),
                     json.loads((schema_fixture/'TABLE-OVERLAY-INPUTS.json').read_text()))
            extra=check_prerequisites(pre,json.loads((schema_fixture/'NAMESPACE-AND-SEQUENCE-INPUTS.json').read_text()))
            identity=check_expression_identity(pre,json.loads((schema_fixture/'CONTEXT-AND-IDENTITY-INPUTS.json').read_text()),
                                              (schema_fixture/'NATIVE-EXPRESSION-IDENTITY-QUERY.sql').read_text())
            pf['expression_identity']=identity
            pf['prerequisites']=extra
            registry=check_registry(pre)
            pf['registry']=registry
            pf['supplemental_functions']=extension.supplemental_preflight(pre)
            pf['backup_supplemental']=extension.backup_preflight(pre,'base_preflight')
            pf['passed']=pf['passed'] and extra['passed'] and identity['passed'] and registry['passed']
            pf['boundary']=boundary
            pf['events']=preevents
            write(evidence/'PREFLIGHT.json',pf)
            assert_complete_preflight(pf,schema_fixture,fixture)
            base_preflight_complete=True
        except Exception as exc:
            pre_failed=True
            pf.update(passed=False,error_type=type(exc).__name__,error=str(exc),events=preevents)
            if hasattr(exc,'backup_metadata_report'):pf['backup_metadata_report']=exc.backup_metadata_report
            write(evidence/'PREFLIGHT-ERROR.json',
                  {'passed':False,'error_type':type(exc).__name__,'error':str(exc),'events':preevents},
                  emergency=True)
            raise
        finally:
            pre_cleanup=extension.cleanup_connection(pre)
            ledger['preflight_connection_cleanup']=pre_cleanup
            pf['events']=preevents
            if any(r['status']=='ERROR' for r in pre_cleanup):
                pf.update(passed=False,cleanup_errors=pre_cleanup)
                write(evidence/'PREFLIGHT.json',pf,emergency=True)
                if not pre_failed:
                    raise RuntimeError('Preflight connection cleanup failed; full report retained')
            else:
                write(evidence/'PREFLIGHT.json',pf,emergency=pre_failed)
        # Retained modeled regressions use fresh validated base responses, never a historical run.
        with budget.bounded('retained_regressions',budget.remaining()):
            regression_report=regression_check(binding,pf['events'])
        write(evidence/'REGRESSIONS.json',regression_report)
        ledger['regressions']=regression_report
        if regression_report.get('passed') is not True: raise RuntimeError('Retained regression stage failed')
        # No case remains as a template for another case. Each starts from the
        # same pristine exact source, and its owned clone is disposed serially.
        def catalog(query,shape,cleanup=False):
            stdout=command(psql+['-A','-t','-c',query],cleanup=cleanup).stdout
            return decode_catalog_result(stdout,shape,canonical_oid,case_names)
        case_names=tuple(case.lower() for case in extension.SELECTED)
        name_list=','.join("'"+n+"'" for n in case_names)
        template_size=catalog("SELECT to_jsonb(pg_database_size('fixture_base'))",'template_size')
        ledger['template_database_bytes']=template_size
        for case in selected:
            db=case.lower()
            remaining=catalog("SELECT COALESCE(jsonb_agg(datname),'[]'::jsonb) FROM pg_database WHERE datname IN ("+name_list+")",'case_names')
            if remaining:
                raise RuntimeError('Prior case database still present: '+repr(remaining))
            admit('before_clone:'+db,3*template_size+WORKING_HEADROOM)
            create_attempted=False
            owned_oid=None
            failure=None
            result=None
            case_connection_start=len(owned_connections)
            try:
                create_attempted=True
                # Actual PostgreSQL FILE_COPY avoids WAL-logging every template
                # block; it changes no table/function/guard or sequence oracle.
                command(psql+['-c',f'CREATE DATABASE {db} TEMPLATE fixture_base STRATEGY FILE_COPY'])
                raw_owned_oid=catalog("SELECT to_jsonb(oid::text) FROM pg_database WHERE datname='"+db+"'",'created_oid')
                owned_oid=canonical_oid(raw_owned_oid)
                admit('before_case:'+db,WORKING_HEADROOM)
                case_physical={**base_physical,'database':db,'database_oid':owned_oid}
                def connect(label,record):
                    return owned_connect(db,case+':'+label,record,case_physical)
                def seed():
                    admit('before_seed:'+db,WORKING_HEADROOM)
                    binding.operation.claim_seed(case)
                    command(psql+['-d',db,'-f',binding.custody.source_path('resources/seed.sql')],timeout=120)
                combined_count=0
                def combined(phase):
                    nonlocal combined_count
                    # Exact original bytes, one -c argument, one real server request.
                    sql=binding.custody.read_bytes(binding.group+'/COMBINED-COMMAND.sql').decode()
                    endpoint_events=[]
                    endpoint=None
                    endpoint_report={'phase':phase,'events':endpoint_events,'status':'ATTEMPTED'}
                    ledger.setdefault('combined_endpoint_checks',[]).append(endpoint_report)
                    write(evidence/'RUN.json',ledger)
                    try:
                        endpoint=connect('combined_endpoint:'+phase,endpoint_events)
                        endpoint_report['identity']=extension.validate_physical(endpoint.one(extension.PHYSICAL_SQL),case_physical)
                        endpoint_report['status']='MATCHED'
                    finally:
                        endpoint_report['cleanup']=extension.cleanup_connection(endpoint)
                        if any(r['status']=='ERROR' for r in endpoint_report['cleanup']):
                            endpoint_report['status']='CLEANUP_FAILED'
                        write(evidence/'RUN.json',ledger,emergency=endpoint_report['status']!='MATCHED')
                    if endpoint_report['status']!='MATCHED':
                        raise RuntimeError('Combined physical endpoint/cleanup not proven')
                    argv=psql+['-q','-A','-t','-d',db,'-c',sql]
                    index=len(ledger['commands'])
                    combined_count+=1
                    try:
                        returned=command(argv,timeout=650)
                        return {'exit':returned.returncode,'stdout':returned.stdout,'stderr':returned.stderr,'command_index':index,'single_request':True}
                    except RuntimeError:
                        attempt=ledger['commands'][index]
                        if attempt.get('status')!='RETURNED' or not isinstance(attempt.get('exit'),int) or attempt['exit']==0:
                            raise
                        return {'exit':attempt['exit'],'stdout':attempt['stdout'],'stderr':attempt['stderr'],'command_index':index,'single_request':True}
                metadata_reports=[]
                def complete_case_metadata(connection):
                    report={'status':'ATTEMPTED'}
                    metadata_reports.append(report)
                    try:
                        extension.validate_physical(connection.one(extension.PHYSICAL_SQL),case_physical)
                        report['original']=extension.complete_original_metadata(connection,preflight,check_registry,schema_fixture,fixture,db,owned_oid)
                        report['opening']=extension.supplemental_preflight(connection)
                        report['complete']=extension.backup_preflight(connection,'case_metadata')
                        report['status']='PASSED'
                        return report['complete']
                    except Exception as exc:
                        report.update(status='FAIL',error=str(exc),error_type=type(exc).__name__)
                        if hasattr(exc,'backup_metadata_report'):report['backup_metadata_report']=exc.backup_metadata_report
                        raise
                # Constructor-issued identity is completed from an actual pristine physical clone.
                clone_events=[]
                clone=None
                clone_report={'status':'ATTEMPTED','events':clone_events}
                ledger['case_clone_admission']=clone_report
                write(evidence/'RUN.json',ledger)
                try:
                    clone=connect('current_clone_admission',clone_events)
                    observed=clone.one(extension.PHYSICAL_SQL)
                    observed['server_version_num']=clone.one("SELECT to_jsonb(current_setting('server_version_num')::integer)")
                    raw=binding.backup.capture(clone)
                    extension.validate_physical(clone.one(extension.PHYSICAL_SQL),case_physical)
                    binding.operation.bind_clone(case,observed,case_physical,extension.validate_physical,raw)
                    clone_report.update(status='PRISTINE_PHYSICAL_CLONE_BOUND',physical=observed,raw=raw)
                finally:
                    clone_report['cleanup']=extension.cleanup_connection(clone)
                    if any(row['status']=='ERROR' for row in clone_report['cleanup']):
                        clone_report['status']='CLEANUP_FAILED'
                    write(evidence/'RUN.json',ledger,emergency=clone_report['status']!='PRISTINE_PHYSICAL_CLONE_BOUND')
                if clone_report['status']!='PRISTINE_PHYSICAL_CLONE_BOUND':
                    raise RuntimeError('Pristine clone admission cleanup unproven')
                try:
                    with budget.bounded('selected_case',budget.remaining()):
                        result=extension.execute_prepared_case(case,connect,seed,driver,review,combined,metadata_check=complete_case_metadata,database=db,database_oid=owned_oid)
                except Exception as exc:
                    # Entry/binding failures normally precede the author try block.
                    # Still run complete metadata postflight and preserve the error.
                    result={'case':case,'status':'FAIL','error_type':type(exc).__name__,'error':str(exc),
                            'completed_subgroups':[],'whole_original_case_qualified':False,
                            'events':[],'observations':[],'root_adapter_entry_failure':True}
                result['root_metadata_reports']=metadata_reports
                result['root_combined_command_count']=combined_count
                if result['status']=='PASS_IMPLEMENTED_SUBSET' and combined_count!=5:
                    result.update(status='FAIL',root_callback_error='Exactly three opening plus two backup actual combined requests required')
                pending_case_result=result
                # Full unchanged metadata postflight runs even after a scenario FAIL,
                # after its connections close and owned injection restore is attempted.
                postevents=[]
                post=None
                postpf={'passed':False,'events':postevents}
                try:
                    post=owned_connect(db,case+':postflight',postevents,case_physical)
                    postboundary=post.one("SELECT jsonb_build_object('database',current_database(),'database_oid',"
                       "(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,"
                       "'socket_only',inet_server_addr() IS NULL,'server_version',current_setting('server_version'),"
                       "'replication_role',current_setting('session_replication_role'),"
                       "'users',(SELECT count(*) FROM auth.users),'clubs',(SELECT count(*) FROM public.clubs),"
                       "'legs',(SELECT count(*) FROM public.chip_ledger),'snapshots',(SELECT count(*) FROM public.ca_account_snapshots))")
                    if postboundary['database_oid']!=owned_oid:
                        raise RuntimeError('Postflight is not on the independently created owned clone')
                    postpf=check(post,json.loads((schema_fixture/'FUNCTION-OVERLAY-INPUTS.json').read_text()),
                                 json.loads((schema_fixture/'TABLE-OVERLAY-INPUTS.json').read_text()))
                    postextra=check_prerequisites(post,json.loads((schema_fixture/'NAMESPACE-AND-SEQUENCE-INPUTS.json').read_text()))
                    postidentity=check_expression_identity(post,json.loads((schema_fixture/'CONTEXT-AND-IDENTITY-INPUTS.json').read_text()),
                                      (schema_fixture/'NATIVE-EXPRESSION-IDENTITY-QUERY.sql').read_text())
                    postregistry=check_registry(post)
                    postpf['supplemental_functions']=extension.supplemental_preflight(post)
                    postpf['backup_supplemental']=extension.backup_preflight(post,'case_postflight')
                    postpf['full_backup_raw']=extension.backup_module().capture(post)
                    if postpf['supplemental_functions'] != pf['supplemental_functions']:
                        raise RuntimeError('Supplemental metadata changed across case')
                    postpf.update(expression_identity=postidentity,prerequisites=postextra,registry=postregistry,boundary=postboundary,events=postevents)
                    postpf['passed']=postpf['passed'] and postextra['passed'] and postidentity['passed'] and postregistry['passed']
                    assert_complete_preflight(postpf,schema_fixture,fixture,expected_database=db,require_empty=False)
                    result.setdefault('completed_subgroups',[]).append('SEQ08-FULL-SELECTED-POSTFLIGHT')
                    result['postflight_summary']={'passed':True,'comparisons':len(postpf['comparisons']),'expression_identities':postidentity['actual_count'],'registry_comparisons':len(postregistry['comparisons']),'temporary_ddl':'none','supplemental_comparisons':len(postpf['supplemental_functions']['comparisons'])}
                except Exception as exc:
                    postpf.update(passed=False,error_type=type(exc).__name__,error=str(exc),events=postevents)
                    if hasattr(exc,'backup_metadata_report'):postpf['backup_metadata_report']=exc.backup_metadata_report
                    if hasattr(exc,'capture_cleanup_errors'):postpf['capture_cleanup_errors']=exc.capture_cleanup_errors
                    result.update(status='FAIL',postflight_error=str(exc))
                finally:
                    post_cleanup=extension.cleanup_connection(post)
                    result['root_postflight_connection_cleanup']=post_cleanup
                    if any(r['status']=='ERROR' for r in post_cleanup):
                        postpf.update(passed=False,cleanup_errors=post_cleanup)
                        result.update(status='FAIL',postflight_cleanup_error='Full cleanup outcomes retained')
                        if 'postflight_summary' in result:result['postflight_summary']['passed']=False
                if postpf.get('passed') is not True:
                    if not store.space_exhausted and not ledger.get('resource_admission_refused'):
                        postpf['independent_failure_postflight']=extension.capture_failed_postflight(
                            connect,case_physical,'case_failure_postflight')
                    else:
                        postpf['independent_failure_postflight']={'status':'NOT_ATTEMPTED_RESOURCE_REFUSAL','passed':False}
                post_path=evidence/(case+'-POSTFLIGHT.json')
                # Preserve the full scenario result before any evidence write can fail.
                pending_case_result=result
                result['postflight_pending']=postpf
                write(post_path,postpf)
                del result['postflight_pending']
                result['postflight_evidence']={'file':post_path.name,'sha256':digest(post_path)}
                pending_case_result=result
                case_path=evidence/(case+'.json')
                ledger['case_evidence_in_progress']=case_path.name
                write(evidence/'RUN.json',ledger)
                write(case_path,result)
                # Full SQL/events remain once in the case file. RUN contains
                # its exact digest and outcome, avoiding repeated large copies.
                ledger['cases'].append({**{k:result[k] for k in
                    ('case','status','error_type','error','whole_original_case_qualified') if k in result},
                    'evidence_file':case_path.name,'sha256':digest(case_path)})
                del ledger['case_evidence_in_progress']
                write(evidence/'RUN.json',ledger)
                pending_case_result=None
            except Exception as exc:
                failure=exc
                ledger['case_setup_or_recording_error']={'case':case,'type':type(exc).__name__,'error':str(exc)}
            # Preserve constructor failures too; always attempt all owned clients before ordinary DROP.
            case_cleanup=extension.cleanup_registry(owned_connections[case_connection_start:])
            ledger.setdefault('owned_connection_cleanup',[]).append({'case':case,'outcomes':case_cleanup})
            if extension.registry_failed(case_cleanup):
                if result is not None:result.update(status='FAIL',root_registry_cleanup_error='Full outcomes retained')
                failure=failure or RuntimeError('Owned connection cleanup/constructor failure')
            if result is not None:
                result['root_registry_cleanup']=case_cleanup
                pending_case_result=result
                try:
                    case_path=evidence/(case+'.json')
                    write(case_path,result,emergency=failure is not None)
                    summary={**{k:result[k] for k in ('case','status','error_type','error','whole_original_case_qualified') if k in result},
                             'evidence_file':case_path.name,'sha256':digest(case_path)}
                    ledger['cases']=[c for c in ledger['cases'] if c['case']!=case]+[summary]
                    pending_case_result=None
                except Exception as exc:
                    failure=failure or exc
            # Driver closes every owned reader/writer connection even on failure.
            # No FORCE/termination of sessions is used to make disposal succeed.
            if create_attempted:
                disposal={'case':case,'database':db,'observed_created_oid':owned_oid}
                ledger['case_database_disposals'].append(disposal)
                try:
                    state=catalog("SELECT jsonb_build_object('oid',(SELECT oid FROM pg_database WHERE datname='"+db+"'),"
                        "'sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname='"+db+"'))",'existing_database',cleanup=True)
                    disposal['before']=state
                    if state['oid'] is not None:
                        actual_oid=require_owned_database_identity(owned_oid,state['oid'],state['sessions'])
                        disposal['normalized_existing_oid']=actual_oid
                        command(psql+['-c',f'DROP DATABASE {db}'],cleanup=True)
                    absent=catalog("SELECT to_jsonb(NOT EXISTS(SELECT FROM pg_database WHERE datname='"+db+"'))",'absence',cleanup=True)
                    if absent is not True:
                        raise RuntimeError('Case database disposal was not proven')
                    disposal.update(status='ABSENT_PROVEN',absent=True)
                    disposal['free_after']=space_probe('after_disposal:'+db,root,evidence,0)
                except Exception as exc:
                    disposal.update(status='DISPOSAL_UNPROVEN',error_type=type(exc).__name__,error=str(exc))
                    if failure is None:
                        failure=exc
            # execute_case intentionally converts financial/seed errors to FAIL;
            # storage refusal must additionally prevent admission of a next case.
            if failure is None and (store.space_exhausted or ledger.get('resource_admission_refused')):
                failure=DiskBudgetError('Storage refusal ended sequence admission after owned disposal')
            write(evidence/'RUN.json',ledger,emergency=failure is not None)
            if failure is not None:
                raise failure
            if result['status']!='PASS_IMPLEMENTED_SUBSET':
                ledger['not_run']=selected[len(ledger['cases']):]
                break
        ledger['status']='PASS_IMPLEMENTED_SUBSETS_ONLY' if len(ledger['cases'])==len(selected) and all(
            c['status']=='PASS_IMPLEMENTED_SUBSET' for c in ledger['cases']) else 'FAIL'
        ledger['remaining_cases']='Only fresh opening100 setup plus selected backup25 or pool-promo25 continuation; original side-filter/subxid and fullSEQ06/08 remain open; no production claim'
        ledger['coverage_contract']='CASE-DISPOSITIONS.json; no whole original case credit'
    except BaseException as e:
        ledger.update(status='SETUP_OR_EXECUTION_FAILURE',error_type=type(e).__name__,error=str(e),
                      financial_outcome='UNQUALIFIED_OR_UNCERTAIN_NO_RETRY')
    finally:
        def finish_postflight():
            # Independently recheck the unchanged base after any admitted case, including a FAIL.
            if base_preflight_complete and not store.space_exhausted and not ledger.get('resource_admission_refused'):
                basepost=None
                baseevents=[]
                base_report={'status':'ATTEMPTED','events':baseevents}
                ledger['base_postflight']=base_report
                try:
                    basepost=owned_connect('fixture_base','base_postflight',baseevents,base_physical)
                    base_report['original']=extension.complete_original_metadata(basepost,preflight,check_registry,schema_fixture,fixture,'fixture_base',base_oid)
                    base_report['opening']=extension.supplemental_preflight(basepost)
                    base_report['backup']=extension.backup_preflight(basepost,'base_postflight')
                    base_report['raw']=extension.backup_module().capture(basepost)
                    original_base=ledger['bbj_supplemental_install']['backup_installation']['raw_after']
                    extension.backup_module().raw_equal(original_base,base_report['raw'])
                    if original_base['sequences']!=base_report['raw']['sequences']:
                        raise RuntimeError('Unchanged fixture_base sequence state differs')
                    if any(base_report['raw']['raw'][name] for name in ('auth.users','public.clubs','public.chip_ledger','public.ca_account_snapshots','public.ca_currency_meter')):
                        raise RuntimeError('Original fixture_base was populated unexpectedly')
                    base_report['status']='PASSED'
                except Exception as exc:
                    base_report.update(status='FAIL',error_type=type(exc).__name__,error=str(exc))
                    if hasattr(exc,'backup_metadata_report'):base_report['backup_metadata_report']=exc.backup_metadata_report
                    ledger['execution_status_before_base_postflight']=ledger.get('status')
                    ledger['status']='BASE_POSTFLIGHT_FAILED'
                finally:
                    base_report['cleanup']=extension.cleanup_connection(basepost)
                    if any(r['status']=='ERROR' for r in base_report['cleanup']):
                        base_report['status']='FAIL'
                        ledger['execution_status_before_base_cleanup']=ledger.get('status')
                        ledger['status']='BASE_POSTFLIGHT_CLEANUP_FAILED'
                if base_report['status']!='PASSED':
                    base_report['independent_failure_postflight']=extension.capture_failed_postflight(
                        lambda label,events:owned_connect('fixture_base',label,events,base_physical),
                        base_physical,'base_failure_postflight')
            elif base_preflight_complete:
                ledger['base_postflight']={'status':'NOT_ATTEMPTED_RESOURCE_REFUSAL','passed':False,
                                          'reason':'Existing evidence/storage admission forbids further non-cleanup work'}
                ledger['execution_status_before_base_postflight']=ledger.get('status')
                ledger['status']='BASE_POSTFLIGHT_UNQUALIFIED_RESOURCE_REFUSAL'
        def finish_clients():
            final_clients=extension.cleanup_registry(owned_connections)
            ledger['all_owned_connection_cleanup']=final_clients
            if extension.registry_failed(final_clients):
                ledger['execution_status_before_client_cleanup']=ledger.get('status')
                ledger['status']='OWNED_CLIENT_CLEANUP_FAILED'
        def finish_helpers():
            ledger['owned_helper_cleanup']=budget.reap_all()
            if any(row['exit'] is None for row in ledger['owned_helper_cleanup']):
                ledger['status']='OWNED_HELPER_EXIT_UNPROVEN'
        def finish_physical():
            # Stop only the freshly-created owned cluster. Preserve any directory
            # whose shutdown cannot be proven; never delete unrelated task state.
            def cleanup_probe(argv):
                try:
                    return budget.run(argv,env=env,timeout=30,cleanup=True)
                except BaseException as exc:
                    retain_teardown_failure(ledger,budget,'physical_probe',exc)
                    return SimpleNamespace(returncode=None,stdout='',stderr=str(exc))
            if root is None:
                ledger['cleanup']={'owned_directory':None,'cluster_directory_created':False,
                                   'inactive_proven':True,'owned_directory_removed':True}
            else:
                stop=cleanup_probe([str(BIN/'pg_ctl'),'-D',str(data),'-m','immediate','-w','stop']) if start_attempted else None
                status=cleanup_probe([str(BIN/'pg_ctl'),'-D',str(data),'status']) if data.exists() else None
                processes=cleanup_probe(['/bin/ps','-axo','pid=,command='])
                owned_processes=[line.strip() for line in processes.stdout.splitlines() if str(data) in line or str(sock) in line]
                socket_paths=[str(p) for p in sock.glob('.s.PGSQL.*')]
                inactive=(status is None and not data.exists() or status is not None and status.returncode==3) and not (data/'postmaster.pid').exists() and processes.returncode==0 and not owned_processes and not socket_paths
                ledger['cleanup']={'owned_directory':str(root),'stop_exit':stop.returncode if stop else None,
                                   'status_exit':status.returncode if status else None,'postmaster_pid_present':(data/'postmaster.pid').exists(),
                                   'stop_stdout':stop.stdout if stop else None,'stop_stderr':stop.stderr if stop else None,
                                   'status_stdout':status.stdout if status else None,'status_stderr':status.stderr if status else None,
                                   'process_scan_exit':processes.returncode,'owned_processes':owned_processes,'socket_paths':socket_paths,
                                   'inactive_proven':inactive}
                if inactive:
                    try:
                        with budget.bounded('owned_directory_removal',budget.remaining(True),True):
                            shutil.rmtree(root)
                        ledger['cleanup']['owned_directory_removed']=not root.exists()
                    except Exception as exc:
                        ledger['cleanup']['owned_directory_removed']=False
                        ledger['cleanup']['removal_error']=str(exc)
                        ledger['execution_status_before_cleanup']=ledger.get('status')
                        ledger['status']='CLEANUP_DIRECTORY_REMOVAL_FAILED'
                else:
                    ledger['execution_status_before_cleanup']=ledger.get('status')
                    ledger['status']='CLEANUP_UNPROVEN_DIRECTORY_PRESERVED'
        def finish_reserve():
            # Only the run's own expendable reserve is removed; evidence is retained.
            try:
                with budget.bounded('release_evidence_reserve',budget.remaining(True),True):
                    store.release_reserve()
            except Exception as exc:
                ledger['reserve_release_error']=str(exc)
                ledger['execution_status_before_reserve_cleanup']=ledger.get('status')
                ledger['status']='EVIDENCE_RESERVE_CLEANUP_FAILED'
        def finish_evidence():
            nonlocal pending_case_result
            try:
                if pending_case_result is not None:
                    # A returned result can outlive two failed evidence writes.
                    # Retry it after native cleanup before the final compact RUN.
                    case_path=evidence/(pending_case_result['case']+'.json')
                    write(case_path,pending_case_result,emergency=True)
                    summary={**{k:pending_case_result[k] for k in
                        ('case','status','error_type','error','whole_original_case_qualified') if k in pending_case_result},
                        'evidence_file':case_path.name,'sha256':digest(case_path)}
                    ledger['cases']=[c for c in ledger['cases'] if c['case']!=pending_case_result['case']]+[summary]
                    ledger.pop('case_evidence_in_progress',None)
                write(evidence/'RUN.json',ledger,emergency=True)
                pending_case_result=None
            except Exception as exc:
                ledger['final_evidence_write_error']=str(exc)
                ledger['status']='FINAL_EVIDENCE_WRITE_FAILED'
                print(json.dumps({'emergency_run_evidence':ledger,
                                  'pending_full_case_result':pending_case_result},default=str))
        finish_owned_teardown(ledger,budget,postflight=finish_postflight,clients=finish_clients,
                              helpers=finish_helpers,physical=finish_physical,
                              release=finish_reserve,evidence=finish_evidence)
    ledger['deadline']=budget.report()
    if budget.execution_refused or budget.remaining(True)<=0:
        ledger['status']='DEADLINE_FAILED_OUTCOME_UNCERTAIN'
    try:
        write(evidence/'RUN.json',ledger,emergency=True)
    except BaseException as error:
        retain_teardown_failure(ledger,budget,'final_deadline_evidence',error)
        print(json.dumps({'emergency_run_evidence':ledger,
                          'pending_full_case_result':pending_case_result},default=str))
    print(json.dumps({'evidence':str(evidence),'status':ledger['status'],'cleanup':ledger['cleanup']}))
    return 0 if ledger.get('status')=='PASS_IMPLEMENTED_SUBSETS_ONLY' and ledger['cleanup']['inactive_proven'] else 1
