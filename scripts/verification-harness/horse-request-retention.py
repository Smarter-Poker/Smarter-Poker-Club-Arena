#!/usr/bin/env python3
"""Isolated PostgreSQL 17 qualification of original horse-request erasure.
Uses existing retained hand world/doors and captured installed prune definition.
No production connection. All scratch/socket directories are on supplied SSD.
"""
import argparse, datetime, json, sys
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha
MIGRATION=Path('supabase/migrations/20261012153428_settled_horse_request_payloads_age_out_with_their_history.sql')
BOUND=Path('supabase/migrations/20261012154646_horse_history_retention_bounds_each_compaction_batch.sql')
PRUNE=Path('scripts/verification-harness/horse-request-retention-prune-preimage.sql')
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 # Keep Unix socket pathname below PostgreSQL's 104-byte limit, on SSD.
 sock=out.parent/'sock';sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','horse_request_execution')
 old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','horse_request_old')
 doors=module(ROOT/'scripts/ci/test-hand-submission-disposal.py','horse_request_doors')
 e=native.Execution(ROOT,out,a.pg_bin.resolve(),out,300,socket_parent=str(sock))
 e.report['source_sha256']={str(x):sha(ROOT/x) for x in [MIGRATION,BOUND,PRUNE,Path(__file__).relative_to(ROOT),old.WORLD]}
 try:
  e.start();base=e.database();e.sql(base,file=ROOT/old.WORLD,label='existing-original-world')
  e.sql(base,"ALTER TABLE public.tournaments ADD COLUMN bounty_pool numeric, ADD COLUMN bounty_pool_paid numeric; CREATE TABLE public.tournament_escrow(tournament_id uuid,closed_at timestamptz);",label='current-retention-schema-supplement')
  e.sql(base,"CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable(); CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();",label='original-submission-trigger-bindings')
  e.sql(base,doors.resume_base(ROOT),label='original-resume');e.sql(base,doors.snapshot_guard_base(ROOT),label='original-snapshot')
  e.sql(base,file=ROOT/old.DISPOSAL_MIGRATION,label='recorded-disposal')
  unresolved=(ROOT/'supabase/migrations/20260921023215_unresolved_hand_permits_retain_their_original_hand_history.sql').read_text();start=unresolved.index('CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved(');end=unresolved.index('$function$;',start)+len('$function$;');e.sql(base,unresolved[start:end],label='real-unresolved-permit-helper')
  movement=next((ROOT/'supabase/migrations').glob('20260925210126*')).read_text();start=movement.index('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained(');end=movement.index('$function$;',start)+len('$function$;');e.sql(base,movement[start:end],label='real-movement-boundary-helper')
  e.sql(base,old.prune_before(ROOT),label='prune-original')
  e.sql(base,file=ROOT/old.MIGRATION,label='recorded-retention')
  e.sql(base,file=ROOT/PRUNE,label='installed-prune-preimage')
  seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb", "jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")
  unfixed=e.database(base);e.sql(unfixed,seed,label='before-seed');e.sql(unfixed,old.AUTHORITY+'SELECT public.sp_prune_hand_history(10);',label='before-prune')
  _,actual,_=e.sql(unfixed,"SELECT request<>'{}'::jsonb FROM smarter_private.hand_submissions;",label='before-retains-payload')
  assert actual.strip()=='t';e.discard(unfixed)
  e.sql(base,file=ROOT/MIGRATION,label='exact-candidate-migration')
  code,_,err=e.sql(base,file=ROOT/MIGRATION,label='replay-refused',check=False)
  assert code!=0 and 'HORSE_REQUEST_RETENTION_ALREADY_INSTALLED' in err
  e.sql(base,file=ROOT/BOUND,label='exact-bounded-batch-migration')
  _,definition,_=e.sql(base,"SELECT pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);",label='bounded-batch-source');assert definition.count('LIMIT LEAST(GREATEST(p_batch,1),250)')==1 and 'LIMIT p_batch' not in definition
  code,_,err=e.sql(base,file=ROOT/BOUND,label='bounded-migration-replay-refused',check=False);assert code!=0 and 'HORSE_RETENTION_BATCH_SOURCE_CHANGED_OR_ALREADY_INSTALLED' in err
  after=e.database(base);e.sql(after,seed,label='after-seed')
  _,original_identity,_=e.sql(after,"SELECT to_jsonb(s)-'request' FROM smarter_private.hand_submissions s;",label='original-identity')
  e.sql(after,old.AUTHORITY+'SELECT public.sp_prune_hand_history(5000);',label='after-prune')
  _,actual,_=e.sql(after,"SELECT request='{}'::jsonb AND request_hash IS NOT NULL FROM smarter_private.hand_submissions;",label='after-erasure')
  assert actual.strip()=='t'
  _,final_identity,_=e.sql(after,"SELECT to_jsonb(s)-'request' FROM smarter_private.hand_submissions s;",label='retained-identity');assert json.loads(final_identity)==json.loads(original_identity)
  e.sql(after,old.freed('compacted-horse'),label='resume-stays-closed')
  _,actual,_=e.sql(after,"SELECT smarter_private.compact_settled_horse_requests(ARRAY['"+old.HAND_ID+"'::uuid]);",label='idempotent');assert actual.strip()=='0'
  for name,sql in [('identity',"UPDATE smarter_private.hand_submissions SET instance_id='forged';"),('restore',"UPDATE smarter_private.hand_submissions SET request='{\"p_stacks\":[]}'::jsonb;"),('delete','DELETE FROM smarter_private.hand_submissions;'),('truncate','TRUNCATE smarter_private.hand_submissions;')]:
   code,_,err=e.sql(after,sql,label='reject-'+name,check=False);assert code!=0 and 'HAND_SUBMISSION_IMMUTABLE' in err
  e.discard(after)
  for name,change in [('human',"UPDATE public.profiles SET is_horse=false;"),('unknown',"DELETE FROM public.profiles;"),('young',"UPDATE public.hand_history SET created_at=now();"),('incomplete',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL;"),('recently-settled',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=now();"),('reported',"UPDATE public.hand_history SET reported=true;"),('reserved',"INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES('9b600000-0000-4000-8000-000000000001','9b600000-0000-4000-8000-000000000002','"+old.TABLE+"',1,"+str(old.HAND_NUMBER)+",'9b600000-0000-4000-8000-000000000003','"+old.DEAD_GEN+"','reserved');")]:
   case=e.database(base);e.sql(case,seed,label=name+'-seed');e.sql(case,change,label=name+'-change')
   e.sql(case,old.AUTHORITY+'SELECT public.sp_prune_hand_history(10);',label=name+'-prune')
   _,actual,_=e.sql(case,"SELECT request<>'{}'::jsonb FROM smarter_private.hand_submissions;",label=name+'-retained');assert actual.strip()=='t';e.discard(case)
  case=e.database(base)
  e.sql(case,"BEGIN;"+seed.replace("interval '30 days'", "interval '8 days'")+old.AUTHORITY+"SELECT public.sp_prune_hand_history(10); SELECT request<>'{}'::jsonb FROM smarter_private.hand_submissions; COMMIT;",label='exact-eight-day-boundary')
  _,actual,_=e.sql(case,"SELECT request<>'{}'::jsonb FROM smarter_private.hand_submissions;",label='boundary-retained');assert actual.strip()=='t';e.discard(case)
  for name,change in [('mixed-human',"INSERT INTO public.profiles(id,is_horse) VALUES('9b700000-0000-4000-8000-000000000001',false); UPDATE public.hand_history SET players=players||jsonb_build_array(jsonb_build_object('userId','9b700000-0000-4000-8000-000000000001'));"),('unpaid-tournament',"INSERT INTO public.tournaments(id,variant,tournament_type,status,bounty_pool,bounty_pool_paid) VALUES('9b700000-0000-4000-8000-000000000002','pko','MTT','COMPLETED',10,0); UPDATE public.tables SET tournament_id='9b700000-0000-4000-8000-000000000002'; UPDATE public.hand_history SET tournament_id='9b700000-0000-4000-8000-000000000002';"),('open-escrow',"INSERT INTO public.tournaments(id,variant,tournament_type,status,bounty_pool,bounty_pool_paid) VALUES('9b700000-0000-4000-8000-000000000002','pko','MTT','COMPLETED',0,0); INSERT INTO public.tournament_escrow VALUES('9b700000-0000-4000-8000-000000000002',NULL); UPDATE public.tables SET tournament_id='9b700000-0000-4000-8000-000000000002'; UPDATE public.hand_history SET tournament_id='9b700000-0000-4000-8000-000000000002';")]:
   case=e.database(base);e.sql(case,seed+change,label=name+'-seed');e.sql(case,old.AUTHORITY+'SELECT public.sp_prune_hand_history(10);',label=name+'-prune')
   _,actual,_=e.sql(case,"SELECT EXISTS(SELECT 1 FROM public.hand_history) AND EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE request<>'{}'::jsonb);",label=name+'-retained');assert actual.strip()=='t';e.discard(case)
  case=e.database(base);e.sql(case,seed,label='forbidden-change-seed')
  code,_,err=e.sql(case,"UPDATE smarter_private.hand_submissions SET request='{}'::jsonb;",label='unqualified-erasure-refused',check=False);assert code!=0 and 'HAND_SUBMISSION_IMMUTABLE' in err
  code,_,err=e.sql(case,"SET ROLE service_role; SELECT smarter_private.compact_settled_horse_requests(ARRAY[]::uuid[]);",label='unauthorized-helper-refused',check=False);assert code!=0 and 'permission denied' in err
  e.discard(case)
  for name,proof in [('legacy-completion-unknown',"'{}'::jsonb"),('hash-mismatch',"jsonb_build_object('settlement_completed',true,'settlement_completed_at',now()-interval '30 days','request_hash',repeat('0',64))"),('malformed-age',"jsonb_build_object('settlement_completed',true,'settlement_completed_at','not-a-timestamp')")]:
   case=e.database(base);e.sql(case,seed,label=name+'-seed')
   receipt="INSERT INTO smarter_private.hand_submission_disposals(table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected) SELECT s.table_id,s.hand_number,s.submission_id,md5('probe:'||s.submission_id::text)::uuid,s.hand_number,'A native historical proof probe preserves unclear original settlement evidence.',jsonb_build_object('kind','retention_pruned_settled_hand','settled',true,'table_id',s.table_id,'hand_number',s.hand_number,'submission_id',s.submission_id,'pruned_hand_id',s.submission_id,'request_hash',s.request_hash,'hand_created_at',h.created_at)||"+proof+" FROM smarter_private.hand_submissions s JOIN public.hand_history h ON h.id=s.submission_id;"
   e.sql(case,receipt,label=name+'-receipt')
   _,actual,_=e.sql(case,"SELECT smarter_private.compact_settled_horse_requests(ARRAY['"+old.HAND_ID+"'::uuid]);",label=name+'-compaction-refused');assert actual.strip()=='0'
   code,_,err=e.sql(case,"UPDATE smarter_private.hand_submissions SET request='{}'::jsonb;",label=name+'-direct-erasure-refused',check=False);assert code!=0 and 'HAND_SUBMISSION_IMMUTABLE' in err;e.discard(case)
  _,catalog,_=e.sql(base,"SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.oid=ANY(ARRAY['smarter_private.hand_submission_immutable()'::regprocedure,'smarter_private.hand_submission_retention_disposal(uuid[],text)'::regprocedure,'public.sp_prune_hand_history(integer)'::regprocedure,'smarter_private.horse_request_payload_disposable(uuid)'::regprocedure,'smarter_private.compact_settled_horse_requests(uuid[])'::regprocedure]);",label='qualified-postimage-catalog');e.report['qualified_postimage_md5']=json.loads(catalog)
  case=e.database(base);e.sql(case,seed+"INSERT INTO public.tournaments(id,variant,tournament_type,status) VALUES('9b800000-0000-4000-8000-000000000001','nlh','MTT','RUNNING'); UPDATE public.tables SET tournament_id='9b800000-0000-4000-8000-000000000001'; UPDATE public.hand_history SET tournament_id='9b800000-0000-4000-8000-000000000001';",label='movement-boundary-seed')
  _,actual,_=e.sql(case,"SELECT smarter_private.f06_movement_boundary_retained('"+old.TABLE+"'::uuid,"+str(old.HAND_NUMBER)+");",label='real-movement-boundary-is-held');assert actual.strip()=='t'
  e.sql(case,old.AUTHORITY+'SELECT public.sp_prune_hand_history(10);',label='movement-boundary-prune')
  _,actual,_=e.sql(case,"SELECT EXISTS(SELECT 1 FROM public.hand_history) AND EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE request<>'{}'::jsonb);",label='movement-boundary-retained');assert actual.strip()=='t';e.discard(case)
  e.discard(base);e.report['proven']=['fail-before-payload-retained','pass-after-payload-erased','identity-and-hash-preserved','resume-remains-closed','compaction-idempotent','installed-migration-replay-refused','forbidden-identity-change','forbidden-payload-restoration','forbidden-delete','forbidden-truncate','human-retained','unknown-player-retained','young-hand-retained','incomplete-postcommit-retained','reported-hand-retained','reserved-permit-retained','recently-settled-old-hand-retained','exact-eight-day-boundary-retained','mixed-human-retained','unpaid-tournament-retained','open-escrow-retained','unqualified-erasure-refused','unauthorized-helper-refused','legacy-completion-unknown-retained','hash-mismatch-retained','malformed-age-retained','real-movement-boundary-retained','bounded-candidate-source','bounded-migration-replay-refused','large-requested-batch-preserves-qualification'];e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(status='failed',cleanup_failure=repr(exc))
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
