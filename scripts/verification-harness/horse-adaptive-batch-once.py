#!/usr/bin/env python3
"""Native production-ICU proof that the adaptive owner compacts each batch once.

The original per-hand path (retire_horse_adaptive_hand, md5 f114) and the
corrected owner (fn_prune_horse_adaptive_journal with the deferred retire) run
from the same template world: many genuine qualified horse hands whose facts
share two batches with an adjacent human tuple and one still-protected horse
hand. The committed results must be byte-identical: batch payloads/digests/
compaction flags, remaining raw, statistics, fences and certificate format.
"""
from pathlib import Path
import argparse,datetime,difflib,json,hashlib,sys,time,uuid
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261014231333_horse_adaptive_retirement_rewrites_each_batch_once_per_call.sql')
CORRECTION=Path('supabase/migrations/20261015001134_horse_adaptive_batch_once_selects_batches_through_the_member.sql')
NUMBERED=Path('supabase/migrations/20261013130413_horse_journal_retirement_follows_original_numbered_observati.sql')
HANDS=40
def function_body(path,name):
 s=(ROOT/path).read_text();i=s.index('CREATE OR REPLACE FUNCTION '+name+'(') if ('CREATE OR REPLACE FUNCTION '+name+'(') in s else s.index('CREATE FUNCTION '+name+'(')
 a=s.index('$function$',i)+len('$function$');return s[a:s.index('$function$',a)]
def source_checks(checks):
 # The deferred retire is the installed original body except the per-hand
 # batch loop (and its two now-unused declarations).
 original=function_body(NUMBERED,'smarter_private.retire_horse_adaptive_hand').splitlines()
 deferred=function_body(MIGRATION,'smarter_private.retire_horse_adaptive_hand_deferred').splitlines()
 start=original.index(' -- Retire only eligible tuples within a batch. Human/other-hand tuples stay')
 end=original.index(' END LOOP;',start)
 expected=original[:start]+[' -- Batch compaction is deliberately NOT done here. The only caller,',' -- fn_prune_horse_adaptive_journal, compacts each touched batch once for every',' -- hand this function completed, inside the same transaction.']+original[end+1:]
 expected=[l.replace('DECLARE c smarter_private.horse_adaptive_disposal_certificates; b record; kept jsonb; key text; n integer;','DECLARE c smarter_private.horse_adaptive_disposal_certificates; key text; n integer;') for l in expected]
 assert deferred==expected,'\n'.join(difflib.unified_diff(expected,deferred,lineterm=''))
 checks.append('deferred-retire-is-original-body-minus-per-hand-batch-loop')
def world(e,template):
 old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','batch_once_old')
 adaptive=module(ROOT/'scripts/verification-harness/horse-adaptive-statistics-retention.py','batch_once_adaptive')
 d=e.database(template);read=lambda q,label:e.sql(d,q,label=label)[1].strip()
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))").replace("interval '30 days'","interval '20 days'")+"UPDATE hand_history SET has_human=false;"
 h=lambda s:hashlib.sha256(s.encode()).hexdigest();actor=h('batch-once-actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope)
 now=int(read("SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",'batch-once-clock'))
 def numbered_seed(i):
  s=seed.replace(str(old.HAND_NUMBER),str(old.HAND_NUMBER+i))
  for j,value in enumerate([old.HAND_ID,old.TABLE,old.HORSE,old.DEAD_GEN,old.LIVE_GEN,old.SEATED]):
   s=s.replace(value,f'{i:08x}-{j+1:04x}-4000-8000-0000000000b1')
  return f'{i:08x}-0001-4000-8000-0000000000b1',s
 hands=[];seeds=[]
 for i in range(1,HANDS+1):
  hand,s=numbered_seed(i);hands.append(hand);seeds.append(s)
 e.sql(d,''.join(seeds),label='batch-once-genuine-horse-hands')
 actions=['fold','check','call','bet','raise']
 facts={hand:[json.dumps([1,hand+':'+str(n),hand,actor,'00000001'+'c'*56,now+n,'training',scopekey,scope,actions[(k+n)%5],True,'horse_policy'],separators=(',',':')) for n in [3,30,100]] for k,hand in enumerate(hands)}
 human='9b200000-0000-4000-8000-0000000000b2'
 hf=json.dumps([1,human+':3',human,actor,'00000001'+'c'*56,now+3,'training',scopekey,scope,'raise',True,'player'],separators=(',',':'))
 def batch(source,rows):
  digest=h(source);key=h('|'.join(['adaptive-journal-v1',actor,digest,str(now-1000),str(now+5000)]))
  return key,json.dumps([1,key,actor,now-1000,now+5000,digest,[],rows],separators=(',',':'))
 rows_a=[]
 for hand in hands:rows_a+=facts[hand]
 rows_a=rows_a[:len(rows_a)//2]+[hf]+rows_a[len(rows_a)//2:]
 key_a,payload_a=batch('batch-once-a',rows_a)
 rows_b=[f for hand in hands[:10] for f in facts[hand]]+[hf]
 key_b,payload_b=batch('batch-once-b',rows_b)
 e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(payload_a)+');SELECT fn_append_horse_adaptive_observations('+lit(payload_b)+');',label='batch-once-shared-batches')
 e.sql(d,''.join(old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal(ARRAY['"+hand+"']::uuid[],'Native batch-once qualified horse hand shares retained batches');" for hand in hands),label='batch-once-genuine-certificates')
 protected=hands[3]
 e.sql(d,"UPDATE hand_history SET has_human=true WHERE id='"+protected+"';",label='batch-once-protected-witness')
 return d,hands,protected,human,key_a,key_b,payload_a,payload_b
SNAPSHOT=("SELECT jsonb_build_object("
 "'batches',(SELECT jsonb_agg(jsonb_build_object('key',batch_key,'payload',canonical_payload,'digest',batch_digest,'compacted',retention_compacted) ORDER BY batch_key) FROM horse_adaptive_observation_batches),"
 "'journal',(SELECT jsonb_agg(payload ORDER BY observation_id COLLATE \"C\") FROM horse_adaptive_observation_journal),"
 "'statistics',(SELECT jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text) FROM smarter_private.horse_adaptive_statistics s),"
 "'fences',(SELECT jsonb_agg(to_jsonb(f) ORDER BY to_jsonb(f)::text) FROM smarter_private.horse_adaptive_observation_fences f),"
 "'certificates',(SELECT jsonb_agg(jsonb_build_object('hand',hand_id,'format',raw_format_version,'retired',retired_at IS NOT NULL) ORDER BY hand_id) FROM smarter_private.horse_adaptive_disposal_certificates))::text;")
def qualify(e,base):
 checks=[];source_checks(checks)
 d,hands,protected,human,key_a,key_b,payload_a,payload_b=world(e,base)
 read=lambda db,q,label:e.sql(db,q,label=label)[1].strip()
 def yes(db,q,label):assert read(db,q,label)=='t',label;checks.append(label)
 yes(d,"SELECT count(*)="+str(HANDS)+" AND bool_and(raw_format_version=0 AND retired_at IS NULL) FROM smarter_private.horse_adaptive_disposal_certificates;",'batch-once-genuine-pending-certificates')
 yes(d,"SELECT count(DISTINCT batch_key)=2 FROM smarter_private.horse_adaptive_batch_hand_membership;",'batch-once-hands-share-two-batches')
 # Original per-hand path, in the original chronological owner order.
 legacy=e.database(d)
 e.sql(legacy,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='legacy-enable')
 t0=time.monotonic()
 e.sql(legacy,"DO $$DECLARE r record; BEGIN FOR r IN SELECT hand_id FROM smarter_private.horse_adaptive_disposal_certificates ORDER BY qualified_at,hand_id LOOP PERFORM smarter_private.retire_horse_adaptive_hand(r.hand_id); END LOOP; END$$;",label='legacy-original-per-hand-retirement')
 legacy_seconds=time.monotonic()-t0
 legacy_snapshot=json.loads(read(legacy,SNAPSHOT,'legacy-postimage'))
 # Corrected owner from the same template.
 corrected=e.database(d)
 e.sql(corrected,file=ROOT/MIGRATION,label='batch-once-forward-correction')
 e.sql(corrected,file=ROOT/CORRECTION,label='batch-once-membership-key-correction')
 status,_,err=e.sql(corrected,file=ROOT/CORRECTION,label='batch-once-correction-replay-refused',check=False);assert status and 'ADAPTIVE_BATCH_ONCE_INDEX_PREIMAGE_CHANGED' in err;checks.append('membership-key-correction-replay-refused')
 source=read(corrected,"SELECT pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure);",'corrected-owner-source')
 assert 'm.hand_digest=ANY(retired_digests)' in source and '::text=ANY(retired_hands) ORDER' not in source;checks.append('batch-selection-keyed-by-membership-primary-key-not-cast')
 def nodes(plan):
  yield plan
  for c in plan.get('Plans',[]):yield from nodes(c)
 plan=json.loads(read(corrected,"SET enable_seqscan=off;EXPLAIN(FORMAT JSON) SELECT DISTINCT m.batch_key FROM smarter_private.horse_adaptive_batch_hand_membership m WHERE m.hand_digest=ANY(ARRAY(SELECT hand_digest FROM smarter_private.horse_adaptive_disposal_certificates)) ORDER BY m.batch_key;",'batch-selection-plan'))[0]
 assert not any(n['Node Type']=='Seq Scan' for n in nodes(plan['Plan'])) and any(n.get('Index Name')=='horse_adaptive_batch_hand_membership_pkey' for n in nodes(plan['Plan'])),plan;checks.append('batch-selection-uses-membership-primary-key')
 status,_,err=e.sql(corrected,file=ROOT/MIGRATION,label='batch-once-replay-refused',check=False);assert status and 'ADAPTIVE_BATCH_ONCE_PREIMAGE_CHANGED' in err;checks.append('batch-once-forward-replay-refused')
 e.sql(corrected,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='corrected-enable')
 t0=time.monotonic()
 receipt=json.loads(read(corrected,'SELECT fn_prune_horse_adaptive_journal();','corrected-owner-one-call'))
 corrected_seconds=time.monotonic()-t0
 assert receipt['status']=='pruned' and receipt['handsScanned']==HANDS and receipt['retiredHands']==HANDS-1 and receipt['observations']==3*(HANDS-1),receipt
 checks.append('corrected-owner-retires-every-eligible-hand-in-one-bounded-call')
 corrected_snapshot=json.loads(read(corrected,SNAPSHOT,'corrected-postimage'))
 assert corrected_snapshot==legacy_snapshot,'postimage differs from original per-hand path'
 checks.append('batches-raw-statistics-fences-certificates-byte-identical-to-original-per-hand-path')
 yes(corrected,"SELECT (SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id='"+protected+"')=3 AND (SELECT raw_format_version=0 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id='"+protected+"');",'protected-hand-raw-and-pending-certificate-retained')
 yes(corrected,"SELECT bool_and(EXISTS(SELECT 1 FROM jsonb_array_elements(canonical_payload::jsonb->7) v WHERE (v.value#>>'{}')::jsonb->>2='"+protected+"')) FROM horse_adaptive_observation_batches;",'protected-hand-tuples-remain-in-every-batch')
 yes(corrected,"SELECT bool_and(EXISTS(SELECT 1 FROM jsonb_array_elements(canonical_payload::jsonb->7) v WHERE (v.value#>>'{}')::jsonb->>2='"+human+"')) AND count(*)=2 AND bool_and(retention_compacted) FROM horse_adaptive_observation_batches;",'adjacent-human-tuple-byte-retained-in-both-batches')
 yes(corrected,"SELECT batch_digest="+lit(hashlib.sha256(payload_a.encode()).hexdigest())+" FROM horse_adaptive_observation_batches WHERE batch_key="+lit(key_a)+";",'original-batch-digest-remains-replay-fence')
 yes(corrected,"SELECT jsonb_array_length(canonical_payload::jsonb->7)=4 FROM horse_adaptive_observation_batches WHERE batch_key="+lit(key_a)+";",'retired-tuples-removed-protected-and-human-kept')
 # Idempotent repeat: nothing pending except the protected hand, no double statistics.
 again=json.loads(read(corrected,'SELECT fn_prune_horse_adaptive_journal();','corrected-owner-repeat'))
 assert again['retiredHands']==0 and again['observations']==0,again
 assert json.loads(read(corrected,SNAPSHOT,'corrected-repeat-postimage'))==corrected_snapshot;checks.append('repeat-is-noop-no-double-statistics')
 # Released protection completes through the same owner and its once-per-batch compaction.
 e.sql(corrected,"UPDATE hand_history SET has_human=false WHERE id='"+protected+"';",label='protected-witness-released')
 released=json.loads(read(corrected,'SELECT fn_prune_horse_adaptive_journal();','released-hand-completes'))
 assert released['retiredHands']==1 and released['observations']==3,released
 yes(corrected,"SELECT jsonb_array_length(canonical_payload::jsonb->7)=1 FROM horse_adaptive_observation_batches WHERE batch_key="+lit(key_a)+";",'released-hand-removed-only-human-remains')
 # Atomicity: a rolled-back owner call leaves raw, statistics and batches untouched.
 rollback=e.database(d);e.sql(rollback,file=ROOT/MIGRATION,label='rollback-forward-correction');e.sql(rollback,file=ROOT/CORRECTION,label='rollback-membership-key-correction')
 e.sql(rollback,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='rollback-enable')
 before=read(rollback,SNAPSHOT,'rollback-preimage')
 e.sql(rollback,'BEGIN;SELECT fn_prune_horse_adaptive_journal();ROLLBACK;',label='rollback-owner-call')
 assert read(rollback,SNAPSHOT,'rollback-postimage')==before;checks.append('owner-transition-including-batch-compaction-is-atomic')
 meta=json.loads(read(corrected,"SELECT jsonb_object_agg(oid::regprocedure::text,jsonb_build_object('owner',proowner::regrole::text,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig,'md5',md5(pg_get_functiondef(oid)))) FROM pg_proc WHERE oid IN ('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure,'smarter_private.retire_horse_adaptive_hand_deferred(uuid)'::regprocedure,'public.fn_prune_horse_adaptive_journal()'::regprocedure);",'batch-once-postimage-authority'))
 for name,m in meta.items():
  assert m['owner']=='postgres' and m['security_definer'] and m['config']==['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'],(name,m)
  assert m['acl']==('{postgres=X/postgres,service_role=X/postgres}' if name=='fn_prune_horse_adaptive_journal()' else '{postgres=X/postgres}'),(name,m)
 assert meta['smarter_private.retire_horse_adaptive_hand(uuid)']['md5']=='f1147867f410f36e244e8849df4ac6d7';checks.append('original-one-argument-retire-unchanged')
 checks.append('owner-ACL-definer-search-path-lock-timeout-preserved')
 e.report['batch_once']={'proven':checks,'postimages':meta,'legacy_per_hand_seconds':round(legacy_seconds,3),'corrected_one_call_seconds':round(corrected_seconds,3),'receipt':receipt}
 for db in [rollback,corrected,legacy,d]:e.discard(db)
 return checks
def run_icu(e):
 adaptive=module(ROOT/'scripts/verification-harness/horse-adaptive-statistics-retention.py','batch_once_setup')
 original_database=e.database
 def production_database(template=None):
  if template:return original_database(template)
  name='batch_once_icu_'+uuid.uuid4().hex
  e.sql('postgres','CREATE DATABASE "'+name+'" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE '+lit('en-US')+';',label='new-native-production-ICU-database');return name
 e.database=production_database
 try:
  base=adaptive.prepare_base(e)
  for path in [adaptive.MIGRATION,Path('supabase/migrations/20261012190754_horse_adaptive_retention_commits_a_larger_time_bounded_original_pass.sql'),Path('supabase/migrations/20261012192304_horse_adaptive_batch_membership_validates_once_and_records_as_one_set.sql'),Path('supabase/migrations/20261012220324_horse_membership_checks_only_original_hand_digests.sql'),NUMBERED]:
   e.sql(base,file=ROOT/path,label='batch-once-original-owner-'+path.name[:14]);e.report['source_sha256'][str(path)]=sha(ROOT/path)
  installed=json.loads(e.sql(base,"SELECT jsonb_build_object('prune',md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)),'retire',md5(pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure)),'certificate',md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_immutable()'::regprocedure)))::text;",label='batch-once-production-preimage')[1].strip())
  assert installed=={'prune':'d287d2dc4fd96d9aa2a2e179ff156ff3','retire':'f1147867f410f36e244e8849df4ac6d7','certificate':'2497e31c1f8c6c955e2b082fdc0a3df0'},installed
  checks=qualify(e,base);checks.insert(0,'fixture-preimage-equals-production-installed-md5s');e.report['batch_once']['proven']=checks;e.discard(base)
  for path in [MIGRATION,CORRECTION,Path(__file__).relative_to(ROOT)]:e.report['source_sha256'][str(path)]=sha(ROOT/path)
 finally:e.database=original_database
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);args=p.parse_args()
 out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 scratch=ROOT/'scratch';scratch.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','batch_once_execution')
 e=native.Execution(ROOT,out,args.pg_bin.resolve(),scratch,300,socket_parent=str(out))
 try:
  e.start();run_icu(e);e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup_failure']}))
 return 0 if e.report.get('status')=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
