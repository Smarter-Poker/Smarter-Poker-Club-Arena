#!/usr/bin/env python3
"""Focused native old/new qualification; invoked by existing legacy harness."""
import hashlib,json,time
from pathlib import Path

def qualify(e,base,q):
 checks=[]
 d,old,fact,batch=q.fixture(e,base)
 ids=[f'2e{i:06x}-0000-4000-8000-{i:012x}' for i in range(250)]
 # Three production-shaped shared payloads. Human and late reported candidates
 # share every batch; a newer sibling in a fourth batch protects a whole hand.
 for k in range(3):
  rows=[fact(h,k*2+n) for h in ids for n in range(2)]+[fact(old.HAND_ID,k)]
  key,payload=batch('cache-shared-'+str(k),rows)
  e.sql(d,'SELECT fn_append_horse_adaptive_observations('+q.lit(payload)+');',label='cache-shared-append-'+str(k))
 key,payload=batch('cache-newer-sibling',[fact(ids[-2],30,1791158400000)])
 e.sql(d,'SELECT fn_append_horse_adaptive_observations('+q.lit(payload)+');',label='cache-newer-sibling')
 e.sql(d,"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash) VALUES("+q.lit(ids[-1])+','+q.lit(old.TABLE)+",1000399,'cache-late-protected',"+q.lit(old.DEAD_GEN)+",'{\"p_hand_row\":{\"reported\":true}}',repeat('c',64));",label='cache-late-reported')
 key,payload=batch('cache-same-batch-newer',[fact(ids[-3],31,1791158399998),fact(ids[-3],32,1791158400000)])
 e.sql(d,'SELECT fn_append_horse_adaptive_observations('+q.lit(payload)+');',label='cache-good-and-newer-same-batch')
 e.sql(d,'DELETE FROM horse_adaptive_observation_journal WHERE hand_id='+q.lit(ids[-4])+';',label='cache-batch-only-original')
 e.sql(d,'DELETE FROM horse_adaptive_observation_journal WHERE observation_id=ANY(ARRAY['+q.lit(ids[-2]+':30')+','+q.lit(ids[-3]+':32')+']);',label='cache-newer-siblings-only-in-batches')
 e.sql(d,file=q.ROOT/q.MIGRATION,label='cache-original-exception')
 newer=e.database(d)
 instrumented=e.database(d)
 malformed=e.database(d)
 e.sql(newer,file=q.ROOT/q.CACHE_MIGRATION,label='cache-followup-installed')
 def call(db,label):
  start=time.perf_counter();v=json.loads(e.sql(db,'SELECT '+q.PURGE+'(ARRAY['+','.join(map(q.lit,ids))+']::uuid[]);',label=label)[1]);return v,time.perf_counter()-start
 before=e.sql(d,q.PROTECTED_SNAPSHOT,label='cache-protected-before')[1]
 a,at=call(d,'cache-original-transition');b,bt=call(newer,'cache-cached-transition')
 assert a==b,(a,b)
 assert a['handsPurged']==247 and ids[-2] in a['protectedHands'] and ids[-1] in a['protectedHands'],a
 checks.append('cache-old-new-receipts-identical-shared250-with-newer-and-late-protected')
 def snapshot(db,label):
  return e.sql(db,"SELECT jsonb_build_object('journal',(SELECT jsonb_agg(to_jsonb(j) ORDER BY observation_id) FROM horse_adaptive_observation_journal j),'batches',(SELECT jsonb_agg(to_jsonb(b) ORDER BY batch_key) FROM horse_adaptive_observation_batches b),'exceptions',(SELECT jsonb_agg(to_jsonb(p)-'purged_at' ORDER BY hand_id) FROM smarter_private.horse_adaptive_legacy_learning_purges p));",label=label)[1]
 assert snapshot(d,'cache-original-postimage')==snapshot(newer,'cache-optimized-postimage')
 checks.append('cache-old-new-entire-raw-batch-ledger-postimages-byte-identical-except-transition-time')
 assert before==e.sql(newer,q.PROTECTED_SNAPSHOT,label='cache-protected-after')[1]
 checks.append('cache-financial-human-normal-evidence-unchanged')
 # Native-only instrumentation uses the identical unpurged clone.
 e.sql(instrumented,file=q.ROOT/q.CACHE_MIGRATION,label='cache-instrumented-followup')
 src=e.sql(newer,"SELECT pg_get_functiondef('smarter_private.purge_legacy_horse_learning(uuid[])'::regprocedure);",label='cache-exact-function')[1]
 assert src.count('FOR v IN SELECT value FROM jsonb_array_elements(b.canonical_payload::jsonb->7) LOOP')==1
 assert 'IF NOT batch_cache ? cache_key THEN' in src
 checks.append('cache-classification-loop-only-inside-unseen-locked-key-branch')
 instrument=src.replace(' cache_bad boolean;', ' cache_bad boolean; cache_parse_count integer:=0;')
 # The declaration shares a line, so replace only the exact unique suffix.
 if instrument==src:
  instrument=src.replace('cache_bad boolean;', 'cache_bad boolean; cache_parse_count integer:=0;')
 anchor="    cache_flags:='{}'::jsonb;"
 assert instrument.count(anchor)==1
 instrument=instrument.replace(anchor,'    cache_parse_count:=cache_parse_count+1;\n'+anchor)
 anchor=" RETURN jsonb_build_object('status','purged'"
 assert instrument.count(anchor)==1
 instrument=instrument.replace(anchor," RAISE NOTICE 'CACHE_CLASSIFICATION_PARSES=%',cache_parse_count;\n"+anchor)
 e.sql(instrumented,instrument,label='cache-native-only-parse-instrumentation')
 v,_=call(instrumented,'cache-measured-parse-once')
 assert v==a
 notices=e.report['commands'][-1]['stem']
 notice_text=(e.output/(notices+'.stderr')).read_text()
 # Number of actual cached source-batch qualifications is recorded in stderr.
 # Exactly five non-null original batch keys cover this request.
 assert 'CACHE_CLASSIFICATION_PARSES=5' in notice_text,notice_text
 checks.append('cache-native-count-five-shared-batches-qualified-once-for250hands')
 # A malformed raw tuple still aborts the whole native transaction, rather than
 # turning malformed input into an empty cache or a protected success.
 first=e.sql(malformed,'SELECT batch_key FROM horse_adaptive_observation_batches ORDER BY batch_key LIMIT 1;',label='cache-malformed-key')[1].strip()
 e.sql(malformed,"UPDATE horse_adaptive_observation_batches SET canonical_payload=jsonb_set(canonical_payload::jsonb,'{7,0}',to_jsonb('not-json'::text))::text WHERE batch_key="+q.lit(first)+';',label='cache-malformed-original-payload')
 e.sql(malformed,file=q.ROOT/q.CACHE_MIGRATION,label='cache-malformed-followup')
 code,_,err=e.sql(malformed,'SELECT '+q.PURGE+'(ARRAY['+','.join(map(q.lit,ids))+']::uuid[]);',label='cache-malformed-refused',check=False)
 assert code!=0 and 'invalid input syntax for type json' in err,err
 assert e.sql(malformed,'SELECT count(*) FROM smarter_private.horse_adaptive_legacy_learning_purges;',label='cache-malformed-no-partial-ledger')[1].strip()=='0'
 checks.append('cache-malformed-source-aborts-without-partial-ledger')

 # Current performance recorded rather than a fragile wall-time pass threshold.
 e.report['legacy_batch_cache']={'checks':checks,'original_seconds':at,'cached_seconds':bt,'shape':{'hands':250,'shared_batches':3,'facts_per_hand_per_batch':2},'same_receipt':a}
 e.report['source_sha256']['scripts/verification-harness/horse-legacy-batch-cache.py']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
 e.discard(d);e.discard(newer);e.discard(instrumented);e.discard(malformed)
 return checks
