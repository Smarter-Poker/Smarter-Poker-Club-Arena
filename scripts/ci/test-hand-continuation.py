#!/usr/bin/env python3
"""Private original-hand continuation on the maintained local PG17 financial/F06 closure.

No DSN or production connection is accepted. The cluster uses private Unix
sockets only and is stopped/removed in finally. Live activation is separate.
"""
import argparse, datetime, hashlib, json, re, signal, sys
from collections import Counter
from pathlib import Path
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, sha

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = Path('supabase/migrations/20261028233353_durable_private_hand_continuation.sql')
PROBE = Path('scripts/ci/probes/hand-continuation-native.sql')
ADMISSION = Path('supabase/migrations/20261029063137_hand_continuation_waits_for_maintenance_admission.sql')
DATA = Path('scripts/ci/fixtures/hand-continuation')


def qualify_installation(e, hand, db):
    cases = [
        ('snapshot-trigger', "ALTER TABLE public.hand_state_snapshots DISABLE TRIGGER hand_submission_snapshot_guard;"),
        ('permit-trigger', "ALTER TABLE smarter_private.f06_hand_permits DISABLE TRIGGER f06_retained_submission_guard;"),
        ('retention-body', "ALTER FUNCTION public.fn_ca_retain_hand_submission(jsonb) SET search_path=pg_catalog;"),
        ('retention-acl', "GRANT EXECUTE ON FUNCTION public.fn_ca_retain_hand_submission(jsonb) TO anon;"),
        ('resume-acl', "GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO anon;"),
        ('snapshot-body', "ALTER FUNCTION smarter_private.hand_submission_snapshot_guard() SET search_path=public;"),
        ('permit-acl', "GRANT EXECUTE ON FUNCTION smarter_private.f06_retained_submission_guard() TO service_role;"),
    ]
    for label, mutation in cases:
        case = e.database(db)
        e.sql(case, mutation, label='drift-' + label)
        before = (e.snapshot(case, label+'-data-before'), e.catalog_snapshot(case, label+'-catalog-before'), hand.private_snapshot(e, case, label+'-private-before'))
        code, _, error = e.sql(case, file=ROOT/MIGRATION, label='refuse-'+label, check=False)
        if not code or 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED' not in error:
            raise RuntimeError('installation drift not refused: '+label)
        after = (e.snapshot(case, label+'-data-after'), e.catalog_snapshot(case, label+'-catalog-after'), hand.private_snapshot(e, case, label+'-private-after'))
        if before != after:
            raise RuntimeError('installation drift refusal changed state: '+label)
        e.discard(case)
        e.report['installation_refusals'].append({'case':label, 'complete_rollback':True})


def qualify_fences(e, db, native):
    binary = native.stock_isolationtester(e.pg)
    e.report['isolationtester'] = {'path':str(binary), 'sha256':sha(binary)}
    probe = (ROOT/PROBE).read_text()
    prefix = probe[:probe.index('DO $boundaries$')]
    seed = ('BEGIN; CREATE SCHEMA continuation_native;\n'+(e.output/'opening.sql').read_text()+prefix+'COMMIT;').replace('pg_temp.', 'continuation_native.')
    spec = (ROOT/DATA/'disposition.spec').read_text()
    retain = 'PERFORM continuation_native.retain_continuation(0);'
    close = "PERFORM smarter_private.assert_hand_continuation_disposition('86100000-0000-0000-0000-000000000001',8600001);"
    abort = "UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=permit_id WHERE permit_id='86600000-0000-0000-0000-000000000001';"
    for operation in ('snapshot-disposition-fence', 'permit'):
        for first in ('retention', 'disposition'):
            for finish in ('COMMIT', 'ROLLBACK'):
                for isolation in ('READ COMMITTED', 'REPEATABLE READ'):
                    label='fence-'+operation+'-'+first+'-'+finish.lower()+'-'+isolation.lower().replace(' ','-')
                    case=e.database(db); e.sql(case,seed,label=label+'-opening')
                    disposal=close if operation=='snapshot-disposition-fence' else abort
                    a,b=(retain,disposal) if first=='retention' else (disposal,retain)
                    failure='NULL' if finish=='ROLLBACK' else "'40001'" if isolation=='REPEATABLE READ' else "'55000'"
                    winner=first if finish=='COMMIT' else ('disposition' if first=='retention' else 'retention')
                    rendered=spec.replace('A_OPERATION','DO $$ BEGIN '+a+' END $$;').replace('B_OPERATION',b).replace('A_FINISH',finish).replace('ISOLATION_KIND',isolation).replace('EXPECTED_FAILURE',failure).replace('FINAL_DISPOSITION',"'retained'" if winner=='retention' else "'disposed'").replace('FINAL_SUBMISSIONS','1' if winner=='retention' else '0')
                    code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=25,check=False)
                    expected=Counter({'a_begin':1,'b_begin':1,'b_snapshot':1,'a_write':1,'b_write':2,'observed_wait':1,'a_finish':1,'b_commit':1,'final_state':1})
                    steps=Counter(re.findall(r'^step ([a-z_]+):',out,re.M))
                    notices=re.findall(r'NOTICE:\s*(SUBMISSION_RACE_[A-Z_]+)',out+'\n'+err)
                    if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or steps!=expected or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1 or notices!=['SUBMISSION_RACE_WAIT_PROVEN','SUBMISSION_RACE_OUTCOME_PROVEN','SUBMISSION_RACE_FINAL_PROVEN']:
                        raise RuntimeError('exact continuation disposition race failed: '+label)
                    e.discard(case)
                    e.report['races'].append({'case':label,'observed_wait':True,'exact_outcome':True,'database_removed':True})



def qualify_admission(e, db, native, before=False):
    """Two real backend connections prove gate ordering, not synthetic waits."""
    binary = native.stock_isolationtester(e.pg)
    probe = (ROOT/PROBE).read_text()
    prefix = probe[:probe.index('DO $boundaries$')]
    seed = ('BEGIN; CREATE SCHEMA continuation_native;\n'+(e.output/'opening.sql').read_text()+prefix+'COMMIT;').replace('pg_temp.', 'continuation_native.')
    template = (ROOT/DATA/'admission.spec').read_text()
    retain = 'PERFORM continuation_native.retain_continuation(0);'
    claim = "PERFORM public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000001','86100000-0000-0000-0000-000000000001');"
    # Invalid input still must reach its existing validation AFTER admission.
    legacy = "PERFORM public.fn_f06_claim_legacy_river_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000001','86100000-0000-0000-0000-000000000001',8600001,clock_timestamp(),NULL,NULL);"
    cases = [('retain',retain,None,1),('claim',claim,None,0),('legacy-validation',legacy,'22023',0)]
    if not before:
        cases += [('short-timeout',retain,'55P03',0),('capped-timeout',retain,'55P03',0),
          ('freeze',retain,'P0001',0),('authority',retain,'42501',0)]
    for label,operation,failure,count in cases:
        case=e.database(db); e.sql(case,seed,label='admission-'+label+'-opening')
        timed = 'timeout' in label
        timeout = '200ms' if label=='short-timeout' else '0' if label=='capped-timeout' else '7s'
        change = "SELECT 1;"
        if label=='freeze':
            change = "INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');"
        if label=='authority':
            change = "UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002' WHERE tournament_id='86000000-0000-0000-0000-000000000001';"
        if before: failure='55P03';count=0
        permutation = '"hold" "change" "retain" "wait" '+ ('"outwait" ' if timed else '')+'"release" "final"'
        replacements = {'HOLDER_CHANGE':change,'CALLER_TIMEOUT':timeout,'ORIGINAL_OPERATION':operation,
          'EXPECTED_FAILURE':"'"+failure+"'" if failure else 'NULL','EXPECT_WAIT':'false' if before else 'true',
          'FINAL_COUNT':str(count),'HOLD_SECONDS':'5.2' if label=='capped-timeout' else '0.3','PERMUTATION':permutation}
        rendered=template if timed else re.sub(r'step "outwait" \{[^}]*\}\n', '', template)
        for key,value in replacements.items(): rendered=rendered.replace(key,value)
        name=('before-' if before else 'after-')+'admission-'+label
        code,out,err=e.run(name,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=15,check=False)
        notices=re.findall(r'NOTICE:\s*(ADMISSION_[A-Z_]+)',out+'\n'+err)
        if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or sorted(notices)!=sorted(['ADMISSION_OUTCOME_PROVEN','ADMISSION_WAIT_PROVEN','ADMISSION_FINAL_PROVEN']) or out.count('<waiting ...>') != (0 if before else 1):
            raise RuntimeError('exact continuation admission race failed: '+name)
        e.discard(case)
        e.report.setdefault('admission',[]).append({'case':name,'observed_wait':not before,'no_early_write':True,'exact_outcome':True,'database_removed':True})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('--pg-bin',type=Path,required=True)
    parser.add_argument('--socket-root',type=Path,required=True)
    parser.add_argument('--work-root',type=Path)

    args=parser.parse_args(); out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
    hand=module(ROOT/'scripts/ci/test-hand-submission.py','continuation_hand_foundation')
    manifest=hand.prepare(ROOT,out)
    chain=module(ROOT/'scripts/ci/test-accepted-hand-roster.py','continuation_current_chain')
    native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','continuation_native_owner')
    args.socket_root.mkdir(parents=True,exist_ok=True)
    if sys.platform == 'darwin' and args.work_root is None:
        parser.error('--work-root on the external work SSD is required on the owner Mac')
    work=args.work_root.resolve() if args.work_root is not None else out
    work.mkdir(parents=True,exist_ok=True)
    e=native.Execution(ROOT,out,args.pg_bin.resolve(),work,600,socket_parent=args.socket_root)
    inputs=[MIGRATION,ADMISSION,PROBE,Path(__file__).relative_to(ROOT),Path('scripts/ci/played_clock_floor_cases.py'),Path('scripts/ci/build-played-level-recovery-migration.py'),Path('supabase/migrations/20261029004521_keep_generation_recovery_at_the_highest_genuinely_played_lev.sql'),Path('supabase/migrations/20260918232558_mixed_f06_custody_transfer_retains_original_operations.sql')]+sorted(p.relative_to(ROOT) for p in (ROOT/DATA).rglob('*') if p.is_file())
    inputs += [Path('scripts/ci/test-accepted-hand-roster.py'),chain.LIGHTNING,chain.RETIRED_CASH,chain.RAKED_DIAMOND,chain.CAPTURE,chain.MIGRATION]
    inputs += sorted(p.relative_to(ROOT) for p in (ROOT/'scripts/ci/fixtures/played-clock-floor').rglob('*') if p.is_file())
    source=dict(manifest['source_sha256']);source.update({str(p):sha(ROOT/p) for p in inputs})
    e.report.update(source_sha256=source,installation_refusals=[],races=[],scope='private original continuation on exact production-captured atomic/stack/retention functions and maintained real financial/F06 closure; not live activation')
    for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
    try:
        e.start();db=e.database()
        e.sql(db,file=out/'foundation.sql',label='actual-financial-foundation',seconds=180)
        e.sql(db,file=out/'current-authorities.sql',label='captured-f06-closure')
        e.sql(db,file=ROOT/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='structural-opening')
        e.sql(db,file=ROOT/hand.MIGRATION,label='retained-submission-owner')
        e.sql(db,file=ROOT/'supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql',label='installed-disposal-owner')
        e.sql(db,chain.current_chain(ROOT),label='maintained-current-financial-chain')
        e.sql(db,file=ROOT/chain.RAKED_DIAMOND,label='current-diamond-compatibility')
        e.sql(db,file=ROOT/chain.MIGRATION,label='current-accepted-roster-owner')
        # Empty read-only dependency shapes are captured verbatim; they are not
        # replacements for a financial function or synthetic player balances.
        for row in json.loads((ROOT/DATA/'current-read-dependencies.json').read_text())+json.loads((ROOT/DATA/'current-resume-read-dependencies.json').read_text())+json.loads((ROOT/DATA/'current-resume-correction-shapes.json').read_text())+json.loads((ROOT/DATA/'current-resume-call-dependencies.json').read_text()):
            e.sql(db,row['definition'],label='current-read-dependency-'+row['signature'].split('(')[0].replace('.','-'))
        preimages=json.loads((ROOT/DATA/'financial-preimages.json').read_text())
        for row in preimages:
            if row['signature']!='fn_ca_retain_hand_submission(jsonb)':
                e.sql(db,row['definition'],label='production-financial-owner-'+row['signature'].split('(')[0])

        retention=next(x['definition'] for x in preimages if x['signature']=='fn_ca_retain_hand_submission(jsonb)')
        e.sql(db,retention,label='production-retention-preimage')
        qualify_installation(e,hand,db)
        e.sql(db,file=ROOT/MIGRATION,label='continuation-candidate')
        qualify_admission(e,db,native,before=True)
        e.sql(db,file=ROOT/ADMISSION,label='continuation-admission-candidate')
        qualify_admission(e,db,native)
        before=(e.snapshot(db,'before-data'),e.catalog_snapshot(db,'before-catalog'),hand.private_snapshot(e,db,'before-private'))
        probe='BEGIN;\n'+(out/'opening.sql').read_text()+'\n'+(ROOT/PROBE).read_text()+'\nROLLBACK;'
        probe_file=out/'composed-private-continuation.sql'
        probe_file.write_text(probe)
        code,stdout,stderr=e.sql(db,file=probe_file,label='actual-private-continuation-cases',check=False)
        e.report.update(assertions=stderr.count('CONTINUATION PASS:'),case_errors=stderr)
        if code or re.search(r'(ERROR|FATAL|PANIC|WARNING):',stderr) or stdout.splitlines().count('HAND_CONTINUATION_NATIVE_PASS')!=1 or e.report['assertions']!=37:
            raise RuntimeError('private continuation native cases failed')
        after=(e.snapshot(db,'after-data'),e.catalog_snapshot(db,'after-catalog'),hand.private_snapshot(e,db,'after-private'))
        if before!=after:raise RuntimeError('complete public/private data/catalog rollback differs')
        e.report.update(data_rollback=True,catalog_rollback=True,private_catalog_and_data_rollback=True)
        qualify_fences(e,db,native)
        module(ROOT/'scripts/ci/played_clock_floor_cases.py','played_clock_floor').qualify(e,ROOT,hand)
        if any(sha(ROOT/p)!=digest for p,digest in source.items()):raise RuntimeError('qualification source changed')
        e.report['status']='passed';e.discard(db)
    except BaseException as error:e.report['failure']=repr(error)
    finally:
        for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,signal.SIG_IGN)
        try:e.close()
        except BaseException as error:e.report.update(cleanup_failure=repr(error),status='failed')
        e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n')
        print(json.dumps({k:e.report.get(k) for k in ('status','failure','assertions','cleanup')}),flush=True)
    return 0 if e.report['status']=='passed' else 1


if __name__=='__main__':sys.exit(main())
