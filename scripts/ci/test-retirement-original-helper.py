#!/usr/bin/env python3
"""Real PG17 scoped custody-helper regression. Full financial owner proof is separate.
Uses maintained financial catalog closure; never replaces a financial owner with a mock.
This deliberately calls only the actual helper, not an obsolete captured financial core.
"""
import argparse, hashlib, json, subprocess, signal, sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module,table_sql
MIGRATION=Path("supabase/migrations/20261006182937_a_retirement_cannot_erase_the_original_tournament_hand.sql")
SEAT_CONTINUATION=Path('supabase/migrations/20261007000711_a_retained_tournament_seat_keeps_its_original_paid_stack.sql')
SEAT_READ_DEPS=Path('scripts/ci/fixtures/retirement-original/recorded-seat-first-read-dependencies.sql')
SEAT_GUARD_PROOF=Path('scripts/ci/fixtures/retirement-original/aged-seat-guard-proof.sql')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);a=p.parse_args()
 root=Path(__file__).resolve().parents[2];out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 hand=module(root/'scripts/ci/test-hand-submission.py','retirement_hand_fixture');hand.prepare(root,out)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','retirement_pg_owner');a.socket_root.mkdir(parents=True,exist_ok=True);e=native.Execution(root,out,a.pg_bin.resolve(),out,300,socket_parent=a.socket_root)
 e.report['scope']='native original custody helper; not current financial owner certification'
 inputs=[Path('supabase/migrations/20261007023702_an_original_retired_hand_owns_its_exact_parked_continuation.sql'),Path('scripts/ci/fixtures/retirement-original/current-f06-source-guard.sql'),MIGRATION,SEAT_CONTINUATION,SEAT_READ_DEPS,SEAT_GUARD_PROOF,Path('scripts/admin/retire-patterned-identities.sql'),Path('scripts/qualification/build-retirement-native-fixture.py'),Path('scripts/qualification/retirement-native-proof.sql'),Path('scripts/qualification/retirement-original-57-manifest.json'),Path('scripts/ci/fixtures/retirement-original/readonly-provenance-shapes.json'),Path('scripts/ci/fixtures/retirement-original/retirement-catalog.sql'),Path(__file__).relative_to(root)]
 e.report['source_sha256']={str(f):hashlib.sha256((root/f).read_bytes()).hexdigest() for f in inputs}
 for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,file=out/'foundation.sql',label='actual-maintained-catalog',seconds=180)
  e.sql(db,file=out/'current-authorities.sql',label='actual-retention-dependencies')
  e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='existing-structural-template')
  e.sql(db,file=root/hand.MIGRATION,label='existing-native-retention-owner')
  shapes=json.loads((root/'scripts/ci/fixtures/retirement-original/readonly-provenance-shapes.json').read_text())['tables']
  for shape in shapes:
   row=dict(shape);row['constraints']=[c for c in row['constraints'] if c['type']!='f']
   e.sql(db,table_sql(row),label='actual-readonly-provenance-shape-'+row['name'])
  mark=(root/'supabase/migrations/20261002083400_a_table_start_reads_only_the_hands_after_its_settled_mark_an.sql').read_text()
  mark=mark[mark.index('CREATE TABLE smarter_private.hand_submission_resume_marks'):mark.index('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission')]
  e.sql(db,mark,label='actual-empty-native-resume-mark')
  disposal=(root/'supabase/migrations/20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.sql').read_text()
  disposal=disposal[disposal.index('CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_disposals'):disposal.index('DROP TRIGGER IF EXISTS hand_submission_disposal_immutable')]
  e.sql(db,disposal,label='actual-empty-native-disposal-receipts')
  e.sql(db,file=root/'scripts/ci/fixtures/retirement-original/retirement-catalog.sql',label='empty-retirement-catalog')
  e.sql(db,"CREATE SCHEMA retirement_native; CREATE FUNCTION retirement_native.submission_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'isolated accepted-hand storage interruption' USING ERRCODE='XX000'; END$$;",label='fixture-namespace')
  opening=(out/'opening.sql').read_text();opening=opening.replace('SET LOCAL session_replication_role=replica;','').replace('SET LOCAL session_replication_role = replica;','')
  e.sql(db,'BEGIN; SET LOCAL session_replication_role=replica;'+opening+'SET LOCAL session_replication_role=origin; COMMIT;',label='actual-original-template')
  s=(root/MIGRATION).read_text()
  helper=s[s.index('AS $body$')+len('AS $body$'):s.index('$body$;',s.index('AS $body$'))]
  if hashlib.md5(helper.encode()).hexdigest()!='2663bfd55e57f5b2499cc7da43def579':raise ValueError('qualified native helper body changed')
  required=["retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);","IF retirement_restored AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN","USING ERRCODE='P0404'"]
  if any(x not in s for x in required):raise ValueError('native financial claim/rollback wiring changed')
  start=s.index('CREATE TABLE smarter_private.retirement_original_hand_qualification');end=s.index('DO $native_patch$')
  e.sql(db,'BEGIN;'+s[start:end]+'COMMIT;',label='exact-private-custody-helper')
  e.sql(db,'ALTER TABLE public.tournaments ADD COLUMN format_contract text;',label='captured-current-format-discriminator-column')
  e.sql(db,file=root/SEAT_READ_DEPS,label='exact-recorded-seat-first-read-guards')
  e.sql(db,file=root/SEAT_CONTINUATION,label='exact-retained-seat-continuation-helper-and-guard')
  subprocess.run([sys.executable,str(root/'scripts/qualification/build-retirement-native-fixture.py'),'--output',str(out)],check=True)
  cohort=(out/'cohort-native-opening.sql').read_text()
  cohort=cohort.replace('CREATE TRIGGER zz_retirement_original_failure BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();','').replace('DROP TRIGGER zz_retirement_original_failure ON public.hand_projection_outbox;','')
  x=cohort.index('  r:=public.fn_ca_commit_hand_submission');z=cohort.index(' END LOOP;',x);cohort=cohort[:x]+cohort[z:]
  e.sql(db,cohort,label='57-native-retained-original-custodies',seconds=120)
  probe=(root/'scripts/qualification/retirement-native-proof.sql').read_text();probe=probe[:probe.index('DO $lease$')]
  probe=probe.replace("r:=public.fn_ca_resume_hand_submission(c.table_id,'synthetic-successor',c.successor_generation);","r:=jsonb_build_object('restored',smarter_private.restore_retired_original_tournament_hand(c.submission_id,'synthetic-successor',c.successor_generation));")
  e.sql(db,probe,label='real-helper-negative-custody-boundaries',seconds=120)

  e.sql(db,"CREATE TABLE IF NOT EXISTS smarter_private.f06_elimination_dispatch(\"xid\" bigint NOT NULL,\"relation_name\" text NOT NULL,\"row_id\" uuid NOT NULL,\"candidate_id\" uuid NOT NULL,\"old_record\" jsonb NOT NULL,\"new_record\" jsonb NOT NULL);\nCREATE TABLE IF NOT EXISTS smarter_private.f06_movement_admissions(\"admission_id\" uuid NOT NULL,\"tournament_id\" uuid NOT NULL,\"lease_generation\" uuid NOT NULL,\"table_id\" uuid NOT NULL,\"lifecycle\" bigint NOT NULL,\"break_id\" uuid NOT NULL,\"custody_id\" uuid NOT NULL,\"revision\" bigint NOT NULL,\"requested_revision\" bigint NOT NULL,\"proof\" jsonb NOT NULL,\"proof_hash\" text NOT NULL,\"created_at\" timestamp with time zone NOT NULL);\nALTER TABLE smarter_private.f06_operations ADD COLUMN IF NOT EXISTS abort_receipt_id uuid;\n",label='actual-current-f06-read-shape-columns')
  e.sql(db,file=root/'scripts/ci/fixtures/retirement-original/current-f06-source-guard.sql',label='actual-current-f06-source-guard-preimage')
  e.sql(db,"DROP TRIGGER IF EXISTS a00_f06_source_roster ON public.tournament_players; CREATE TRIGGER a00_f06_source_roster BEFORE UPDATE OR INSERT OR DELETE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard(); DROP TRIGGER IF EXISTS a00_f06_source_seat ON public.table_seats;CREATE TRIGGER a00_f06_source_seat BEFORE UPDATE OR INSERT OR DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();",label='armed-actual-f06-custody-boundaries')
  e.sql(db,"INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,manifest,revision,created_at) SELECT retirement_native.fixture_id(50,1),tournament_id,table_id,1,retirement_native.fixture_id(51,1),successor_generation,'park_requested',NULL,0,now() FROM retirement_native.cases WHERE i=1;",label='one-anonymous-current-original-unbegun-park')
  e.sql(db,r'''SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';DO $$DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM retirement_native.resume_case(1); EXCEPTION WHEN SQLSTATE '55000' THEN refused:=SQLERRM='F06_SOURCE_EXCLUDED';END;
 PERFORM retirement_native.assert_true(refused,'before-source actual original helper refuses its later park');
 PERFORM retirement_native.assert_true(NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations),'before-source failure rolls original receipt back');
 END$$;''',label='before-source-original-park-refusal')
  e.sql(db,file=root/'supabase/migrations/20261007023702_an_original_retired_hand_owns_its_exact_parked_continuation.sql',label='exact-maintained-original-f06-continuation')
  e.sql(db,"SELECT md5(pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure)),md5(prosrc),proacl::text,proconfig::text,pg_get_userbyid(proowner),prosecdef FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure;",label='exact-current-f06-native-postimage-security')
  e.sql(db,r'''SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';DO $$DECLARE action text;refused boolean;BEGIN
 FOR action IN SELECT unnest(ARRAY[
 'UPDATE smarter_private.f06_operations SET state=''begun'' WHERE source_table_id=retirement_native.fixture_id(1,1)',
 'UPDATE smarter_private.f06_operations SET manifest=''{}''::jsonb WHERE source_table_id=retirement_native.fixture_id(1,1)'
 ]) LOOP BEGIN
 EXECUTE action;refused:=false;
 BEGIN PERFORM retirement_native.resume_case(1);EXCEPTION WHEN SQLSTATE '55000' THEN refused:=SQLERRM='F06_SOURCE_EXCLUDED';END;
 PERFORM retirement_native.assert_true(refused,'begun manifest foreign lifecycle remains excluded');
 PERFORM retirement_native.assert_true(NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations),'refused park preserves original receipt and force postimages');
 RAISE EXCEPTION 'rollback isolated park boundary' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;END LOOP;
 END$$;''',label='native-original-park-foreign-and-begun-refusals')

  e.sql(db,r'''SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
DO $$DECLARE mode text;denied boolean;c retirement_native.cases;BEGIN
SELECT * INTO c FROM retirement_native.cases WHERE i=1;
FOR mode IN SELECT unnest(ARRAY['wrong_transaction','unknown_role','wrong_successor']) LOOP BEGIN
INSERT INTO smarter_private.retirement_original_hand_restorations(submission_id,original_generation,successor_generation,instance_id,request_hash,qualification_hash,transaction_id,restored_players)
SELECT q.submission_id,s.lease_generation,CASE WHEN mode='wrong_successor' THEN retirement_native.fixture_id(5,99) ELSE c.successor_generation END,'synthetic-successor',q.request_hash,md5(q.expected::text),CASE WHEN mode='wrong_transaction' THEN txid_current()-1 ELSE txid_current() END,jsonb_array_length(q.expected->'rows') FROM smarter_private.retirement_original_hand_qualification q JOIN smarter_private.hand_submissions s USING(submission_id) WHERE q.submission_id=c.submission_id;
IF mode='unknown_role' THEN PERFORM set_config('request.jwt.claim.role','',true);PERFORM set_config('request.jwt.claims','{}',true);END IF;
denied:=false;BEGIN UPDATE public.tournament_players SET status='playing',eliminated_at=NULL WHERE id=retirement_native.fixture_id(7,11);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='F06_SOURCE_EXCLUDED';END;
PERFORM retirement_native.assert_true(denied,'F06 exact capability refuses '||mode);
RAISE EXCEPTION 'rollback private capability counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;END LOOP;
END$$;''',label='native-f06-original-receipt-role-transaction-generation-refusals')
  retirement=(root/'scripts/admin/retire-patterned-identities.sql').read_text()
  gate=retirement[retirement.index("  IF current_setting('session_replication_role')"):retirement.index('  SELECT count(*) INTO v_done')]
  gate_sql="CREATE FUNCTION retirement_native.retirement_gate(v_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$DECLARE v_table uuid;v_mark bigint;v_scan integer;v_pending integer;BEGIN\n"+gate+"END$$;"
  e.sql(db,gate_sql,label='exact-maintained-retirement-read-gate')
  e.sql(db,"""DO $$DECLARE ids uuid[];denied boolean:=false;BEGIN
SELECT array_agg(old_id) INTO ids FROM smarter_private.patterned_identity_retirements;
BEGIN PERFORM retirement_native.retirement_gate(ids);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='BOT_ID_UNPAID_TOURNAMENT_CUSTODY';END;
PERFORM retirement_native.assert_true(denied,'retirement refuses positive eliminated originals despite forced left flags');
BEGIN
PERFORM set_config('session_replication_role','replica',true);UPDATE public.tournaments SET status='COMPLETED' WHERE id IN(SELECT tournament_id FROM retirement_native.cases);UPDATE public.tables SET tournament_id=NULL,status='closed',seat_admission_key='closed' WHERE id=(SELECT table_id FROM retirement_native.cases WHERE i=1);PERFORM set_config('session_replication_role','origin',true);denied:=false;
BEGIN PERFORM retirement_native.retirement_gate(ids);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='BOT_ID_UNPAID_OR_UNPROVEN_CASH_CUSTODY';END;
PERFORM retirement_native.assert_true(denied,'retirement refuses positive cash felt despite forced departure');
RAISE EXCEPTION 'rollback synthetic cash counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
BEGIN
PERFORM set_config('session_replication_role','replica',true);UPDATE public.tournaments SET status='COMPLETED' WHERE id IN(SELECT tournament_id FROM retirement_native.cases);PERFORM set_config('session_replication_role','origin',true);denied:=false;
BEGIN PERFORM retirement_native.retirement_gate(ids);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM LIKE 'BOT_ID_ORIGINAL_HAND_UNDRAINED:%';END;
PERFORM retirement_native.assert_true(denied,'claimed terminal statuses never erase the retained original obligation');
RAISE EXCEPTION 'rollback synthetic terminal counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
BEGIN
PERFORM set_config('session_replication_role','replica',true);denied:=false;
BEGIN PERFORM retirement_native.retirement_gate(ids);EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='BOT_ID_NATIVE_GUARDS_REQUIRED';END;
PERFORM retirement_native.assert_true(denied,'maintained retirement refuses replica trigger bypass');
RAISE EXCEPTION 'rollback synthetic replica counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
BEGIN
-- Gate-read acceptance only: synthetic terminal outcomes and native mark shape,
-- not a financial payment rehearsal or a moved-custody qualification.
PERFORM set_config('session_replication_role','replica',true);
UPDATE public.tournaments SET status='COMPLETED' WHERE id IN(SELECT tournament_id FROM retirement_native.cases);
WITH terminal AS(SELECT id,row_number() OVER(PARTITION BY tournament_id ORDER BY id)::integer AS place FROM public.tournament_players WHERE tournament_id IN(SELECT tournament_id FROM retirement_native.cases)) UPDATE public.tournament_players p SET chips=0,position=t.place FROM terminal t WHERE p.id=t.id;
UPDATE public.table_seats SET stack=0 WHERE table_id IN(SELECT table_id FROM retirement_native.cases);
INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through) SELECT c.table_id,s.hand_number FROM retirement_native.cases c JOIN smarter_private.hand_submissions s ON s.submission_id=c.submission_id ON CONFLICT(table_id) DO UPDATE SET settled_through=excluded.settled_through;
PERFORM set_config('session_replication_role','origin',true);
PERFORM retirement_native.retirement_gate(ids);
RAISE NOTICE 'RETIREMENT NATIVE PASS: terminal zero-custody and settled original read gate admits retirement';
RAISE EXCEPTION 'rollback synthetic drained counterfactual' USING ERRCODE='P9001';EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
END$$;""",label='native-retirement-unpaid-original-and-bypass-refusals')
  success="""SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}';
BEGIN; DO $$DECLARE c retirement_native.cases;r jsonb;BEGIN FOR c IN SELECT * FROM retirement_native.cases ORDER BY i LOOP r:=retirement_native.resume_case(c.i);PERFORM retirement_native.assert_true(r->>'restored'='true','native helper restores exact original custody '||c.i);END LOOP;END$$;
SELECT retirement_native.assert_true((SELECT count(*)=57 AND sum(restored_players)=66 FROM smarter_private.retirement_original_hand_restorations),'57 transaction-owned receipts / 66 restored originals');
SELECT retirement_native.assert_true((SELECT count(*)=66 FROM public.profiles WHERE status='deleted' AND horse_status='disabled'),'closed profiles remain closed');
ROLLBACK;
SELECT retirement_native.assert_true((SELECT count(*)=66 FROM public.tournament_players WHERE status='eliminated') AND NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations),'whole owner transaction rollback preserves all66 postimages and zero receipts');
SELECT 'RETIREMENT_HELPER_NATIVE_PASS';"""
  success=success.replace('ROLLBACK;',(root/SEAT_GUARD_PROOF).read_text()+'\nROLLBACK;')
  code,stdout,stderr=e.sql(db,success,label='real-helper-57-restore-and-owner-rollback',seconds=120)
  if stdout.splitlines().count('RETIREMENT_HELPER_NATIVE_PASS')!=1:raise RuntimeError('native helper completion absent')
  e.report.update(status='passed',passed=True,native_originals=57,affected_custodies=66,synthetic_only=True)
 finally:
  e.close();(out/'retirement-helper-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
