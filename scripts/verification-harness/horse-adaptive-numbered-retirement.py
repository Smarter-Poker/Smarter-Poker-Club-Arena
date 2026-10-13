#!/usr/bin/env python3
"""Native actual ICU en-US proof of numbered original adaptive retirement."""
from pathlib import Path
import argparse,datetime,json,hashlib,sys,subprocess,uuid
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261013130413_horse_journal_retirement_follows_original_numbered_observati.sql')
def qualify(e,template):
 checks=[];d=e.database(template)
 def read(db,q,label):return e.sql(db,q,label=label)[1].strip()
 def yes(db,q,label):assert read(db,q,label)=='t',label;checks.append(label)
 old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','numbered_original_hands')
 adaptive=module(ROOT/'scripts/verification-harness/horse-adaptive-statistics-retention.py','numbered_model')
 # This database is initialized with the actual production ICU locale, not a
 # column coercion which could miss the existing index's collation.
 yes(d,"SELECT datlocprovider='i' AND datlocale='en-US' FROM pg_database WHERE datname=current_database();",'actual-production-ICU-en-US')
 yes(d,"SELECT bool_and(v>=('"+old.HAND_ID+":0') AND v<=('"+old.HAND_ID+":9999') AND v COLLATE \"C\">=('"+old.HAND_ID+":0') COLLATE \"C\" AND v COLLATE \"C\"<=('"+old.HAND_ID+":9999') COLLATE \"C\") FROM (SELECT '"+old.HAND_ID+":'||n::text v FROM generate_series(0,4095)n)s;",'all4096-original-admitted-numbered-IDs-in-ICU-and-C-bounds')
 yes(d,"SELECT '"+old.HAND_ID+":30' >= '"+old.HAND_ID+":' AND NOT('"+old.HAND_ID+":30' < '"+old.HAND_ID+";');",'fail-before-original-punctuation-sentinel')
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))").replace("interval '30 days'","interval '20 days'")+"UPDATE hand_history SET has_human=false;"
 h=lambda s:hashlib.sha256(s.encode()).hexdigest();actor=h('numbered-actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope)
 now=int(read(d,"SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",'original-clock'))
 human='9b200000-0000-4000-8000-000000000002'
 facts=[json.dumps([1,old.HAND_ID+':'+str(n),old.HAND_ID,actor,'00000001'+'c'*56,now+n,'training',scopekey,scope,'call',True,'horse_policy'],separators=(',',':')) for n in [3,30,100]]
 hf=json.dumps([1,human+':3',human,actor,'00000001'+'c'*56,now+3,'training',scopekey,scope,'raise',True,'player'],separators=(',',':'))
 def batch(source,rows):
  digest=h(source);key=h('|'.join(['adaptive-journal-v1',actor,digest,str(now-1000),str(now+5000)]))
  return key,json.dumps([1,key,actor,now-1000,now+5000,digest,[],rows],separators=(',',':'))
 key,payload=batch('numbered-original',facts+[hf])
 e.sql(d,seed+'SELECT fn_append_horse_adaptive_observations('+lit(payload)+');'+old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal(ARRAY['"+old.HAND_ID+"']::uuid[],'Native original qualified numbered observation retirement');",label='genuine-original-admission-and-settled-disposal')
 yes(d,"SELECT smarter_private.horse_adaptive_disposal_certificate_matches(hand_id,table_id,hand_number,request_hash) AND retired_at IS NULL FROM smarter_private.horse_adaptive_disposal_certificates;",'genuine-eight-day-completed-horse-certificate')
 e.sql(d,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"'); SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"');",label='actual-old-owner-false-retirement')
 yes(d,"SELECT (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"')=3 AND (SELECT count(*) FROM smarter_private.horse_adaptive_statistics)=0 AND (SELECT count(*) FROM smarter_private.horse_adaptive_observation_fences)=0 AND (SELECT retired_at IS NOT NULL FROM smarter_private.horse_adaptive_disposal_certificates);",'fail-before-actual-raw-survives-false-retirement')
 original_cert=read(d,'SELECT to_jsonb(c)::text FROM smarter_private.horse_adaptive_disposal_certificates c;','immutable-before-recovery')
 original_prune=read(d,"SELECT pg_get_functiondef('fn_prune_horse_adaptive_journal()'::regprocedure);",'original-chronological-owner-preimage')
 falseworld=e.database(d)
 e.sql(d,"UPDATE smarter_private.horse_adaptive_retention_activation SET enabled=false;",label='original-activation-native-hold')
 e.sql(d,file=ROOT/MIGRATION,label='qualified-forward-correction')
 corrected_prune=read(d,"SELECT pg_get_functiondef('fn_prune_horse_adaptive_journal()'::regprocedure);",'corrected-chronological-owner-postimage')
 reversed_prune=corrected_prune.replace('WHERE (retired_at IS NULL OR raw_format_version<2)','WHERE retired_at IS NULL').replace('WHERE hand_id=candidate.hand_id AND retired_at IS NOT NULL AND raw_format_version=2','WHERE hand_id=candidate.hand_id AND retired_at IS NOT NULL')
 assert reversed_prune==original_prune;checks.append('only-pending-predicates-and-authoritative-format-report-condition-changed')
 yes(d,"SELECT NOT enabled AND scan_after_hand_id IS NULL AND scan_through_hand_id IS NULL AND consumer_release='"+'a'*40+"' FROM smarter_private.horse_adaptive_retention_activation;",'inactive-original-cursor-reset-consumer-retained')
 status,_,err=e.sql(d,file=ROOT/MIGRATION,label='forward-replay-refused',check=False);assert status and 'ADAPTIVE_NUMBERED_RETIREMENT_PREIMAGE_CHANGED_OR_ENABLED' in err;checks.append('forward-replay-refused')
 yes(d,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=0 AND (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"')=3;",'disabled-original-owner-preserves-falsely-retired-raw')
 e.sql(d,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='native-qualified-consumer-enable')
 # Rollback verifies the full owner transition remains atomic.
 e.sql(d,"BEGIN;SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"');ROLLBACK;",label='native-original-owner-rollback')
 yes(d,"SELECT count(*)=3 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"';",'rollback-restores-raw-and-statistics')
 yes(d,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=3;",'same-original-owner-completes-falsely-retired-raw')
 assert read(d,"SELECT (to_jsonb(c)-'raw_format_version')::text FROM smarter_private.horse_adaptive_disposal_certificates c;",'immutable-after-recovery')==original_cert;checks.append('original-certificate-and-retired-time-byte-exact')
 yes(d,'SELECT raw_format_version=2 FROM smarter_private.horse_adaptive_disposal_certificates;','correct-original-format-completion-recorded')
 yes(d,"SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"') AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=3 AND (SELECT count(*) FROM smarter_private.horse_adaptive_observation_fences)=3;",'nonempty-original-raw-becomes-exact-statistics-and-fences')
 yes(d,"SELECT payload="+lit(hf)+" FROM horse_adaptive_observation_journal WHERE hand_id='"+human+"';",'adjacent-human-original-byte-identical')
 yes(d,"SELECT canonical_payload::jsonb->7=jsonb_build_array("+lit(hf)+") AND batch_digest="+lit(h(payload))+" AND retention_compacted AND retention_membership_ready FROM horse_adaptive_observation_batches WHERE batch_key="+lit(key)+";",'original-human-batch-and-replay-digest-preserved')
 yes(d,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=0 AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=3;",'correct-retirement-repeat-noop-no-double-statistics')
 newkey,newpayload=batch('numbered-exact-replay',facts+[hf]);e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(newpayload)+');',label='new-batch-original-exact-observation-replay')
 yes(d,"SELECT count(*)=1 AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=3 FROM horse_adaptive_observation_journal;",'exact-replay-cannot-reinsert-retired-raw')
 bad=list(facts);bad[0]=bad[0].replace('"call"','"bet"');_,badpayload=batch('numbered-conflict',bad)
 status,_,err=e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(badpayload)+');',label='conflicting-retired-observation-refused',check=False);assert status and 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' in err;checks.append('changed-replay-refused')
 _,claim,_=e.sql(d,"SELECT fn_claim_horse_journaled_model_statistics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');",label='actual-statistics-model-claim')
 claim=json.loads(claim);assert claim['observations']==4 and len(claim['rows'])==1 and sum(json.loads(x)[9] for x in claim['statistics'])==3;checks.append('real-claim-counts-all-retired-observations')
 consumer_out=e.output/'numbered-consumer';consumer_out.mkdir()
 consumer_out.joinpath('claim.json').write_text(json.dumps(claim));report=adaptive.consume_report(ROOT,consumer_out)
 yes(d,"SELECT fn_finish_horse_journaled_model_statistics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',"+lit(report)+")->>'status'='recorded';",'real-engine-consumer-and-fenced-model-finish')
 # Fresh pending certificate still cannot be falsely marked retired while raw
 # exists. Native genuine old-state world is restored through its own template,
 # without editing certificate/time to turn it pending.
 fresh=e.database(template);e.sql(fresh,seed+'SELECT fn_append_horse_adaptive_observations('+lit(payload)+');'+old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal(ARRAY['"+old.HAND_ID+"']::uuid[],'Native fresh original qualified numbered observation retirement');",label='fresh-genuine-original-certificate')
 e.sql(fresh,file=ROOT/MIGRATION,label='fresh-forward-correction')
 e.sql(fresh,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='fresh-consumer-enable')
 status,_,err=e.sql(fresh,"UPDATE smarter_private.horse_adaptive_disposal_certificates SET retired_at=clock_timestamp(),raw_format_version=2;",label='guard-refuses-false-zero-raw',check=False);assert status and 'ADAPTIVE_DISPOSAL_CERTIFICATE_IMMUTABLE' in err;checks.append('correct-immutable-row-owner-refuses-false-raw-absence')
 # Original two-session capacity reservation refuses overlap, preserving raw.
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',fresh,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0));SELECT 'locked';SELECT pg_sleep(2);ROLLBACK;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='locked':
  if lock.poll() is not None:raise RuntimeError('native original capacity lock absent')
 yes(fresh,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=0 AND (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"')=3;",'two-session-original-capacity-lock-preserves-raw')
 lock.wait(timeout=10);assert lock.returncode==0
 yes(fresh,"SELECT fn_prune_horse_adaptive_journal()->>'observations'='3';",'original-public-pruner-completes-fresh-nonempty-raw')
 yes(fresh,"SELECT sum(observations)=3 FROM smarter_private.horse_adaptive_statistics;",'public-pruner-statistics-authoritative-readback')
 # Existing indexes, never a C coercion over the production-sized relation.
 def nodes(p):
  yield p
  for c in p.get('Plans',[]):yield from nodes(c)
 plans={}
 for name,q in [('raw',"SELECT * FROM horse_adaptive_observation_journal WHERE observation_id>='"+old.HAND_ID+":0' AND observation_id<='"+old.HAND_ID+":9999' AND hand_id='"+old.HAND_ID+"'"),('cursor',"SELECT hand_id,qualified_at FROM smarter_private.horse_adaptive_disposal_certificates WHERE (retired_at IS NULL OR raw_format_version<2) ORDER BY qualified_at,hand_id LIMIT 250")]:
  plan=json.loads(read(fresh,'SET enable_seqscan=off;EXPLAIN(FORMAT JSON) '+q+';',name+'-existing-index-plan'))[0];plans[name]=plan
  assert any('Index' in n['Node Type'] and n.get('Index Name')==('horse_adaptive_observation_journal_pkey' if name=='raw' else 'horse_adaptive_disposal_pending') for n in nodes(plan['Plan'])),name
  checks.append(name+'-uses-existing-index-matching-collation')
 e.report['numbered_plans']=plans
 # Genuine certificates are admitted in reverse UUID order. The original
 # chronological index and high-water must follow qualification, not UUID.
 cursor=e.database(template);e.sql(cursor,file=ROOT/MIGRATION,label='cursor-original-owner-correction')
 def numbered_seed(i):
  s=seed.replace(str(old.HAND_NUMBER),str(old.HAND_NUMBER+i))
  for j,value in enumerate([old.HAND_ID,old.TABLE,old.HORSE,old.DEAD_GEN,old.LIVE_GEN,old.SEATED]):
   s=s.replace(value,f'{i:08x}-{j+1:04x}-4000-8000-000000000001')
  hand=f'{i:08x}-0001-4000-8000-000000000001'
  return hand,s+old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal(ARRAY['"+hand+"']::uuid[],'Native original qualified cursor ordering and high water');"
 all_hands=[];statements=[]
 for i in range(260,0,-1):
  hand,s=numbered_seed(i);all_hands.append(hand);statements.append(s)
 e.sql(cursor,''.join(statements),label='260-genuine-reverse-qualified-original-certificates')
 e.sql(cursor,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='cursor-original-consumer-enable')
 result=json.loads(read(cursor,'SELECT fn_prune_horse_adaptive_journal();','first-bounded-hand-key-pass'))
 assert result['handsScanned']==250 and result['retirementPending'] and result['observations']==0;checks.append('existing-public-owner-scans-at-most250-under-original-budget')
 yes(cursor,"SELECT scan_after_hand_id='0000000b-0001-4000-8000-000000000001' AND scan_through_hand_id='00000001-0001-4000-8000-000000000001' FROM smarter_private.horse_adaptive_retention_activation;",'original-chronological-cursor-retains-fixed-high-water')
 hand,s=numbered_seed(261);e.sql(cursor,s,label='original-new-certificate-during-frozen-pass')
 result=json.loads(read(cursor,'SELECT fn_prune_horse_adaptive_journal();','restart-original-cursor-from-durable-pair'))
 assert result['handsScanned']==10 and result['retirementPending'];checks.append('resumed-fixed-high-water-excludes-newer-certificate')
 yes(cursor,"SELECT scan_after_hand_id IS NULL AND scan_through_hand_id IS NULL FROM smarter_private.horse_adaptive_retention_activation;",'completed-original-pass-wraps-existing-cursor')
 wrapped=json.loads(read(cursor,'SELECT fn_prune_horse_adaptive_journal();','wrapped-original-pass-new-admission'))
 assert wrapped['handsScanned']==1 and wrapped['retiredHands']==1 and not wrapped['retirementPending'];checks.append('completed-original-format-leaves-pending-index-permanently')
 idle=json.loads(read(cursor,'SELECT fn_prune_horse_adaptive_journal();','no-historical-complete-rescan'))
 assert idle['handsScanned']==0 and not idle['retirementPending'] and not idle['budgetReached'];checks.append('complete-historical-certificates-do-not-request-fast-rescan')
 yes(cursor,"SELECT retired_at IS NOT NULL FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id='"+hand+"';",'wrap-sees-genuine-new-original-certificate')
 # Recovery of a previously false retirement remains gated by original human,
 # reported and unresolved witnesses; certificate status is never a bypass.
 blocked=e.database(falseworld);e.sql(blocked,"UPDATE smarter_private.horse_adaptive_retention_activation SET enabled=false;",label='blocked-correction-hold');e.sql(blocked,file=ROOT/MIGRATION,label='blocked-forward-correction');e.sql(blocked,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');UPDATE hand_history SET has_human=true;",label='original-human-protection-after-false-retirement')
 yes(blocked,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=0 AND (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"')=3 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics);",'human-witness-protects-falsely-retired-raw')
 e.sql(blocked,'UPDATE hand_history SET has_human=false,reported=true;',label='original-reported-protection')
 yes(blocked,"SELECT smarter_private.retire_horse_adaptive_hand('"+old.HAND_ID+"')=0 AND (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+old.HAND_ID+"')=3;",'reported-witness-protects-falsely-retired-raw')
 yes(blocked,'SELECT raw_format_version=0 FROM smarter_private.horse_adaptive_disposal_certificates;','blocked-false-retirement-remains-original-pending-format')
 blocked_receipt=json.loads(read(blocked,'SELECT fn_prune_horse_adaptive_journal();','protected-false-retirement-authoritative-count'))
 assert blocked_receipt['retiredHands']==0 and blocked_receipt['observations']==0,blocked_receipt
 checks.append('protected-false-retirement-never-reported-complete')
 e.sql(blocked,'UPDATE hand_history SET reported=false;',label='original-report-hold-released')
 released_receipt=json.loads(read(blocked,'SELECT fn_prune_horse_adaptive_journal();','same-original-pending-owner-revisits-released-false-retirement'))
 assert released_receipt['observations']==3 and released_receipt['retiredHands']==1,released_receipt
 checks.append('released-false-retirement-reported-only-after-actual-completion')
 yes(blocked,'SELECT raw_format_version=2 FROM smarter_private.horse_adaptive_disposal_certificates;','released-original-false-retirement-completes-format')
 e.report['numbered_postimages']=json.loads(read(d,"SELECT jsonb_object_agg(oid::regprocedure::text,jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',proowner::regrole::text,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)) FROM pg_proc WHERE oid IN ('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure,'smarter_private.horse_adaptive_disposal_certificate_immutable()'::regprocedure,'public.fn_prune_horse_adaptive_journal()'::regprocedure);",'exact-candidate-postimages'))
 for n,meta in e.report['numbered_postimages'].items():
  assert meta['owner']=='postgres' and meta['security_definer'] and meta['acl']==('{postgres=X/postgres,service_role=X/postgres}' if n=='fn_prune_horse_adaptive_journal()' else '{postgres=X/postgres}')
 checks.append('original-owner-ACL-definer-search-path-preserved')
 e.report['numbered_retirement_proven']=checks
 for db in [blocked,cursor,falseworld,fresh,d]:e.discard(db)
 return checks
def run_icu(e):
 adaptive=module(ROOT/'scripts/verification-harness/horse-adaptive-statistics-retention.py','numbered_setup')
 original_database=e.database
 def production_database(template=None):
  if template:return original_database(template)
  name='numbered_icu_'+uuid.uuid4().hex
  e.sql('postgres','CREATE DATABASE "'+name+'" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE '+lit('en-US')+';',label='new-native-production-ICU-database');return name
 e.database=production_database
 try:
  base=adaptive.prepare_base(e)
  for path in [adaptive.MIGRATION,Path('supabase/migrations/20261012190754_horse_adaptive_retention_commits_a_larger_time_bounded_original_pass.sql'),Path('supabase/migrations/20261012192304_horse_adaptive_batch_membership_validates_once_and_records_as_one_set.sql'),Path('supabase/migrations/20261012220324_horse_membership_checks_only_original_hand_digests.sql')]:
   e.sql(base,file=ROOT/path,label='actual-original-owner-'+path.name[:14]);e.report['source_sha256'][str(path)]=sha(ROOT/path)
  qualify(e,base);e.discard(base)
  for path in [MIGRATION,Path(__file__).relative_to(ROOT)]:e.report['source_sha256'][str(path)]=sha(ROOT/path)
 finally:e.database=original_database
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);args=p.parse_args()
 out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 scratch=ROOT/'scratch';scratch.mkdir(exist_ok=True);sock=Path('/Volumes/SmarterWork/agent-work/hjc-20261013-sock') if sys.platform=='darwin' else out;sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','numbered_execution')
 e=native.Execution(ROOT,out,args.pg_bin.resolve(),scratch,300,socket_parent=str(sock))
 try:
  e.start();run_icu(e)
  e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())

