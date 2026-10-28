from pathlib import Path
import subprocess,json
import os,shutil
p=Path(__file__).resolve().parent
b=p/'fixtures'
socket=Path(os.environ['ORB_NATIVE_SOCKET'])
pg=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
args=[str(pg/'psql'),'-X','-q','-h',str(socket),'-p',os.environ.get('ORB_NATIVE_PORT','55931'),'-U','postgres','-v','ON_ERROR_STOP=1']
s=(socket/'finite245-certificate-composition.sql').read_text().split('DO $test$DECLARE c record;')[0]+'SET timezone=\'UTC\';'

bootstrap=(p/'seal-native-inputs/bootstrap.sql').read_text();
for table in ['union_pnl_inventory_capture','union_pnl_inventory_checkpoint_issues','union_pnl_inventory_checkpoint_rows','union_pnl_inventory_checkpoints']:
 start=bootstrap.index('CREATE TABLE public.'+table+'(');end=bootstrap.index(';',start)+1;s+=bootstrap[start:end]+'\n'
s+="ALTER TABLE public.union_pnl_inventory_checkpoints ADD PRIMARY KEY(boundary);CREATE TABLE public.union_pnl_inventory_seal_builds(boundary timestamptz,ready boolean);CREATE TABLE public.union_pnl_inventory_seal_build_rows(LIKE public.union_pnl_inventory_checkpoint_rows);CREATE TABLE public.union_pnl_inventory_seal_build_issues(LIKE public.union_pnl_inventory_checkpoint_issues);"
parent=(p/'seal-native-inputs/qualified-parent-20200734.sql').read_text();start=parent.index('CREATE VIEW public.union_pnl_inventory_published_rows');end=parent.index('REVOKE ALL ON public.union_pnl_inventory_published_rows',start);s+=parent[start:end]
s+=(b/'actual-inventory-state.sql').read_text()
s+=(p/'original-population.sql').read_text().replace('\\n','\n')+';'+(p/'original-as-of.sql').read_text().replace('\\n','\n')+';'
s+=(b/'actual-week-start.sql').read_text()
raw=(b/'original-Oct12-raw-inventory-from-5f50.jsonb').read_text();rows=(b/'original-Oct12-active-checkpoint-rows.jsonb').read_text();issues=(b/'original-Oct12-checkpoint-issues.jsonb').read_text();
s+="CREATE TEMP TABLE native_original_raw AS SELECT $original$"+raw+"$original$::jsonb r;INSERT INTO public.union_pnl_inventory_capture SELECT true,(r->>'capture_started_at')::timestamptz,1,'{}'::jsonb FROM native_original_raw;"
s+="INSERT INTO public.union_pnl_inventory_checkpoint_rows SELECT(jsonb_populate_record(NULL::public.union_pnl_inventory_checkpoint_rows,x)).* FROM jsonb_array_elements($rows$"+rows+"$rows$::jsonb)x;"
s+="INSERT INTO public.union_pnl_inventory_checkpoint_issues SELECT(jsonb_populate_record(NULL::public.union_pnl_inventory_checkpoint_issues,x)).* FROM jsonb_array_elements($issues$"+issues+"$issues$::jsonb)x;"
s+="INSERT INTO public.union_pnl_inventory_checkpoints VALUES('2026-10-12 07:00:00Z','2026-10-05 07:00:00Z',63116879,3352453,245,'5ae24d37326afb43bf598385c2ce24c5','9492245970312d6ac027287a5126c114','dd5e733acc7ed72e69b98d009ac124a6',false,771495,'postgres','2026-10-12 11:40:53.278694Z');"
for row in json.loads((b/'inventory245-actual-cache-functions.json').read_text())['rows']:s+=row['body']+';'
s+=(p/'basis-generation-cache-proposal.sql').read_text()+(p/'original-erased-discharge-flow-proposal.sql').read_text()+(p/'flow-consumer-proposal.sql').read_text()+(p/'report-consumer-cache-proposal.sql').read_text()+(p/'boundary-consumer-proposal.sql').read_text()+';'+(p.parent/'original-seven-discharge'/'discharge.sql').read_text()+(p/'admitted-wrapper-proposal.sql').read_text()+(p/'global-proof-source-guard-proposal.sql').read_text()
if os.environ.get('ORB_INVENTORY_STATE_READ_MIGRATION'):
 candidate=Path(os.environ['ORB_INVENTORY_STATE_READ_MIGRATION']).read_text().strip()
 assert candidate.endswith('COMMIT;')
 s+=candidate.replace('BEGIN;','',1).removesuffix('COMMIT;')+'\n'
if os.environ.get('ORB_WALLET_JACKPOT_FLOW_MIGRATION') or os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION'):
 import runpy
 wallet=runpy.run_path(str(p/'wallet-jackpot/native-input.py'))
 s+=wallet['setup_sql']
 candidate=Path(os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION') or os.environ['ORB_WALLET_JACKPOT_FLOW_MIGRATION']).read_text().strip()
 assert candidate.endswith('COMMIT;')
 body=candidate.replace('BEGIN;','',1).removesuffix('COMMIT;')
 if not os.environ.get('NATIVE_GENERATE_ONLY'):
  s+=wallet['before_sql']
 if os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION'):
  treasury=runpy.run_path(str(p/'treasury-gifts/native-input.py'))
  s+=treasury['setup_sql']
 s+="DO $wallet_ddl_rollback$DECLARE hashes jsonb;after_hashes jsonb;BEGIN SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO hashes FROM wallet_jackpot_original_metadata;BEGIN EXECUTE $wallet_candidate_rollback$"+body+"$wallet_candidate_rollback$;RAISE EXCEPTION USING ERRCODE='ZX002',MESSAGE='rollback candidate DDL';EXCEPTION WHEN SQLSTATE 'ZX002' THEN NULL;END;SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO after_hashes FROM wallet_jackpot_original_metadata;IF after_hashes IS DISTINCT FROM hashes OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'wallet jackpot DDL rollback changed original owner';END IF;RAISE NOTICE 'PASS wallet jackpot exact candidate DDL rollback';END$wallet_ddl_rollback$;"
 s+=body+'\nSET LOCAL search_path=public;\n'
 if not os.environ.get('NATIVE_GENERATE_ONLY'):
  s+=treasury['admissions_sql'] if os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION') else ''
  if os.environ.get('ORB_ORIGINAL_OCCUPANCY_FLOW_MIGRATION'):
   occupancy=runpy.run_path(str(p/'original-flow-occupancy/native-input.py'))
   s+=occupancy['qualification_sql']
  s+=treasury['wallet_after_sql'] if os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION') else wallet['after_sql']
  if os.environ.get('ORB_TREASURY_SEAT_GIFT_MIGRATION'):s+=treasury['after_sql']
  s+="DO $wallet_replay$BEGIN BEGIN EXECUTE $wallet_candidate_replay$"+body+"$wallet_candidate_replay$;RAISE EXCEPTION USING ERRCODE='ZX003',MESSAGE='candidate replay unexpectedly admitted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE 'wallet_jackpot_original_flow_owner_changed:%' THEN RAISE;END IF;END;RAISE NOTICE 'PASS wallet jackpot exact candidate replay refused';END$wallet_replay$;"
s+="DO $cert$DECLARE c record;started timestamptz:=clock_timestamp();BEGIN FOR c IN SELECT event_id FROM smarter_private.original_inventory_restoration_cases LOOP PERFORM smarter_private.certify_original_inventory_restoration(c.event_id,'2026-10-12 07:00:00Z');END LOOP;RAISE NOTICE 'QUALIFICATION finite245 certificate elapsed_ms=% count=%',(extract(epoch FROM(clock_timestamp()-started))*1000)::numeric(15,3),(SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates);END$cert$;"
s+=(p/'admitted-wrapper-proposal.sql').read_text()
if os.environ.get('ORB_REPORT_READER_COMPOSITION_MIGRATION') and not os.environ.get('NATIVE_GENERATE_ONLY'):
 report_path=Path(os.environ['ORB_REPORT_READER_COMPOSITION_MIGRATION'])
 report_candidate=report_path.read_text().strip()
 assert report_candidate.endswith('COMMIT;')
 report_authority=(p/'report-reader-composition/native-authority-before.sql').read_text()
 if os.environ.get('ORB_ORIGINAL_OCCUPANCY_FLOW_MIGRATION'):
  # The earlier occupancy lane already ran every exact installer, rollback,
  # replay, metadata/ACL and source65 check. Reuse that proven authority once.
  occupancy_candidate=Path(os.environ['ORB_ORIGINAL_OCCUPANCY_FLOW_MIGRATION']).read_text().strip()
  if not occupancy_candidate.endswith('COMMIT;'):raise RuntimeError('combined occupancy transaction shape changed')
  occupancy_prefix=occupancy_candidate.replace('BEGIN;','',1).removesuffix('COMMIT;')
  if not report_authority.startswith(occupancy_prefix):raise RuntimeError('combined report occupancy authority prefix changed')
  report_authority=report_authority[len(occupancy_prefix):]
 s+=report_authority
 report_body=report_candidate.replace('BEGIN;','',1).removesuffix('COMMIT;')
 for fault_sql,expected_reason in [
  ('GRANT EXECUTE ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)TO service_role','original_report_composition_owner_or_authority_changed:report'),
  ('ALTER FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz) SECURITY DEFINER','original_report_composition_source65_unqualified'),
  ('GRANT EXECUTE ON FUNCTION smarter_private.original_inventory_proof_sources_match()TO service_role','original_report_composition_owner_or_authority_changed:guard'),
  ("ALTER FUNCTION public.fn_union_pnl_boundary(uuid,timestamptz)SET search_path=pg_catalog,public",'original_report_composition_source65_unqualified')]:
  s+="DO $report_fault$BEGIN BEGIN EXECUTE $fault_sql$"+fault_sql+"$fault_sql$;BEGIN EXECUTE $report_fault_body$"+report_body+"$report_fault_body$;RAISE EXCEPTION USING ERRCODE='ZX008',MESSAGE='report drift unexpectedly admitted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>$reason$"+expected_reason+"$reason$ THEN RAISE;END IF;END;RAISE EXCEPTION USING ERRCODE='ZX007',MESSAGE='rollback fault';EXCEPTION WHEN SQLSTATE 'ZX007' THEN NULL;END;IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'report native fault rollback changed source';END IF;RAISE NOTICE 'PASS exact report composition authority drift refused: %',$reason$"+expected_reason+"$reason$;END$report_fault$;"
 s+="DO $report_atomic$DECLARE old_sources jsonb;new_sources jsonb;BEGIN SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO old_sources FROM(VALUES('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);BEGIN EXECUTE $report_atomic_sql$"+report_body+"$report_atomic_sql$;RAISE EXCEPTION USING ERRCODE='ZX005',MESSAGE='rollback exact report composition';EXCEPTION WHEN SQLSTATE 'ZX005' THEN NULL;END;SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO new_sources FROM(VALUES('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);IF old_sources IS DISTINCT FROM new_sources OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'report_composition_atomic_rollback_failed';END IF;RAISE NOTICE 'PASS exact report composition three-owner atomic rollback';END$report_atomic$;"
 s+=report_body
 s+=(p/'report-reader-composition/native-authority-after.sql').read_text()
 s+="DO $report_replay$BEGIN BEGIN EXECUTE $report_replay_sql$"+report_body+"$report_replay_sql$;RAISE EXCEPTION USING ERRCODE='ZX006',MESSAGE='report replay unexpectedly admitted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE 'original_report_composition_owner_or_authority_changed:%' THEN RAISE;END IF;END;RAISE NOTICE 'PASS exact report composition replay refused';END$report_replay$;"
if os.environ.get('ORB_REPORT_MEMBERSHIP_MIGRATION') and not os.environ.get('NATIVE_GENERATE_ONLY'):
 report_path=Path(os.environ['ORB_REPORT_MEMBERSHIP_MIGRATION'])
 report_candidate=report_path.read_text().strip()
 assert report_candidate.endswith('COMMIT;')
 report_authority=(p/'membership-capacity/native-authority-before.sql').read_text()
 s+=report_authority
 report_body=report_candidate.replace('BEGIN;','',1).removesuffix('COMMIT;')
 for fault_sql,expected_reason in [
  ("DELETE FROM public.engine_maintenance_break;INSERT INTO public.engine_maintenance_break(id,phase,ownership_token,announced_at,break_started_at,break_ends_at,enforce_freeze)VALUES(true,'counting_down',gen_random_uuid(),clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes',true)",'original_report_membership_platform_frozen'),
  ('GRANT EXECUTE ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)TO service_role','original_report_membership_owner_or_authority_changed:report'),
  ('ALTER FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz) SECURITY DEFINER','original_report_membership_source65_unqualified'),
  ('GRANT EXECUTE ON FUNCTION smarter_private.original_inventory_proof_sources_match()TO service_role','original_report_membership_owner_or_authority_changed:guard'),
  ("ALTER FUNCTION public.fn_union_pnl_boundary(uuid,timestamptz)SET search_path=pg_catalog,public",'original_report_membership_source65_unqualified')]:
  s+="DO $report_fault$BEGIN BEGIN EXECUTE $fault_sql$"+fault_sql+"$fault_sql$;BEGIN EXECUTE $report_fault_body$"+report_body+"$report_fault_body$;RAISE EXCEPTION USING ERRCODE='ZX008',MESSAGE='report drift unexpectedly admitted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>$reason$"+expected_reason+"$reason$ THEN RAISE;END IF;END;RAISE EXCEPTION USING ERRCODE='ZX007',MESSAGE='rollback fault';EXCEPTION WHEN SQLSTATE 'ZX007' THEN NULL;END;IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'report native fault rollback changed source';END IF;RAISE NOTICE 'PASS exact report composition authority drift refused: %',$reason$"+expected_reason+"$reason$;END$report_fault$;"
 s+="DO $report_atomic$DECLARE old_sources jsonb;new_sources jsonb;BEGIN SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO old_sources FROM(VALUES('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);BEGIN EXECUTE $report_atomic_sql$"+report_body+"$report_atomic_sql$;RAISE EXCEPTION USING ERRCODE='ZX005',MESSAGE='rollback exact report composition';EXCEPTION WHEN SQLSTATE 'ZX005' THEN NULL;END;SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(to_regprocedure(signature))))INTO new_sources FROM(VALUES('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);IF old_sources IS DISTINCT FROM new_sources OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'report_composition_atomic_rollback_failed';END IF;RAISE NOTICE 'PASS exact report composition three-owner atomic rollback';END$report_atomic$;"
 s+=report_body
 s+=(p/'membership-capacity/native-authority-after.sql').read_text()
 s+="DO $report_replay$BEGIN BEGIN EXECUTE $report_replay_sql$"+report_body+"$report_replay_sql$;RAISE EXCEPTION USING ERRCODE='ZX006',MESSAGE='report replay unexpectedly admitted';EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE 'original_report_membership_owner_or_authority_changed:%' THEN RAISE;END IF;END;RAISE NOTICE 'PASS exact report composition replay refused';END$report_replay$;"
s+="""DO $test$DECLARE old jsonb;raw jsonb;warm jsonb;a jsonb;BEGIN SELECT r INTO old FROM native_original_raw;raw:=public.fn_union_pnl_inventory_as_of('2026-10-12 07:00:00Z');IF raw IS DISTINCT FROM old OR md5(raw::text)<>'0b5f26fa2d7ec5aa15097b1f64d2c67b' THEN RAISE EXCEPTION 'originalrawfiniteactiveprojection differs %',md5(raw::text);END IF;
a:=public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z');IF a->>'status' IS DISTINCT FROM 'observed' OR a->'issues'<>'[]'::jsonb OR jsonb_array_length(a->'retained_original_inventory_issues')<>245 OR jsonb_array_length(a->'admitted_original_inventory_issues')<>245 OR a->'population' IS DISTINCT FROM raw->'population' THEN RAISE EXCEPTION 'full245wrapper admission differs %',a->>'admission_status';END IF;
warm:=public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z');IF warm IS DISTINCT FROM a OR public.fn_union_pnl_inventory_as_of('2026-10-12 07:00:00Z') IS DISTINCT FROM old THEN RAISE EXCEPTION 'warm/raw drift';END IF;
UPDATE pg_temp.union_pnl_inventory_as_of_cache SET result=jsonb_set(result,'{population}','{}'::jsonb);IF public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z')->>'status' IS DISTINCT FROM 'blocked' THEN RAISE EXCEPTION 'forgedwarmcache admitted';END IF;
UPDATE pg_temp.union_pnl_inventory_as_of_cache SET result=jsonb_set(old,'{issues}',(old->'issues')||jsonb_build_array(old#>'{issues,0}'));IF public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z')->>'admission_status' IS DISTINCT FROM 'duplicate_original_issue_refused' THEN RAISE EXCEPTION 'duplicateissue admitted';END IF;
UPDATE pg_temp.union_pnl_inventory_as_of_cache SET result=old||'{"issues":[],"status":"blocked"}'::jsonb;IF public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z')->>'status' IS DISTINCT FROM 'blocked' THEN RAISE EXCEPTION 'blockedempty promoted';END IF;
UPDATE pg_temp.union_pnl_inventory_as_of_cache SET result=old||'{"issues":[],"status":"observed"}'::jsonb;IF public.fn_union_pnl_inventory_as_of_admitted('2026-10-12 07:00:00Z')->>'status' IS DISTINCT FROM 'blocked' THEN RAISE EXCEPTION 'forgedobservedcache admitted';END IF;
RAISE NOTICE 'PASS original raw4090665bytes/dd5e/14941activeprojection/245issues immutable coldwarm admission and cache/duplicate/blocked-empty refusals';END $test$;ROLLBACK;"""
scope_before=(b/'before-original33-cross-union.sql').read_text()
scope_after=(p/'original-restoration-cash-return-proposal.sql').read_text()
# Execute the old actual helper in a rolled-back subtransaction, so postimage
# drift and its observed cross-scope refusal cannot persist into the next check.
scope="DO $scope$BEGIN BEGIN EXECUTE $before$"+scope_before+"$before$;PERFORM count(*) FROM smarter_private.original_restoration_cash_returns('ffffffff-0000-0000-0000-000000000099','2026-10-05 07:00Z','2026-10-12 07:00Z');RAISE EXCEPTION 'old crossunion helper did not refuse';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;IF (SELECT count(*) FROM smarter_private.original_restoration_cash_returns('ffffffff-0000-0000-0000-000000000099','2026-10-05 07:00Z','2026-10-12 07:00Z'))<>0 OR (SELECT sum(cashouts) FROM smarter_private.original_restoration_cash_returns('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z')) IS DISTINCT FROM 11559.38::numeric THEN RAISE EXCEPTION 'scoped original33 flow differs';END IF;RAISE NOTICE 'PASS actual original33 before crossunion refusal; after otherunionempty and fade11559.38 unchanged';END$scope$;"
s=s.removesuffix('ROLLBACK;')+scope+'ROLLBACK;'
controls=(socket/'finite245-certificate-composition.sql').read_text().split('SELECT * INTO c FROM smarter_private.original_inventory_restoration_certificates ORDER BY event_id LIMIT 1;',1)[1].split('END $test$;ROLLBACK;',1)[0]
controls="DO $controls$DECLARE c record;BEGIN SELECT * INTO c FROM smarter_private.original_inventory_restoration_certificates ORDER BY event_id LIMIT 1;"+controls+"END$controls$;"
s=s.removesuffix('ROLLBACK;')+controls+'ROLLBACK;'
import os
if os.environ.get('NATIVE_GENERATE_ONLY'):
 Path(os.environ['NATIVE_GENERATE_ONLY']).write_text(s);raise SystemExit(0)
log=socket/'finite245-raw-wrapper-native.log'
sqlfile=socket/'finite245-raw-wrapper-native.sql'
sqlfile.write_text(s)
with log.open('w') as capture:
 r=subprocess.run(args+['-d','original_source_refs','-f',str(sqlfile)],text=True,stdout=capture,stderr=subprocess.STDOUT)
print(r.returncode,log.read_text()[-2500:]);raise SystemExit(r.returncode)
