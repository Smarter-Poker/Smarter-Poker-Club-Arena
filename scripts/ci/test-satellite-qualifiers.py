"""Qualify the actual multi-qualifier satellite transaction in owned PG17.

Reuse the existing accounting Execution owner and canonical catalog. No remote
connection argument, existing database, package install or production effect.
"""
from pathlib import Path
import argparse
import datetime
import importlib.util
import json
import re
import signal
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
from satellite_qualifier_fixture import compose, module, sha, function_sql
from satellite_qualifier_concurrency import qualify as qualify_concurrency, qualify_readers

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if sha(Path(__file__)) != sha(root/'scripts/ci/test-satellite-qualifiers.py'):
        raise ValueError('executed satellite caller differs from recorded source')
    output = args.evidence.resolve()
    output.mkdir(parents=True, exist_ok=False)
    native = module(root/'scripts/ci/test-mtt-unlimited.py', 'satellite_existing_execution')
    manifest = compose(root)
    (output/'foundation.sql').write_text(manifest.pop('sql'))
    (output/'entry-close-dependencies.sql').write_text(manifest.pop('entry_sql'))
    qualifier_probe=root/'scripts/ci/probes/satellite-qualifiers-native.sql'
    manifest['source_sha256'][str(qualifier_probe.relative_to(root))] = sha(qualifier_probe)
    prep=root/'supabase/migrations'
    # Validate and install the same eight prepared authorities as production.
    # Their existing probes/races are source-bound, not rerun in this L04 task.
    catalog = native.preparation_inputs(SimpleNamespace(root=root, report=manifest))
    authoring = module(root/'scripts/ci/mtt_break_authoring_native.py', 'satellite_authoring_dependencies')
    _, _, authoring_hashes = authoring.authoring_inputs(root)
    manifest['source_sha256'].update(authoring_hashes)
    migrations = [root/stage['migration']['path'] for stage in catalog['stages']]
    migrations += [root/authoring.MIGRATION,
                   root/'supabase/migrations/20260917201651_satellite_multi_qualifier_receipt_v3.sql']
    # The financial catalog already loaded the exact CURRENT satellite core
    # and both wallet/treasury registry rows. Verify those existing identities;
    # never reinstall the historical predecessor or duplicate their seed.
    supplements = []
    for fixture in catalog['fixtures']:
        if fixture['kind'] == 'function-successor':
            supplements.append({**fixture, 'kind':'functions', 'presence':'exact'})
        elif fixture['kind'] == 'registry':
            captured=json.loads((root/fixture['path']).read_text())['rows']
            if len(captured)!=1 or captured[0]['row']['store']!='club_treasury':
                raise ValueError('exact overlapping treasury capture required')
            expected=json.dumps(captured[0]['row']).replace("'", "''")
            registry_sql="DO $exact_existing$ BEGIN IF (SELECT to_jsonb(c) FROM public.ca_chip_store_coverage c WHERE store='club_treasury') IS DISTINCT FROM '"+expected+"'::jsonb THEN RAISE EXCEPTION 'satellite prepared registry differs'; END IF; END $exact_existing$;"
        else:
            supplements.append(fixture)
    supplement = native.preparation_supplement_sql(root, supplements)
    (output/'full-preparation-supplement.sql').write_text(supplement+'\n'+registry_sql+'\n')

    manifest['source_sha256'].update({str(p.relative_to(root)):sha(p) for p in migrations})
    guard_path=root/'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json'
    if sha(guard_path)!='8884f9471acd933072afc05ef3f2427cc63a28de9744785d1bc10611f730ef5b':
        raise ValueError('captured production money-DDL guard differs')
    guard=json.loads(guard_path.read_text())
    expected_guard={'name':'ab_ca_money_rpc_registered','tags':['CREATE FUNCTION'],
                    'event':'ddl_command_end','owner':'postgres','enabled':'O',
                    'function':'fn_ca_money_rpc_registry_guard()'}
    if guard['event_triggers']!=[expected_guard]:
        raise ValueError('captured production money-DDL event differs')
    manifest['source_sha256'][str(guard_path.relative_to(root))]=sha(guard_path)
    source = root/'scripts/ci/probes/satellite-full-terminal-native.sql'
    opening = root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql'
    probe = 'BEGIN;\n' + source.read_text()
    # The older synthetic final-table scene predates the two persisted seat
    # identity keys. Supply the same actual keys as the retained funded bounty
    # opening, without disabling a check or changing any business call.
    replacements = [
        ('game_type,club_id)\n VALUES', 'game_type,club_id,seat_game_scope,seat_admission_key)\n VALUES'),
        ("'d2000000-0000-4000-8000-000000000002');\nUPDATE public.tournament_players SET status='playing'", "'d2000000-0000-4000-8000-000000000002','table:d5000000-0000-4000-8000-000000000001','tournament:d3000000-0000-4000-8000-000000000001');\nUPDATE public.tournament_players SET status='playing'"),
        ('leave_pending,is_sitting_out,is_away,club_id)\n VALUES', 'leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key)\n VALUES'),
        ("'d2000000-0000-4000-8000-000000000002');\nSET LOCAL session_replication_role=origin;\nSELECT set_config('request.jwt.claims'", "'d2000000-0000-4000-8000-000000000002','table:d5000000-0000-4000-8000-000000000001','tournament:d3000000-0000-4000-8000-000000000001');\nSET LOCAL session_replication_role=origin;\nSELECT set_config('request.jwt.claims'")]
    for old,new in replacements:
        if probe.count(old)!=1:
            raise ValueError('exact synthetic scene seam changed')
        probe=probe.replace(old,new,1)
    # This is the captured production contract, not the separately proposed
    # Stage-B activation. All seven Stage-B triggers are currently disabled;
    # the installed public RPC does not mint the proposed seat capability.
    # Retain explicit assertions for those facts and every financial oracle.
    current_only = [
        ("tgrelid='public.tournaments'::regclass AND tgenabled='O'", "tgrelid='public.tournaments'::regclass AND tgenabled='D'"),
        ("'all seven Stage B guards are enabled'", "'all seven Stage B guards match the captured disabled production state'"),
        ("count(*)=1 FROM satellite_full_authority_events WHERE action='INSERT'", "count(*)=0 FROM satellite_full_authority_events WHERE action='INSERT'"),
        ("count(*)=1 FROM satellite_full_authority_events WHERE action='DELETE'", "count(*)=0 FROM satellite_full_authority_events WHERE action='DELETE'"),
        ("'public satellite RPC mints and consumes the exact sole live seat capability'", "'current public satellite RPC does not fabricate uninstalled Stage-B seat capabilities'")]
    for old,new in current_only:
        if probe.count(old)!=1:
            raise ValueError('current-contract assertion seam changed')
        probe=probe.replace(old,new,1)
    if len(re.findall(r'^BEGIN;$', probe,re.M)) != 1 or len(re.findall(r'^ROLLBACK;$',probe,re.M)) != 1 or re.search(r'^COMMIT;$',probe,re.M):
        raise ValueError('native satellite control must roll back once')
    probe = probe.replace('ROLLBACK;', "SELECT 'L04_CURRENT_V2_PRESERVATION_PASS';\nROLLBACK;", 1)
    (output/'probe.sql').write_text(probe)
    manifest['source_sha256'].update({str(p.relative_to(root)):sha(p) for p in [source,opening,root/'scripts/ci/test-satellite-qualifiers.py',root/'scripts/ci/test-mtt-unlimited.py',root/'scripts/ci/mtt_isolation_results.py',root/'scripts/ci/mtt_format_qualification.py',root/'scripts/ci/satellite_qualifier_concurrency.py',root/'scripts/ci/probes/satellite-qualifier-finish.spec',root/'scripts/ci/probes/satellite-qualifier-reader.spec']})
    # Imported by the current Execution owner; its separate qualification is
    # not invoked here. Still bind the code actually loaded by that owner.
    imported_owner_dependency=root/'scripts/ci/mtt_historical_freebuy_proof.py'
    manifest['source_sha256'][str(imported_owner_dependency.relative_to(root))]=sha(imported_owner_dependency)
    (output/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    for sig in native.CANCELLATION_SIGNALS:
        signal.signal(sig,native.interrupted)
    e = native.Execution(root,output,args.pg_bin.resolve(),output,600)
    e.report.update(fixture_identity='L04-v3-full-installed-preparation-and-L03',source_sha256=manifest['source_sha256'],historical_full_stage1=False,cohort_implemented=True)
    try:
        e.start()
        db = e.database()
        e.sql(db,file=output/'foundation.sql',label='captured-current-satellite-foundation',seconds=180)
        e.sql(db,file=output/'entry-close-dependencies.sql',label='captured-current-entry-close-dependencies',seconds=60)
        existing=e.catalog_snapshot(db,'financial-authorities-before-supplement')
        e.sql(db,file=output/'full-preparation-supplement.sql',label='full-preparation-captured-dependencies',seconds=180)
        authoring._preserved_catalog(e,db,existing)
        for migration in migrations[:-2]:
            e.sql(db,file=migration,label=migration.stem,seconds=60)
        # Same absent-only L03 dependencies as its maintained qualified caller.
        # The prepared scope helper already exists and must be byte-exact.
        authoring._assert_scope(e,db,root)
        supplement=(root/authoring.FIXTURE/'catalog-supplement.sql').read_text()
        marker="DO $$ BEGIN IF to_regprocedure('public.fn_club_scope_ids(uuid)') IS NOT NULL"
        if supplement.count(marker)!=1 or not supplement.endswith('COMMIT;\n'):
            raise ValueError('source-bound authoring scope boundary changed')
        supplement=supplement.partition(marker)[0]+'COMMIT;\n'
        existing=e.catalog_snapshot(db,'prepared-authorities-before-authoring-dependencies')
        e.sql(db,supplement,label='current-authoring-captured-dependencies',seconds=60)
        authoring._preserved_catalog(e,db,existing)
        authoring._assert_capture(e,db,root)
        e.sql(db,file=migrations[-2],label=migrations[-2].stem,seconds=60)
        _,abi,_=e.sql(db,"SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton;",label='installed-preparation-remains-legacy')
        if abi.strip()!='legacy-capacity-v1':
            raise RuntimeError('financial qualification must not activate entry admission')
        e.report['prepared_authority_composition']={'stages':[stage['id'] for stage in catalog['stages']],
            'l03_migration':str(migrations[-2].relative_to(root)), 'abi_before_cases':abi.strip(),
            'existing_authorities_preserved':True, 'activation_qualified':False}
        # The captured financial catalog includes the real money registry but
        # omitted its DDL event trigger. Install the exact current guard so this
        # qualification exercises the same admission as production deployment.
        for row in guard['functions']:
            e.sql(db,"DO $$ BEGIN IF to_regprocedure('public."+row['signature']+"') IS NOT NULL THEN RAISE EXCEPTION 'money-DDL guard must be absent before supplement'; END IF; END $$;\n"+function_sql(row),label='money-ddl-'+row['signature'].split('(')[0])
        e.sql(db,"CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();",label='current-money-ddl-event')
        # Retain the exact failed production shape as a negative control. It
        # must refuse and roll back every row and catalog edit in the migration.
        unregistered=e.database(db)
        rows=e.snapshot(unregistered,'unregistered-before-data')
        before_guard_catalog=e.catalog_snapshot(unregistered,'unregistered-before-catalog')
        candidate=migrations[-1].read_text()
        registry=re.compile(r"INSERT INTO public\.ca_money_rpc_registry\(proname,status,notes\)\nVALUES \('fn_ca_settle_satellite_cohort','approved',\n '[^']*'\);\n")
        if len(registry.findall(candidate))!=1:
            raise ValueError('exact cohort writer registration missing')
        code,out,err=e.sql(unregistered,registry.sub('',candidate),label='refuse-unregistered-cohort-writer',seconds=60,check=False)
        errors=[x.split('ERROR:',1)[1].strip() for x in err.splitlines() if 'ERROR:' in x]
        if code!=3 or errors!=['REFUSED: fn_ca_settle_satellite_cohort writes balance columns and is not in ca_money_rpc_registry']:
            raise RuntimeError('production money-DDL refusal was not reproduced')
        if rows!=e.snapshot(unregistered,'unregistered-after-data') or before_guard_catalog!=e.catalog_snapshot(unregistered,'unregistered-after-catalog'):
            raise RuntimeError('unregistered cohort refusal left partial state')
        e.discard(unregistered)
        e.report['migration_refusals'].append({'kind':'unregistered_cohort_writer','exact_refusal':True,'catalog_and_data_rollback':True,'database_removed':True})
        for kind,mutation in [
          ('ranker_body',"DO $drift$ DECLARE d text; b text; BEGIN SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc WHERE oid='public.fn_rank_survivors(uuid)'::regprocedure; EXECUTE replace(d,b,E'-- isolated drift\\n'||b); END $drift$;"),
          ('ranker_acl','REVOKE EXECUTE ON FUNCTION public.fn_rank_survivors(uuid) FROM service_role;'),
          ('ranker_trigger','ALTER TABLE public.tournaments DISABLE TRIGGER tournaments_rank_before_complete;')]:
            altered=e.database(db)
            e.sql(altered,mutation,label='inject-'+kind)
            rows=e.snapshot(altered,'before-'+kind+'-data');catalog=e.catalog_snapshot(altered,'before-'+kind+'-catalog')
            code,out,err=e.sql(altered,file=migrations[-1],label='reject-'+kind,seconds=60,check=False)
            errors=[x.split('ERROR:',1)[1].strip() for x in err.splitlines() if 'ERROR:' in x]
            if code!=3 or errors!=['satellite cohort predecessor differs']:
                raise RuntimeError('cohort migration did not reject exact '+kind)
            if rows!=e.snapshot(altered,'after-'+kind+'-data') or catalog!=e.catalog_snapshot(altered,'after-'+kind+'-catalog'):
                raise RuntimeError('refused cohort migration left partial '+kind)
            e.discard(altered)
            e.report['migration_refusals'].append({'kind':kind,'exact_refusal':True,'catalog_and_data_rollback':True,'database_removed':True})
        e.sql(db,file=migrations[-1],label=migrations[-1].stem,seconds=60)
        e.sql(db,file=opening,label='synthetic-structural-opening',seconds=60)
        before=e.snapshot(db,'before-data')
        before_catalog=e.catalog_snapshot(db,'before-catalog')
        code,out,err=e.sql(db,file=output/'probe.sql',label='actual-funded-v2-control',seconds=180,check=False)
        after=e.snapshot(db,'after-data')
        after_catalog=e.catalog_snapshot(db,'after-catalog')
        e.report.update(sql_exit_code=code,data_rollback=before==after,catalog_rollback=before_catalog==after_catalog)
        (output/'case-output.txt').write_text(out)
        (output/'case-errors.txt').write_text(err)
        if code or any(s in err for s in ['ERROR:','FATAL:','PANIC:','WARNING:']):
            raise RuntimeError('current satellite control refused; inspect the original error')
        if before!=after or before_catalog!=after_catalog:
            raise RuntimeError('current satellite case changed durable fixture state')
        receipt=[x.split('=',1)[1] for x in out.splitlines() if x.startswith('SATELLITE_FULL_NATIVE_EVIDENCE=')]
        if len(receipt)!=1 or out.splitlines().count('L04_CURRENT_V2_PRESERVATION_PASS')!=1:
            raise RuntimeError('current satellite control final evidence missing')
        e.report['native_evidence']=json.loads(receipt[0])
        if len(re.findall('NOTICE:  PASS ',err)) != 20:
            raise RuntimeError('exact legacy preservation assertion count differs')
        code,out,err=e.sql(db,file=qualifier_probe,label='actual-funded-v3-cohort',seconds=180,check=False)
        after=e.snapshot(db,'cohort-after-data')
        after_catalog=e.catalog_snapshot(db,'cohort-after-catalog')
        e.report.update(cohort_sql_exit_code=code,cohort_data_rollback=before==after,cohort_catalog_rollback=before_catalog==after_catalog)
        (output/'cohort-output.txt').write_text(out)
        (output/'cohort-errors.txt').write_text(err)
        if code or any(s in err for s in ['ERROR:','FATAL:','PANIC:','WARNING:']):
            raise RuntimeError('cohort satellite control refused; inspect the original error')
        if before!=after or before_catalog!=after_catalog:
            raise RuntimeError('cohort satellite case changed durable fixture state')
        receipt=[x.split('=',1)[1] for x in out.splitlines() if x.startswith('SATELLITE_QUALIFIER_NATIVE_EVIDENCE=')]
        if len(receipt)!=1 or out.splitlines().count('SATELLITE_QUALIFIERS_NATIVE_PASS')!=1:
            raise RuntimeError('cohort satellite final evidence missing')
        e.report['cohort_native_evidence']=json.loads(receipt[0])
        e.report['cohort_assertions']=len(re.findall('NOTICE:  QUALIFIER PASS:',err))
        if e.report['cohort_assertions'] != 67:
            raise RuntimeError('exact cohort assertion count differs')
        qualify_concurrency(e,root,native,db,output,qualifier_probe)
        qualify_readers(e,root,native,db,output,qualifier_probe)
        for path,digest in manifest['source_sha256'].items():
            if sha(root/path)!=digest:
                raise RuntimeError('input changed during execution: '+path)
        e.report['status']='passed'
        e.report['failure']=None
        e.discard(db)
    except BaseException as exc:
        e.report['failure']=repr(exc)
    finally:
        for sig in native.CANCELLATION_SIGNALS:
            signal.signal(sig,signal.SIG_IGN)
        try:
            e.close()
        except BaseException as exc:
            e.report['cleanup_failure']=repr(exc)
            e.report['status']='failed'
        e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output/'result.json').write_text(json.dumps(e.report,indent=2)+'\n')
        print(json.dumps({k:e.report.get(k) for k in ['status','failure','sql_exit_code','data_rollback','catalog_rollback','cleanup']}),flush=True)
    return 0 if e.report['status']=='passed' else 1

if __name__=='__main__':
    sys.exit(main())
