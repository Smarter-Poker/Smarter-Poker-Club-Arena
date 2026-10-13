#!/usr/bin/env python3
"""Actual maintained original-hand financial fixture closure, preparation only."""
import pathlib,sys,importlib.util,json,datetime,argparse,hashlib
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module
native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','correction_execution')
parser=argparse.ArgumentParser()
parser.add_argument('--output',type=pathlib.Path,required=True)
parser.add_argument('--private-fixture-input',type=pathlib.Path)
parser.add_argument('--public-safe',action='store_true')
parser.add_argument('--keep-fixture-on-error',action='store_true',help='Diagnostic owned historical fixture loading only; never a passing qualification')
parser.add_argument('--pg-bin',type=pathlib.Path,required=True)
parser.add_argument('--socket-root',type=pathlib.Path,required=True)
args=parser.parse_args()
if args.public_safe == (args.private_fixture_input is not None):raise SystemExit('Choose exactly one public-safe or explicit private-fixture mode')
out=args.output.resolve()
inp=(ROOT/'scripts/qualification/retained18-correction/fixtures') if args.public_safe else args.private_fixture_input.resolve()
for location in (out,inp,args.socket_root.resolve()):
 if sys.platform=='darwin' and not str(location).startswith('/Volumes/SmarterWork/agent-work/'):
  raise SystemExit('All native input/output/socket paths must be on the owned external SSD')
args.socket_root.mkdir(parents=True,exist_ok=True)
out.mkdir(parents=True,exist_ok=False)
e=native.Execution(ROOT,out,args.pg_bin,out,300,socket_parent=args.socket_root)
e.report['private_fixture_sha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in inp.iterdir() if p.is_file()}
e.report['source_sha256']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'scripts/qualification/retained18-correction').iterdir() if p.is_file()}
try:
 e.start();db=e.database()
 fixture_loading=True
 e.sql(db,file=inp/'foundation.sql',label='actual-maintained-financial-foundation',seconds=180)
 e.sql(db,file=inp/'current-authorities.sql',label='actual-hand-authority-closure')
 e.sql(db,file=ROOT/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='existing-opening')
 e.sql(db,file=ROOT/'supabase/migrations/20260918092329_retained_hand_submission_atomic_acknowledgement.sql',label='original-journal')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-public-schema-additions.sql',label='actual-public-schema')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-retired-qualification-shape.sql',label='actual-retired-shape')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-unexecuted-inventory-shape.sql',label='actual-unexecuted-inventory-shape')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-diamond-variant.sql',label='actual-diamond-variant')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-lightning-marker-shape.sql',label='actual-lightning-marker-shape')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-lightning-seats.sql',label='actual-lightning-seats')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-f06-share-lane.sql',label='actual-f06-share-lane')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/current-actual-overlay.sql',label='actual-current-overlay',seconds=60)
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-seat-rebase-shape.sql',label='actual-seat-rebase-shape')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-jackpot-financial-shape.sql',label='actual-jackpot-financial-shape')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-resume-mark-key.sql',label='actual-resume-mark-key')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-recorded-format-authorities.sql',label='actual-current-recorded-format-source')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-seat-creation-authority.sql',label='actual-current-seat-creation-source')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-movement-check.sql',label='actual-current-movement-check')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-club-owner.sql',label='actual-current-club-owner-source')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-felt-authorities.sql',label='actual-current-felt-authorities')
 if not args.public_safe:
  e.sql(db,"DO $q$ BEGIN IF (SELECT count(*)=1 AND bool_and((tgenabled='O' AND tgtype=7 AND tgfoid='public.fn_tournaments_creation_guard()'::regprocedure AND pg_get_triggerdef(oid)='CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard()') IS TRUE) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname='tournaments_creation_guard' AND NOT tgisinternal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'HISTORICAL_KNOWN_GUARD_PREIMAGE';END IF;END $q$;",label='known-single-historical-guard-preimage')
  e.sql(db,"DROP TRIGGER tournaments_creation_guard ON public.tournaments; DO $q$ BEGIN IF EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname='tournaments_creation_guard') THEN RAISE EXCEPTION 'HISTORICAL_SINGLE_GUARD_NOT_DEFERRED';END IF;END $q$;",label='defer-only-structural-historical-insert-guard')
  if 'session_replication_role' in (inp/'actual-sensitive-opening.sql').read_text().lower():raise RuntimeError('Real original cohort fixture must not disable row triggers or use replica mode')
  e.sql(db,file=inp/'actual-sensitive-opening.sql',label='actual-original30-opening',seconds=60)
  e.sql(db,'CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard();',label='restore-exact-structural-historical-insert-guard')
  e.sql(db,"DO $q$ BEGIN IF (SELECT count(*)=1 AND bool_and((tgenabled='O' AND tgtype=7 AND tgfoid='public.fn_tournaments_creation_guard()'::regprocedure AND pg_get_triggerdef(oid)='CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard()') IS TRUE) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname='tournaments_creation_guard' AND NOT tgisinternal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'HISTORICAL_KNOWN_GUARD_NOT_RESTORED';END IF;END $q$;",label='exact-single-guard-restored-before-baseline-financial-proof')
 e.report['fixture_load_order']='Historical original row seeding omits only the unused synthetic zero venue and uses no replica mode. Individually reviewed tournament, launch/origin, finalized-registration, played-seat and felt INSERT creation seams restore exact current wiring before baseline/installer/financial calls; UPDATE/revival/immutable/financial guards remain. Not a current signup/new registration/new funding-flow proof.'

 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-original-baseline.sql',label='original-fullrow-and-financial-baseline')
 if not args.public_safe:e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/before-spent-original18.sql',label='actual30-spent-before',seconds=60)
 fixture_loading=False
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/qualified-none-source-native.sql',label='actual-qualified-none-trigger')
 e.sql(db,"CREATE TRIGGER poker_diamond_jackpot_accept_hand AFTER UPDATE OF post_commit_payload ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_jackpot_accept_hand();",label='actual-enabled-none-trigger')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-current-source-acls.sql',label='actual-current-source-ACLs')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-installer-authority.sql',label='actual-current-installer-authority')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-installed-parent-history.sql',label='isolated-installed-parent-history-shape')
 parent=(ROOT/'scripts/qualification/retained18-correction/qualified-none-parent.sql').read_text()
 if len(parent.encode())!=10477 or hashlib.md5(parent.encode()).hexdigest()!='4550b7577a9602c436c65869db8535ef':raise RuntimeError('Qualified parent bytes drift')
 e.sql(db,"INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('20261013021756','qualified none native parent',ARRAY["+"'"+parent.replace("'","''")+"'"+"]);",label='exact-native-parent-history-bytes')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/actual-native-money-creation-wiring.sql',label='actual-native-money-creation-authority')
 migration=ROOT/'supabase/migrations/20261013022132_a_retained_original_hand_corrects_its_exact_refused_source_o.sql'
 e.report['tested_migration']={'path':str(migration.relative_to(ROOT)),'bytes':len(migration.read_bytes()),'md5':hashlib.md5(migration.read_bytes()).hexdigest(),'sha256':hashlib.sha256(migration.read_bytes()).hexdigest()}
 raw_migration=migration.read_text()
 def refused_variant(label,mutation,expected):
  variant=raw_migration.replace('BEGIN;','BEGIN;\n'+mutation,1)
  code,stdout,stderr=e.sql(db,variant,label=label,seconds=30,check=False)
  if code==0 or expected not in stderr:raise RuntimeError(label+' did not refuse exact expected cause')
  e.report['migration_refusals'].append({'label':label,'expected':expected,'observed':True})
  e.sql(db,"DO $q$ BEGIN IF to_regclass('smarter_private.hand_submission_source_corrections') IS NOT NULL THEN RAISE EXCEPTION 'REFUSAL_LEFT_DDL';END IF;END $q$;",label=label+'-durable-absence')
 refused_variant('installer-parent-history-refusal',"DELETE FROM supabase_migrations.schema_migrations WHERE version='20261013021756';",'ORIGINAL30_QUALIFIED_NONE_HISTORY_REQUIRED')
 refused_variant('installer-preimage-refusal',"ALTER FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) SET search_path TO public;",'ORIGINAL30_RESUME_PREIMAGE_REQUIRED')
 refused_variant('installer-source-NULL-ACL-refusal',"UPDATE pg_proc SET proacl=NULL WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure;",'ORIGINAL30_FINANCIAL_SOURCE_CHAIN_DRIFT')
 refused_variant('installer-actual-freeze-refusal',"INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,enforce_freeze,ownership_token,updated_at) VALUES(true,'counting_down',clock_timestamp()-interval '1 minute',clock_timestamp(),clock_timestamp()+interval '5 minutes','native installer freeze',true,gen_random_uuid(),clock_timestamp()) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,break_ends_at=excluded.break_ends_at,enforce_freeze=true;",'ORIGINAL30_INSTALLER_FROZEN')
 trial=raw_migration.rsplit('COMMIT;',1)[0]+"DO $q$ BEGIN RAISE EXCEPTION 'EXPECTED_INSTALLER_ROLLBACK' USING ERRCODE='P9001';END $q$;"
 code,stdout,stderr=e.sql(db,trial,label='installer-complete-self-aborting-trial',seconds=30,check=False)
 if code==0 or 'EXPECTED_INSTALLER_ROLLBACK' not in stderr:raise RuntimeError('Installer self-aborting trial did not reach terminal')
 e.sql(db,"DO $q$ BEGIN IF to_regclass('smarter_private.hand_submission_source_corrections') IS NOT NULL THEN RAISE EXCEPTION 'TRIAL_LEFT_DDL';END IF;END $q$;",label='installer-trial-durable-absence')
 e.sql(db,file=migration,label='exact-official-correction-installer',seconds=30)
 code,stdout,stderr=e.sql(db,file=migration,label='exact-installer-replay-refused',seconds=30,check=False)
 if code==0 or 'ORIGINAL30_INSTALLER_ALREADY_PRESENT' not in stderr:raise RuntimeError('Exact installer replay not refused')

 e.sql(db,"DO $q$ BEGIN IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACTUAL_NATIVE_SOURCE_CHAIN_MISMATCH';END IF;RAISE NOTICE 'PASS actual26 original financial/F06/retained source body and security pins';END $q$;",label='actual26-source-chain-proof')
 before_null=(ROOT/'scripts/qualification/retained18-correction/native-source-matcher-before-null-fix.sql').read_text()
 before_assert=(ROOT/'scripts/qualification/retained18-correction/native-null-source-before.sql').read_text()
 e.sql(db,'BEGIN;'+before_null+before_assert+'ROLLBACK;',label='source-null-ACL-before-counterexample')
 e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-null-source-after.sql',label='source-null-ACL-config-after-refusal')
 if not args.public_safe:
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-negative-authority.sql',label='finite-authority-negatives')
  e.sql(db,"DO $q$ DECLARE e uuid; BEGIN FOR e IN SELECT submission_id FROM smarter_private.hand_submission_handoff_results WHERE result->>'error'='diamond_jackpot_wrong_hand_scope' LOOP PERFORM smarter_private.certify_original_hand_source_correction(e);END LOOP; IF (SELECT count(*) FROM smarter_private.hand_submission_source_corrections)<>30 THEN RAISE EXCEPTION 'actual30 certificatecount';END IF; RAISE NOTICE 'PASS actual30 canonical certificate admission on isolated original fixtures';END $q$;",label='actual30-certificate-proof',seconds=60)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-current-guards.sql',label='actual-current-guard-negatives',seconds=60)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-late-failure.sql',label='actual-late-stack-rollback',seconds=60)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-postcommit-interruption.sql',label='actual-accepted-postcommit-interruption',seconds=60)
  race=module(ROOT/'scripts/qualification/retained18-correction/native-concurrency.py','retained_original_race')
  race.run(e,db)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/after-original18.sql',label='actual30-connected-after',seconds=120)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-durable-original18.sql',label='actual30-durable-full-financial-readback',seconds=60)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-original18-replay.sql',label='all30-durable-replay',seconds=60)
  e.sql(db,file=ROOT/'scripts/qualification/retained18-correction/native-security-immutable.sql',label='private-security-and-immutable-refusals',seconds=60)
 else:
  e.sql(db,"DO $q$ DECLARE refused boolean:=false;BEGIN IF smarter_private.original_hand_source_correction_proof('00000000-0000-0000-0000-000000000031') IS NOT NULL THEN RAISE EXCEPTION 'EXTRA31_PROOF_ACCEPTED';END IF;BEGIN PERFORM smarter_private.certify_original_hand_source_correction('00000000-0000-0000-0000-000000000031');EXCEPTION WHEN SQLSTATE '55000' THEN refused:=true;END;IF NOT refused OR EXISTS(SELECT FROM smarter_private.hand_submission_source_corrections) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_results) THEN RAISE EXCEPTION 'PUBLIC_SAFE_REFUSAL_FAILED';END IF;RAISE NOTICE 'PASS public-safe installed source/extra31 refusal; private actual30 financial positives are separately qualified';END $q$;",label='public-safe-closed-authority-refusal')
 e.sql(db,"SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'body_md5',md5(p.prosrc),'full_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='smarter_private' AND p.proname IN('original_hand_correction_sources_match','original_hand_source_correction_proof','hand_source_correction_certificate_guard','certify_original_hand_source_correction','hand_source_correction_claim_guard','hand_source_correction_result_guard','hand_source_correction_immutable')) OR p.oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure;",label='final-safe-correction-source-catalog')
 e.sql(db,"SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'type',t.tgtype,'function',t.tgfoid::regprocedure::text,'definition_md5',md5(pg_get_triggerdef(t.oid)),'enabled',t.tgenabled) ORDER BY t.tgrelid::regclass::text,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('smarter_private.hand_submission_source_corrections'::regclass,'smarter_private.hand_submission_correction_claims'::regclass,'smarter_private.hand_submission_correction_results'::regclass) AND NOT t.tgisinternal;",label='final-safe-correction-trigger-catalog')
 if hashlib.sha256(migration.read_bytes()).hexdigest()!=e.report['tested_migration']['sha256']:raise RuntimeError('Assembled migration changed during native run')
 current_source={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'scripts/qualification/retained18-correction').iterdir() if p.is_file()}
 if current_source!=e.report['source_sha256']:raise RuntimeError('Source changed during native qualification; receipt remains diagnostic')
 if {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in inp.iterdir() if p.is_file()}!=e.report['private_fixture_sha256']:raise RuntimeError('Private fixture changed during native qualification')
 e.report['status']='public_safe_component_qualification_passed' if args.public_safe else 'actual_original30_connected_qualification_passed'
 e.report['scope']='safe original components/installer/refusals only, no private30 financial claim' if args.public_safe else 'actual retained original30/248 original stacks, no production mutations'
except BaseException as exc:e.report['failure']=repr(exc)
finally:
 if args.keep_fixture_on_error and e.report.get('failure') and fixture_loading:
  e.report['diagnostic_owned_cluster_retained']={'database':db,'socket':str(e.socket),'port':e.port if hasattr(e,'port') else None,'no_financial_qualification':True}
 else:e.close()
 (out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({'status':e.report.get('status'),'failure':e.report.get('failure'),'cleanup':e.report.get('cleanup')}))
