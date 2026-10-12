#!/usr/bin/env python3
"""Bounded nativePG17 proof of qualified adaptive retirement. No production."""
import argparse,datetime,json,sys,hashlib,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012161830_horse_adaptive_raw_facts_become_exact_sufficient_statistics.sql')
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False);sock=Path('/Volumes/SmarterWork/agent-work/ahr-20261012-socket') if sys.platform=='darwin' else Path('/tmp');sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','adaptive_native');old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','adaptive_old');doors=module(ROOT/'scripts/ci/test-hand-submission-disposal.py','adaptive_doors')
 e=native.Execution(ROOT,out,a.pg_bin.resolve(),out,300,socket_parent=str(sock));e.report['source_sha256']={str(MIGRATION):sha(ROOT/MIGRATION)}
 checks=[]
 def yes(db,sql,label):
  _,v,_=e.sql(db,sql,label=label);assert v.strip()=='t',(label,v);checks.append(label)
 try:
  e.start();base=e.database();e.sql(base,file=ROOT/old.WORLD,label='original-world')
  e.sql(base,"ALTER TABLE public.tournaments ADD COLUMN bounty_pool numeric,ADD COLUMN bounty_pool_paid numeric; CREATE TABLE public.tournament_escrow(tournament_id uuid,closed_at timestamptz);",label='schema-supplement')
  e.sql(base,"CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();",label='immutable-binding')
  e.sql(base,doors.resume_base(ROOT),label='original-resume');e.sql(base,doors.snapshot_guard_base(ROOT),label='original-snapshot');e.sql(base,file=ROOT/old.DISPOSAL_MIGRATION,label='original-disposal')
  for name in ['20260921023215_unresolved_hand_permits_retain_their_original_hand_history.sql','20260925210126_the_boundary_they_wait_on_is_already_in_the_snapshot.sql']:
   files=list((ROOT/'supabase/migrations').glob(name[:14]+'*'));text=files[0].read_text();func='f06_hand_cards_unresolved' if '21023215' in name else 'f06_movement_boundary_retained';start=text.index('CREATE OR REPLACE FUNCTION smarter_private.'+func+'(');end=text.index('$function$;',start)+len('$function$;');e.sql(base,text[start:end],label=func)
  e.sql(base,old.prune_before(ROOT),label='original-prune');e.sql(base,file=ROOT/old.MIGRATION,label='original-retention');e.sql(base,file=ROOT/'scripts/verification-harness/horse-request-retention-prune-preimage.sql',label='prune-preimage')
  for name in ['20261012153428_settled_horse_request_payloads_age_out_with_their_history.sql','20261012154646_horse_history_retention_bounds_each_compaction_batch.sql','20261012161152_horse_retention_requires_original_no_human_evidence.sql','20260913170729_horse_adaptive_observation_journal.sql','20260913175935_recoverable_horse_adaptive_journal_batches.sql','20260913181841_durable_horse_adaptive_journal_work.sql','20260913193221_bounded_horse_adaptive_retention.sql','20260914113838_consume_journaled_horse_opponent_models.sql','20260927220647_journaled_model_store_reclaims_by_capacity_not_only_age.sql','20260927221452_journaled_model_finish_and_claim_are_engine_only.sql']:
   e.sql(base,file=ROOT/'supabase/migrations'/name,label=name[:14])
  seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb", "jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))").replace("interval '30 days'","interval '20 days'")+"\nUPDATE public.hand_history SET has_human=false;\n"
  _,n,_=e.sql(base,"SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",label='clock');now=int(n.strip())
  h=lambda s:hashlib.sha256(s.encode()).hexdigest();actor=h('actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope);session='00000001'+'c'*56;otherhand='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  facts=[json.dumps([1,old.HAND_ID+':'+str(i),old.HAND_ID,actor,session,now+i%2,'training',scopekey,scope,'call' if i<3 else 'bet',True,'horse_policy'],separators=(',',':')) for i in range(4)]
  human=json.dumps([1,otherhand+':0',otherhand,actor,session,now,'training',scopekey,scope,'raise',True,'player'],separators=(',',':'));rows=facts+[human];fromms=now-1000;toms=now+1000;source=h('source');batchkey=h('|'.join(['adaptive-journal-v1',actor,source,str(fromms),str(toms)]));payload=json.dumps([1,batchkey,actor,fromms,toms,source,[],rows],separators=(',',':'))
  def journal(db):e.sql(db,'SELECT fn_append_horse_adaptive_observations('+lit(payload)+');',label='append-original-batch')
  before=e.database(base);e.sql(before,seed,label='before-seed');journal(before);e.sql(before,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='before-history-prune');yes(before,"SELECT count(*)=4 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",'fail-before-journal-retains-expired-raw');e.discard(before)
  legacy=e.database(base);e.sql(legacy,seed,label='legacy-clock-seed')
  shifted=json.loads(payload);shifted[3]=fromms+3600000;shifted[4]=toms+3600000;shifted[5]=h('legacy-clock');shifted[1]=h('|'.join(['adaptive-journal-v1',actor,shifted[5],str(shifted[3]),str(shifted[4])]))
  e.sql(legacy,'SELECT fn_append_horse_adaptive_observations('+lit(json.dumps(shifted,separators=(',',':')))+');',label='legacy-actions-outside-source-window')
  e.sql(legacy,file=ROOT/MIGRATION,label='legacy-exact-candidate')
  e.sql(legacy,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');"+old.AUTHORITY+'SELECT sp_prune_hand_history(10); SELECT fn_prune_horse_adaptive_journal();',label='legacy-membership-before-retirement')
  yes(legacy,"SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"') AND NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_batches WHERE canonical_payload LIKE '%"+old.HAND_ID+"%') AND EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='"+otherhand+"');",'exact-membership-protects-legacy-mismatched-clocks');e.discard(legacy)
  e.sql(base,file=ROOT/MIGRATION,label='exact-adaptive-migration');code,_,err=e.sql(base,file=ROOT/MIGRATION,label='replay-refused',check=False);assert code!=0 and 'ADAPTIVE_RETENTION_PREIMAGE_CHANGED' in err;checks.append('migration-replay-refused')
  after=e.database(base);e.sql(after,seed,label='after-seed');journal(after)
  # Disabled until a serving new consumer is proven. Original request compaction
  # remains eligible and captures its durable exact classification certificate.
  e.sql(after,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='capture-before-activation')
  yes(after,"SELECT request='{}'::jsonb AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=submission_id AND retired_at IS NULL) FROM smarter_private.hand_submissions;",'request-independent-certificate-captured')
  yes(after,"SELECT smarter_private.horse_adaptive_disposal_certificate_matches(submission_id,table_id,hand_number,request_hash) FROM smarter_private.hand_submissions;",'immutable-certificate-matches-after-request-erasure')
  for operation,query in [('mutate',"UPDATE smarter_private.horse_adaptive_disposal_certificates SET certificate=certificate||'{\"original_horse_only\":false}'::jsonb;"),('delete','DELETE FROM smarter_private.horse_adaptive_disposal_certificates;'),('truncate','TRUNCATE smarter_private.horse_adaptive_disposal_certificates;')]:
   code,_,err=e.sql(after,query,label='certificate-'+operation+'-refused',check=False);assert code!=0 and 'ADAPTIVE_DISPOSAL_CERTIFICATE_IMMUTABLE' in err;checks.append('certificate-'+operation+'-refused')
  code,_,err=e.sql(after,"INSERT INTO smarter_private.horse_adaptive_disposal_certificates SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',repeat('0',64),table_id,hand_number,request_hash,clock_timestamp(),NULL,certificate FROM smarter_private.horse_adaptive_disposal_certificates;",label='certificate-forged-insert-refused',check=False);assert code!=0 and 'ADAPTIVE_DISPOSAL_CERTIFICATE_UNQUALIFIED' in err;checks.append('certificate-forged-insert-refused')
  yes(after,"SELECT count(*)=4 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",'disabled-consumer-protects-raw')
  e.sql(after,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"'); SELECT fn_prune_horse_adaptive_journal();",label='enable-and-existing-prune')
  yes(after,"SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"') AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=4 AND (SELECT count(*) FROM smarter_private.horse_adaptive_observation_fences)=4;",'raw-erased-statistics-and-fences-exact')
  yes(after,"SELECT payload="+lit(human)+" FROM horse_adaptive_observation_journal WHERE hand_id='"+otherhand+"';",'other-human-raw-byte-identical')
  yes(after,"SELECT batch_digest="+lit(h(payload))+" AND retention_compacted AND NOT(canonical_payload LIKE '%"+old.HAND_ID+"%') AND canonical_payload::jsonb->7=jsonb_build_array("+lit(human)+") FROM horse_adaptive_observation_batches WHERE batch_key="+lit(batchkey)+";",'partial-batch-preserves-human-and-original-digest')
  yes(after,'SELECT fn_horse_adaptive_journal_batch('+lit(batchkey)+")->>'reason'='retention_compacted';",'recovery-explicitly-compacted')
  journal(after);yes(after,"SELECT (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=4 AND (SELECT count(*) FROM horse_adaptive_observation_journal)=1;",'exact-batch-replay-no-double-count')
  changed=json.loads(payload);changed[1]=h('different-key'); # must remain validkey: different source digest
  changed[5]=h('different-source');changed[1]=h('|'.join(['adaptive-journal-v1',actor,changed[5],str(fromms),str(toms)]));changedpayload=json.dumps(changed,separators=(',',':'))
  e.sql(after,'SELECT fn_append_horse_adaptive_observations('+lit(changedpayload)+');',label='different-batch-exact-facts-replay')
  yes(after,"SELECT count(*)=1 FROM horse_adaptive_observation_journal;",'different-batch-cannot-reinsert-raw')
  changed[7][0]=changed[7][0].replace('"call"','"raise"');changed[5]=h('conflict-source');changed[1]=h('|'.join(['adaptive-journal-v1',actor,changed[5],str(fromms),str(toms)]));code,_,err=e.sql(after,'SELECT fn_append_horse_adaptive_observations('+lit(json.dumps(changed,separators=(',',':')))+');',label='different-payload-refused',check=False);assert code!=0 and 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' in err;checks.append('retired-observation-different-payload-refused')
  e.sql(after,'SELECT fn_prune_horse_adaptive_journal();',label='repeat-prune');yes(after,"SELECT sum(observations)=4 FROM smarter_private.horse_adaptive_statistics;",'compaction-idempotent')
  _,claim,_=e.sql(after,"SELECT fn_claim_horse_journaled_model_statistics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');",label='versioned-claim');c=json.loads(claim);assert c['version']==2 and c['observations']==5 and len(c['rows'])==1 and sum(json.loads(x)[9] for x in c['statistics'])==4;checks.append('versioned-snapshot-counts-represented-facts')
  (out/'claim.json').write_text(json.dumps(c));runner=out/'consume.mjs';runner.write_text("import {readFileSync,writeFileSync} from 'node:fs'; import {buildJournaledOpponentReport} from "+json.dumps((ROOT/'server/src/services/HorseJournaledOpponentModels.ts').as_uri())+"; const c=JSON.parse(readFileSync("+json.dumps(str(out/'claim.json'))+",'utf8')); const r=buildJournaledOpponentReport(c,c.leaseToken,'"+'a'*40+"'); if(r.status!=='prepared') throw Error(JSON.stringify(r)); writeFileSync("+json.dumps(str(out/'report.json'))+",JSON.stringify(r.report)); process.exit(0);")
  subprocess.run(['node','--import',str(ROOT/'server/node_modules/tsx/dist/loader.mjs'),str(runner)],check=True,cwd=ROOT,timeout=30);report=(out/'report.json').read_text();yes(after,"SELECT fn_finish_horse_journaled_model_statistics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',"+lit(report)+")->>'status'='recorded';",'native-claim-real-consumer-fenced-finish')
  yes(after,"SELECT NOT has_function_privilege('service_role','smarter_private.retire_horse_adaptive_hand(uuid)','EXECUTE') AND NOT has_table_privilege('service_role','smarter_private.horse_adaptive_statistics','SELECT');",'service-cannot-mutate-stats-or-retirement')
  e.discard(after)
  # Durable uncompleted work is a real dependency, not erased by an age-only
  # prune. Its original fenced finish removes the hold, after which the same
  # existing retention owner retires the already-classified hand.
  case=e.database(base);e.sql(case,seed,label='unfinished-seed');journal(case)
  e.sql(case,'SELECT fn_queue_horse_adaptive_batch('+lit(payload)+');',label='queue-original-work')
  e.sql(case,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');"+old.AUTHORITY+'SELECT sp_prune_hand_history(10); SELECT fn_prune_horse_adaptive_journal();',label='unfinished-prune')
  yes(case,"SELECT count(*)=4 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",'unfinished-work-preserves-raw')
  e.sql(case,"SELECT fn_claim_horse_adaptive_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc'); SELECT fn_finish_horse_adaptive_batch("+lit(batchkey)+",'cccccccc-cccc-4ccc-8ccc-cccccccccccc','recorded'); SELECT fn_prune_horse_adaptive_journal();",label='original-work-completed-then-prune')
  yes(case,"SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"') AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=4;",'original-fenced-completion-unblocks-retirement')
  e.discard(case)
  case=e.database(base);e.sql(case,seed,label='quarantine-seed');journal(case)
  e.sql(case,'SELECT fn_queue_horse_adaptive_batch('+lit(payload)+"); UPDATE horse_adaptive_journal_work SET state='quarantined';",label='quarantined-work')
  e.sql(case,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');"+old.AUTHORITY+'SELECT sp_prune_hand_history(10); SELECT fn_prune_horse_adaptive_journal();',label='quarantine-prune')
  yes(case,"SELECT count(*)=4 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",'quarantined-work-preserves-raw')
  e.discard(case)
  case=e.database(base);e.sql(case,seed,label='contention-seed');journal(case)
  # Two native sessions, one finite lock holder. No production/background job.
  lock=subprocess.Popen([str(a.pg_bin/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',case,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  lock.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)); SELECT 'locked'; SELECT pg_sleep(2); ROLLBACK;\n");lock.stdin.close()
  while lock.stdout.readline().strip()!='locked':
   if lock.poll() is not None:raise RuntimeError('native lock was not acquired')
  yes(case,"SELECT fn_prune_horse_adaptive_journal()->>'reason'='capacity_busy';",'nonwaiting-original-capacity-lock')
  code,_,err=e.sql(case,'SELECT fn_append_horse_adaptive_observations('+lit(payload)+');',label='append-refuses-contention',check=False);assert code!=0 and 'ADAPTIVE_RETENTION_BUSY' in err;checks.append('append-and-retirement-share-capacity-reservation')
  lock.wait(timeout=10);assert lock.returncode==0;e.discard(case)
  for name,change in [('human',"UPDATE public.profiles SET is_horse=false;"),('unknown',"DELETE FROM public.profiles;"),('young',"UPDATE public.hand_history SET created_at=now();"),('incomplete',"UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL;"),('failed-postcommit',"UPDATE public.hand_atomic_commits SET post_commit_result='{\"ok\":false}'::jsonb;"),('reported',"UPDATE public.hand_history SET reported=true;"),('mixed',"UPDATE public.hand_history SET has_human=true;"),('original-unknown',"UPDATE public.hand_history SET has_human=NULL;")]:
   case=e.database(base);e.sql(case,seed+change,label=name+'-seed');journal(case);e.sql(case,"UPDATE horse_adaptive_observation_journal SET recorded_at=now()-interval '40 days' WHERE hand_id='"+old.HAND_ID+"';",label=name+'-historical-clock');e.sql(case,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');"+old.AUTHORITY+'SELECT sp_prune_hand_history(10); SELECT fn_prune_horse_adaptive_journal();',label=name+'-prune');yes(case,"SELECT count(*)=4 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",name+'-raw-preserved');e.discard(case)
  _,catalog,_=e.sql(base,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text)) FROM pg_proc p WHERE p.proname IN ('fn_prune_horse_adaptive_journal','fn_append_horse_adaptive_observations','fn_horse_adaptive_journal_batch','fn_queue_horse_adaptive_batch','fn_claim_horse_journaled_model_statistics','fn_finish_horse_journaled_model_statistics','compact_settled_horse_requests','retire_horse_adaptive_hand','capture_horse_adaptive_disposals','enable_horse_adaptive_retention','adaptive_retained_batch','horse_adaptive_disposal_certificate_matches','horse_adaptive_disposal_certificate_immutable','register_horse_adaptive_batch_membership','horse_adaptive_batch_membership_on_append','horse_adaptive_raw_retirement_fence');",label='exact-postimage-metadata');e.report['qualified_postimages']=json.loads(catalog)
  e.discard(base);e.report.update(status='passed',proven=checks)
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(status='failed',cleanup_failure=repr(exc))
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
