#!/usr/bin/env python3
"""Qualify exact started-event abort migration and scoped real-money rollback/replay."""
import argparse,json,sys,hashlib,re,time
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
from tournament_abort_fixture import install_financial_foundation
from tournament_abort_native import install_f06_extension,sql_file,prepare_quiesced,SERVICE
ROOT=Path(__file__).resolve().parents[2]
MIGRATION=ROOT/'supabase/migrations/20261030161824_started_tournament_abort_uses_original_charges_and_a_drained.sql'
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--work-root',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True)
 a=p.parse_args();a.evidence.mkdir(parents=True,exist_ok=False);a.work_root.mkdir(parents=True,exist_ok=True);a.socket_root.mkdir(parents=True,exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','abort_native_execution');e=native.Execution(ROOT,a.evidence,a.pg_bin,a.work_root,600,socket_parent=a.socket_root)
 try:
  e.start();db=e.database();install_financial_foundation(e,db,ROOT,a.evidence);install_f06_extension(e,db,ROOT)
  diamond=module(ROOT/'scripts/ci/fixtures/tournament-abort/diamond/diamond_abort_native.py','abort_diamond_cases');diamond.install_diamond_extension(e,db,ROOT)
  installed_at=time.monotonic();e.sql(db,file=MIGRATION,label='exact-started-abort-migration',seconds=120)
  e.report['migration_install_seconds']=time.monotonic()-installed_at
  proof=next(line.removeprefix('-- @live-proof: ') for line in MIGRATION.read_text().splitlines() if line.startswith('-- @live-proof: '))
  _,live_proof,_=e.sql(db,'SELECT '+proof+';',label='exact-started-abort-source-live-proof')
  assert live_proof.strip()=='t'
  assert e.report['migration_install_seconds']<5
  seed=(ROOT/'scripts/ci/probes/satellite-cancel-current-native.sql').read_text().split('-- Fund the source through')[0]
  seed=seed.replace('ON COMMIT DROP;','ON COMMIT PRESERVE ROWS;')
  sql_file(e,db,'real-chip-registration','BEGIN;'+seed+'COMMIT;')
  event='d3000000-0000-4000-8000-000000000002';op='ac000000-0000-4000-8000-000000000001';table='ad000000-0000-4000-8000-000000000001'
  money_hash=prepare_quiesced(e,db,event,op,table)
  call="public.fn_ca_settle_tournament_abort('"+op+"','"+event+"','"+money_hash+"')"
  def refusal(name,body,expected):
   sql_file(e,db,name,"BEGIN;"+SERVICE+"DO $$DECLARE refused boolean:=false;BEGIN BEGIN "+body+" EXCEPTION WHEN OTHERS THEN IF SQLSTATE<>'"+expected+"' THEN RAISE;END IF;refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'missing abort refusal';END IF;END$$;ROLLBACK;")
  refusal('wrong-review-hash-refused',"PERFORM public.fn_ca_settle_tournament_abort('"+op+"','"+event+"','changed');",'55000')
  refusal('browser-cannot-refund',"PERFORM set_config('request.jwt.claim.role','authenticated',true);PERFORM "+call+";",'42501')
  sql_file(e,db,'accepted-original-stops-refund-but-can-restore',"BEGIN;"+SERVICE+"""
SELECT set_config('app.smarter_data_actor','tournament-manager',true),set_config('app.smarter_tournament_id','"""+event+"""',true),set_config('app.smarter_tournament_lease_generation','ab000000-0000-4000-8000-000000000001',true);
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
VALUES('ae000000-0000-4000-8000-000000000001','"""+event+"""','"""+table+"""',1,1,'af000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000001');
DO $$DECLARE restored jsonb;fresh jsonb;refused boolean:=false;BEGIN
 restored:=public.fn_f06_begin_hand('"""+event+"""','ab000000-0000-4000-8000-000000000001','"""+table+"""',1,'ae000000-0000-4000-8000-000000000001',1,'af000000-0000-4000-8000-000000000001');
 fresh:=public.fn_f06_begin_hand('"""+event+"""','ab000000-0000-4000-8000-000000000001','"""+table+"""',1,'ae000000-0000-4000-8000-000000000002',2,'af000000-0000-4000-8000-000000000002');
 IF restored->>'ok' IS DISTINCT FROM 'true' OR fresh->>'ok' IS DISTINCT FROM 'false' OR public.fn_ca_operator_floor_state('"""+table+"""')->'hold' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'original restoration/new-admission floor contract failed';END IF;
 BEGIN PERFORM """+call+""";EXCEPTION WHEN SQLSTATE '55000' THEN refused:=true;END;
 IF NOT refused OR EXISTS(SELECT 1 FROM public.tournament_refund_tranches WHERE tournament_id='"""+event+"""') THEN RAISE EXCEPTION 'accepted hand was refunded';END IF;
END$$;ROLLBACK;""")
  concurrency=module(ROOT/'scripts/ci/test-tournament-cancellation-lane.py','abort_existing_sessions');left=concurrency.Session(e,db);right=concurrency.Session(e,db)
  try:
   left.query('BEGIN;SELECT smarter_private.cancellation_lane(\''+event+'\');')
   right.query('BEGIN;'+SERVICE+"DO $$DECLARE refused boolean:=false;BEGIN BEGIN PERFORM "+call+";EXCEPTION WHEN SQLSTATE '55P03' THEN refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'concurrent abort admitted';END IF;END$$;")
  finally:
   left.close();right.close()
  sql_file(e,db,'failure-after-real-refund-rolls-back',"""BEGIN;"""+SERVICE+"""
CREATE FUNCTION pg_temp.refuse_abort_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native_receipt_failure';END$$;
CREATE TRIGGER native_abort_failure BEFORE INSERT ON public.tournament_cancellation_receipts FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_abort_receipt();
DO $$DECLARE before_balance numeric;failed boolean:=false;BEGIN
 SELECT chip_balance INTO before_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id='d1000000-0000-4000-8000-000000000001';
 BEGIN PERFORM """+call+""";EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'native_receipt_failure' THEN RAISE;END IF;failed:=true;END;
 IF NOT failed OR before_balance IS DISTINCT FROM (SELECT chip_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id='d1000000-0000-4000-8000-000000000001') OR EXISTS(SELECT 1 FROM public.tournament_refund_tranches WHERE tournament_id='"""+event+"""') OR NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets WHERE tournament_id='"""+event+"""' AND state='quiesced') THEN RAISE EXCEPTION 'abort failed atomic rollback';END IF;
END$$;ROLLBACK;""")
  _,out,_=sql_file(e,db,'real-chip-refund-terminal-replay','BEGIN;'+SERVICE+'SELECT '+call+';SELECT '+call+';COMMIT;')
  sql_file(e,db,'chip-independent-exact-readback',"""DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id='d1000000-0000-4000-8000-000000000001' AND chip_balance=200)
 OR NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts WHERE tournament_id='"""+event+"""' AND receipt_version=3 AND total_refunded=100 AND fees_reversed=10 AND refund_line_count=1)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='"""+event+"""' AND status='CANCELLED' AND started_at IS NOT NULL)
 OR (SELECT count(*) FROM public.tournament_refund_tranches WHERE tournament_id='"""+event+"""')<>1 THEN RAISE EXCEPTION 'independent original charge readback failed';END IF;
END$$;""")
  e.report['cases']=['exact-install','browser-refused','review-hash-refused','accepted-original-restorable-no-new-hand-no-refund','concurrent-original-lane-refused','paid-100-fee10-real-charge','failure-after-real-refund-fully-rolled-back','same-operation-replay-no-duplicate','canonical-v3-exact-terminal-receipt']
  chip_overlay=module(ROOT/'scripts/ci/chip_abort_overlay_native.py','abort_chip_overlay');chip_overlay.run_chip_overlay(e,db,ROOT)
  diamond.seed(e,db);diamond.run_diamond_cases(e,db,ROOT)
  names=set(re.findall(r'CREATE(?: OR REPLACE)? FUNCTION (?:public|smarter_private)\.(\w+)',MIGRATION.read_text()))
  names.update(['fn_f06_begin_hand','fn_ca_tournament_entry_gate','fn_ca_capture_tournament_charge_entitlement','fn_poker_diamond_tournament_charge','fn_ca_escrow_on_rake_record','fn_ca_tournament_cancellation_receipt'])
  _,postimages,_=e.sql(db,"SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private') AND p.proname IN("+','.join("'"+n+"'" for n in sorted(names))+");",label='qualified-exact-postimages')
  e.report['postimages']=json.loads(postimages.strip())
  inputs=[Path(__file__),ROOT/'scripts/ci/tournament_abort_native.py',ROOT/'scripts/ci/chip_abort_overlay_native.py',ROOT/'scripts/ci/tournament_abort_fixture.py',MIGRATION,ROOT/'.github/workflows/ci.yml']
  e.report['source_sha256'].update({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs})
  e.report['passed']=True;e.report['status']='passed'
 finally:
  e.close();(a.evidence/'abort-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
