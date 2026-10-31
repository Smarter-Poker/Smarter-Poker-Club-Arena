#!/usr/bin/env python3
"""Exact20 withdrawal contract in an owned disposable PG17 cluster; no live route."""
import argparse,hashlib,json,sys,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
from tournament_abort_fixture import install_financial_foundation
from tournament_abort_registry_native import install_and_reproduce_registry_guard
from tournament_abort_native import install_f06_extension,sql_file,prepare_quiesced,SERVICE,GEN
ROOT=Path(__file__).resolve().parents[2]
MIGRATION=ROOT/'supabase/migrations/20261031161513_tournament_original_twenty_can_withdraw_unsettled_abort.sql'
BASE=ROOT/'supabase/migrations/20261030161824_started_tournament_abort_uses_original_charges_and_a_drained.sql'
EVENT='095d7449-3282-46c5-8a39-768fe14dce5a';OP='d44c4440-2911-430c-8ee7-376611ef3f38'
TABLE='ad000000-0000-4000-8000-000000000001'
AUTH=SERVICE+"SELECT set_config('app.smarter_data_actor','tournament-manager',true),set_config('app.smarter_tournament_id','"+EVENT+"',true),set_config('app.smarter_tournament_lease_generation','"+GEN+"',true);"
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for x in ['evidence','work-root','socket-root','pg-bin']:p.add_argument('--'+x,type=Path,required=True)
 a=p.parse_args();a.evidence.mkdir(parents=True,exist_ok=False);a.work_root.mkdir(parents=True,exist_ok=True);a.socket_root.mkdir(parents=True,exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','recovery20_execution');e=native.Execution(ROOT,a.evidence,a.pg_bin,a.work_root,600,socket_parent=a.socket_root)
 try:
  tool=ROOT/'scripts/ci/prepare-tournament-original-recovery.py'
  tool_args=[sys.executable,'-B',str(tool),'--tournament-id',EVENT,'--nonce','13000000-0000-4000-8000-000000000001','--instance-id','1-1234abcd','--lease-generation',GEN,'--release-sha','1234567890123456789012345678901234567890','--freeze-started',"2026-10-31'15:00:00+00:00",'--ownership-token','12000000-0000-4000-8000-000000000001','--custody-md5','0'*32]
  plan=subprocess.run(tool_args,capture_output=True,text=True,check=True).stdout
  assert '2026-10-31T15:00:00+00:00' in plan and 'set_config' not in plan and 'request.jwt' not in plan
  for key,value in [('--tournament-id','68000000-0000-4000-8000-000000000001'),('--release-sha','eed06fe51dea622069c661a6213d5b031ff3a9e3')]:
   args=list(tool_args);args[args.index(key)+1]=value
   assert subprocess.run(args,capture_output=True,text=True).returncode!=0
  e.report['tool_cases']=['typed-offline-plan-no-auth-spoof','other69-plan-refused','old-predecessor-plan-refused']
  e.run('manual-control-transport-contract',['node','--test',ROOT/'tests/operations/tournament-original-recovery-control.test.mjs'])
  e.report['manual_control_cases']=13
  e.start();db=e.database();install_financial_foundation(e,db,ROOT,a.evidence);install_f06_extension(e,db,ROOT)
  diamond=module(ROOT/'scripts/ci/fixtures/tournament-abort/diamond/diamond_abort_native.py','recovery20_diamond');diamond.install_diamond_extension(e,db,ROOT)
  install_and_reproduce_registry_guard(e,db,ROOT,BASE);e.sql(db,file=BASE,label='existing-started-abort-contract',seconds=120)
  captured=json.loads((ROOT/'scripts/ci/fixtures/tournament-recovery20/installed-preimages.json').read_text())
  definitions='SET check_function_bodies=off;'+''.join(x['definition']+';' for x in captured['functions'])
  # Actual present-day columns, with disposable physical contexts only. No
  # altered implementation stands in for a canonical financial function.
  by={}
  for x in captured['columns']:by.setdefault(x['table'],[]).append(x)
  for table,cols in by.items():
   definitions+='CREATE TABLE IF NOT EXISTS public.'+table+'('+','.join('"'+x['column']+'" '+x['type'] for x in cols)+');'
   for x in cols:definitions+='ALTER TABLE public.'+table+' ADD COLUMN IF NOT EXISTS "'+x['column']+'" '+x['type']+';'
  definitions+="CREATE TABLE IF NOT EXISTS public.ca_diamond_arena_owner_closure(club_id uuid,operation_id uuid,reason text,closed boolean);"
  definitions+='CREATE TABLE IF NOT EXISTS smarter_private.hand_continuations(table_id uuid,hand_number bigint,tournament_id uuid,permit_id uuid,original_generation uuid,writer_generation uuid,sequence bigint,payload text,payload_sha256 text,created_at timestamptz,updated_at timestamptz);'
  definitions+="CREATE TABLE IF NOT EXISTS smarter_private.hand_continuation_dispositions(table_id uuid,hand_number bigint,disposition text);"
  definitions+='CREATE TABLE IF NOT EXISTS smarter_private.hand_submission_dispositions(table_id uuid,hand_number bigint,permit_id uuid,disposition text,submission_id uuid,PRIMARY KEY(table_id,hand_number));'
  accepted_authority=json.loads((ROOT/'scripts/ci/fixtures/tournament-recovery20/accepted-original-authority.json').read_text())
  for f in accepted_authority['functions']:
   assert hashlib.md5(f['definition'].encode()).hexdigest()==f['md5']
   definitions+=f['definition']+';'
  definitions+='DROP TRIGGER IF EXISTS recovery20_actual_finish_guard ON smarter_private.f06_hand_permits;CREATE TRIGGER recovery20_actual_finish_guard BEFORE UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard();'
  sql_file(e,db,'captured-current-source-and-context',definitions)
  seed=(ROOT/'scripts/ci/probes/satellite-cancel-current-native.sql').read_text().split('-- Fund the source through')[0].replace('ON COMMIT DROP;','ON COMMIT PRESERVE ROWS;').replace('d3000000-0000-4000-8000-000000000002',EVENT)
  sql_file(e,db,'real-original-registration','BEGIN;'+seed+'COMMIT;')
  money_hash=prepare_quiesced(e,db,EVENT,OP,TABLE)
  e.sql(db,'GRANT EXECUTE ON FUNCTION smarter_private.tournament_abort_ingress(uuid) TO authenticated;',label='qualification-acl-drift-scene')
  rc,_,err=e.sql(db,file=MIGRATION,label='actual-migration-refuses-acl-drift',seconds=30,check=False)
  assert rc!=0 and 'recovery_owner_or_acl_changed' in err
  e.sql(db,'REVOKE EXECUTE ON FUNCTION smarter_private.tournament_abort_ingress(uuid) FROM authenticated;',label='restore-only-fixture-acl')
  _,rolled,_=e.sql(db,"SELECT to_regclass('smarter_private.tournament_abort_recoveries') IS NULL;",label='failed-install-no-partial-schema')
  assert rolled.strip()=='t'
  e.sql(db,file=MIGRATION,label='exact-recovery20-migration',seconds=30)
  refunded_call="public.fn_ca_withdraw_tournament_abort_for_original_recovery('"+OP+"','"+EVENT+"','13000000-0000-4000-8000-000000000001','1-1234abcd','"+GEN+"','1234567890123456789012345678901234567890','2026-10-31T15:00Z','12000000-0000-4000-8000-000000000001','00000000000000000000000000000000')"
  sql_file(e,db,'genuine-refund-cannot-be-resurrected',"BEGIN;"+AUTH+"SELECT public.fn_ca_settle_tournament_abort('"+OP+"','"+EVENT+"','"+money_hash+"');DO $$DECLARE refused boolean:=false;BEGIN IF NOT EXISTS(SELECT 1 FROM public.tournament_refund_tranches WHERE tournament_id='"+EVENT+"') THEN RAISE EXCEPTION 'actual old refund not exercised';END IF;BEGIN PERFORM "+refunded_call+";EXCEPTION WHEN SQLSTATE '55000' THEN refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'actual refunded event resurrected';END IF;END$$;ROLLBACK;")
  # Synthetic physical scene; real request/lease/refund/cancellation doors and
  # their deployed definitions are used. No claims about live native capture.
  scene="BEGIN;"+SERVICE+"SET LOCAL session_replication_role=replica;"
  scene+="UPDATE smarter_private.tournament_abort_targets SET state='stop_requested',quiescence=NULL,money_snapshot=NULL WHERE tournament_id='"+EVENT+"';"
  scene+="UPDATE public.engine_tournament_leases SET instance_id='1-1234abcd',heartbeat_at=clock_timestamp() WHERE tournament_id='"+EVENT+"';"
  scene+="DELETE FROM public.engine_leader;INSERT INTO public.engine_leader(id,instance_id,engine_version,heartbeat_at) VALUES(true,'1-1234abcd','12345678',clock_timestamp());DELETE FROM public.engine_maintenance_break;"
  steps=['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots'];shift=json.dumps(dict.fromkeys(steps,0)|{'complete':True})
  scene+="INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,thawed_at,release_target_at,thawed_by,contract_version,ownership_token,shifted) VALUES('2026-10-31T15:00Z',300,clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '5 minutes','12345678',3,'12000000-0000-4000-8000-000000000001','"+shift+"');"
  scene+="INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation) VALUES('ae000000-0000-4000-8000-000000000001','"+EVENT+"','"+TABLE+"',1,1000001,'af000000-0000-4000-8000-000000000001','"+GEN+"');"
  scene+="INSERT INTO smarter_private.hand_continuations SELECT '"+TABLE+"',1000001,'"+EVENT+"','ae000000-0000-4000-8000-000000000001','"+GEN+"','"+GEN+"',0,'{}',encode(extensions.digest('{}','sha256'),'hex'),clock_timestamp(),clock_timestamp();"
  scene+="UPDATE smarter_private.tournament_abort_boundaries SET existing_permits=(SELECT jsonb_agg(to_jsonb(p)) FROM smarter_private.f06_hand_permits p WHERE p.table_id='"+TABLE+"') WHERE tournament_id='"+EVENT+"';SET LOCAL session_replication_role=origin;COMMIT;"
  sql_file(e,db,'native-original-custody-and-own-thaw',scene)
  call="public.fn_ca_withdraw_tournament_abort_for_original_recovery('"+OP+"','"+EVENT+"','13000000-0000-4000-8000-000000000001','1-1234abcd','"+GEN+"','1234567890123456789012345678901234567890','2026-10-31T15:00Z','12000000-0000-4000-8000-000000000001',md5(smarter_private.tournament_recovery_original_custody('"+EVENT+"')::text))"
  def refuse(name,pre,expression=call,code='55000'):
   sql_file(e,db,name,"BEGIN;"+AUTH+pre+"DO $$DECLARE rejected boolean:=false;BEGIN BEGIN PERFORM "+expression+";EXCEPTION WHEN SQLSTATE '"+code+"' THEN rejected:=true;END;IF NOT rejected THEN RAISE EXCEPTION 'expected original recovery refusal';END IF;END$$;ROLLBACK;")
  refuse('browser-refused',"SELECT set_config('request.jwt.claim.role','authenticated',true);",code='42501')
  refuse('wrong-cohort-refused','',call.replace(EVENT,'d3000000-0000-4000-8000-000000000002'),code='22023')
  refuse('wrong-original-operation-refused','',call.replace(OP,'ac000000-0000-4000-8000-000000000001'),code='22023')
  refuse('settled-target-refused',"UPDATE smarter_private.tournament_abort_targets SET state='settled',settled_at=clock_timestamp() WHERE tournament_id='"+EVENT+"';")
  refuse('incomplete-own-thaw-refused',"UPDATE public.engine_maintenance_thaws SET shifted='{}';")
  refuse('wrong-thaw-owner-refused','',call.replace('12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002'))
  refuse('wrong-live-instance-refused','',call.replace('1-1234abcd','1-9999abcd'))
  refuse('changed-original-payload-refused',"UPDATE smarter_private.hand_continuations SET payload='changed';")
  refuse('missing-original-continuation-refused',"DELETE FROM smarter_private.hand_continuations;")
  sql_file(e,db,'reserved-original-admitted-before-withdrawal',"BEGIN;"+AUTH+"DO $$BEGIN IF public.fn_ca_operator_floor_state('"+TABLE+"')->'hold' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'circular original restoration prerequisite';END IF;END$$;ROLLBACK;")
  sql_file(e,db,'genuine-management-positive-without-jwt-spoof',"BEGIN;DO $$DECLARE r jsonb;BEGIN IF auth.role() IS NOT NULL OR session_user<>'postgres' THEN RAISE EXCEPTION 'not genuine fixture management';END IF;r:="+call+";IF r->>'state'<>'recovery' THEN RAISE EXCEPTION 'management path unavailable';END IF;END$$;ROLLBACK;")
  sql_file(e,db,'sd-current-user-cannot-authorize-authenticated-role',"BEGIN;SET LOCAL ROLE authenticated;DO $$DECLARE rejected boolean:=false;BEGIN BEGIN PERFORM "+call+";EXCEPTION WHEN SQLSTATE '42501' THEN rejected:=true;END;IF NOT rejected THEN RAISE EXCEPTION 'security definer authorized an authenticated caller';END IF;END$$;ROLLBACK;")
  # The original may lawfully finish before the operator arrives. The real
  # installed finish RPC and cleanup trigger consume the capsule; do not demand
  # a still-reserved hand or a private payload that must already be deleted.
  accepted_prefix="BEGIN;"+AUTH+"SET LOCAL session_replication_role=replica;INSERT INTO public.hand_history(id,table_id,tournament_id,hand_number,bbj_amount,reported) VALUES('14000000-0000-4000-8000-000000000001','"+TABLE+"','"+EVENT+"',1000001,0,false);INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,post_commit_completed_at,post_commit_result) VALUES('"+TABLE+"',1000001,'14000000-0000-4000-8000-000000000001','0000000000000000000000000000000000000000000000000000000000000000','{}',clock_timestamp(),'{\"ok\":true}');SET LOCAL session_replication_role=origin;SELECT public.fn_f06_finish_hand('"+EVENT+"','"+GEN+"','ae000000-0000-4000-8000-000000000001','accepted','14000000-0000-4000-8000-000000000001');"
  sql_file(e,db,'already-accepted-original-with-consumed-capsule-can-recover',accepted_prefix+"DO $$DECLARE r jsonb;BEGIN IF EXISTS(SELECT 1 FROM smarter_private.hand_continuations WHERE table_id='"+TABLE+"') THEN RAISE EXCEPTION 'real accepted cleanup not exercised';END IF;r:="+call+";IF r->>'state'<>'recovery' THEN RAISE EXCEPTION 'finished original timing deadlock';END IF;END$$;ROLLBACK;")
  for label,change in [
   ('accepted-missing-history-refused',"DELETE FROM public.hand_history WHERE table_id='"+TABLE+"';"),
   ('accepted-postcommit-unknown-refused',"UPDATE public.hand_atomic_commits SET post_commit_result='{}' WHERE table_id='"+TABLE+"';"),
   ('accepted-mismatched-evidence-refused',"UPDATE smarter_private.f06_hand_permits SET evidence_id='14000000-0000-4000-8000-000000000002' WHERE table_id='"+TABLE+"';")]:
   sql_file(e,db,label,accepted_prefix+"SET LOCAL session_replication_role=replica;"+change+"SET LOCAL session_replication_role=origin;DO $$DECLARE rejected boolean:=false;BEGIN BEGIN PERFORM "+call+";EXCEPTION WHEN SQLSTATE '55000' THEN rejected:=true;END;IF NOT rejected THEN RAISE EXCEPTION 'unproved original acceptance admitted';END IF;END$$;ROLLBACK;")
  # Concurrency uses the same existing cancellation authority, not a new lock.
  lane=module(ROOT/'scripts/ci/test-tournament-cancellation-lane.py','recovery20_lane')
  holder=lane.Session(e,db)
  try:
   holder.query("BEGIN;SELECT smarter_private.cancellation_lane('"+EVENT+"');SELECT tournament_id FROM smarter_private.tournament_abort_targets WHERE tournament_id='"+EVENT+"' FOR UPDATE;")
   refuse('concurrent-original-abort-lane-refused',"SET LOCAL lock_timeout='100ms';",code='55P03')
  finally:holder.close()
  sql_file(e,db,'old-repeatable-snapshot-cannot-hide-recovery',"BEGIN ISOLATION LEVEL REPEATABLE READ;"+AUTH+"DO $$DECLARE refused boolean:=false;BEGIN BEGIN PERFORM smarter_private.assert_tournament_abort_not_recovered('"+OP+"','"+EVENT+"');EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'operator_abort_read_committed_required' THEN RAISE;END IF;refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'repeatable snapshot accepted';END IF;END$$;ROLLBACK;")
  # Keep independent full preimages; only one additive disposition may change.
  snapshot="SELECT jsonb_build_object('target',(SELECT to_jsonb(a) FROM smarter_private.tournament_abort_targets a WHERE tournament_id='"+EVENT+"'),'money',smarter_private.tournament_abort_money_snapshot('"+EVENT+"'),'custody',smarter_private.tournament_recovery_original_custody('"+EVENT+"'));"
  _,before,_=e.sql(db,snapshot,label='original-full-before')
  sql_file(e,db,'recovery-rollback',"BEGIN;"+AUTH+"SELECT "+call+";ROLLBACK;")
  _,after,_=e.sql(db,snapshot,label='original-after-rollback');assert before.strip()==after.strip()
  sql_file(e,db,'recovery-commit',"BEGIN;"+AUTH+"SELECT "+call+";COMMIT;")
  sql_file(e,db,'same-idempotent-replay',"BEGIN;"+AUTH+"DO $$DECLARE r jsonb;BEGIN r:="+call+";IF r->>'already_recorded'<>'true' THEN RAISE EXCEPTION 'repeat not idempotent';END IF;END$$;COMMIT;")
  _,after,_=e.sql(db,snapshot,label='original-after-commit');assert before.strip()==after.strip()
  sql_file(e,db,'withdrawal-blocks-old-abort',"BEGIN;"+AUTH+"DO $$DECLARE r jsonb;rejected boolean:=false;BEGIN r:=public.fn_ca_tournament_abort_stop_state('"+OP+"','"+EVENT+"');IF r->>'state'<>'recovery' THEN RAISE EXCEPTION 'missing recovery disposition';END IF;PERFORM smarter_private.tournament_abort_ingress('"+EVENT+"');BEGIN PERFORM public.fn_ca_settle_tournament_abort('"+OP+"','"+EVENT+"','old');EXCEPTION WHEN SQLSTATE '55000' THEN rejected:=true;END;IF NOT rejected THEN RAISE EXCEPTION 'old abort remained actionable';END IF;END$$;ROLLBACK;")
  refuse('different-recovery-id-refused','',call.replace('13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002'),code='22023')
  sql_file(e,db,'recovery-disposition-is-immutable',"BEGIN;DO $$DECLARE rejected boolean:=false;BEGIN BEGIN UPDATE smarter_private.tournament_abort_recoveries SET recovery_id=gen_random_uuid() WHERE tournament_id='"+EVENT+"';EXCEPTION WHEN SQLSTATE '55000' THEN rejected:=true;END;IF NOT rejected THEN RAISE EXCEPTION 'recovery audit was mutable';END IF;END$$;ROLLBACK;")
  _,postimages,_=e.sql(db,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),'acl',p.proacl,'security_definer',p.prosecdef,'config',p.proconfig)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private') AND p.proname IN('fn_ca_withdraw_tournament_abort_for_original_recovery','assert_tournament_abort_not_recovered','tournament_abort_recovery_immutable','tournament_recovery_original_custody','fn_f06_begin_hand','fn_ca_operator_floor_state','fn_ca_tournament_abort_stop_state','fn_ca_ack_tournament_abort_boundary','fn_ca_settle_tournament_abort','assert_tournament_abort_quiesced','tournament_abort_ingress');",label='actual-recovery-contract-postimages')
  e.report['postimages']=json.loads(postimages.strip())
  for path in [Path(__file__),MIGRATION,BASE,ROOT/'scripts/ci/tournament_abort_fixture.py',ROOT/'scripts/ci/tournament_abort_native.py',ROOT/'scripts/ci/test-tournament-cancellation-lane.py',ROOT/'.github/scripts/tournament-original-recovery-control.mjs',ROOT/'.github/workflows/tournament-original-recovery-control.yml',ROOT/'tests/operations/tournament-original-recovery-control.test.mjs',tool,*sorted((ROOT/'scripts/ci/fixtures/tournament-recovery20').glob('*.json'))]:
   e.report['source_sha256'][str(path.relative_to(ROOT))]=hashlib.sha256(path.read_bytes()).hexdigest()
  e.report.update(passed=True,status='passed',cases=['exact-install','browser','wrong-cohort','wrong-operation','settled','own-v3-thaw','thaw-owner','live-instance','payload','missing-continuation','rollback','idempotent-replay','immutable-originals','old-abort-refused','identity-reuse','real-refunded-refused','concurrent-original-abort-lane','reserved-original-before-withdrawal','genuine-management-no-jwt-spoof','security-definer-not-authority','accepted-original-consumed-capsule','accepted-missing-history','accepted-incomplete-postcommit','accepted-mismatched-evidence','immutable-recovery-audit','repeatable-snapshot-abort-refusal','actual-install-acl-drift-rollback'])
 finally:
  e.close();(a.evidence/'recovery20-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
