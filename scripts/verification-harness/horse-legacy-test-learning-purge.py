#!/usr/bin/env python3
"""Finite PG17 qualification of the owner's one-time legacy learning exception.

All writes use a newly initialized, socket-only isolated PostgreSQL cluster.
The ordinary eight-day and human-history retention owners remain unchanged.
"""
from pathlib import Path
import argparse, datetime, hashlib, json, subprocess, sys, uuid
from types import SimpleNamespace
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/ci'))
from satellite_qualifier_fixture import module, sha, lit

SUCCESSORS = (
 '20261012170542_horse_adaptive_raw_facts_become_exact_sufficient_statistics.sql',
 '20261012190754_horse_adaptive_retention_commits_a_larger_time_bounded_original_pass.sql',
 '20261012192304_horse_adaptive_batch_membership_validates_once_and_records_as_one_set.sql',
 '20261012220324_horse_membership_checks_only_original_hand_digests.sql',
 '20261013130413_horse_journal_retirement_follows_original_numbered_observati.sql',
 '20261014231333_horse_adaptive_retirement_rewrites_each_batch_once_per_call.sql',
 '20261015001555_horse_adaptive_compaction_finds_batches_through_the_hand_id_.sql',
 '20261015022307_horse_adaptive_retirement_groups_hands_by_shared_batch.sql',
)

def prepare(e):
 adaptive = module(ROOT / 'scripts/verification-harness/horse-adaptive-statistics-retention.py', 'legacy_purge_setup')
 original = e.database
 def icu_database(template=None):
  if template:
   return original(template)
  name = 'legacy_learning_icu_' + uuid.uuid4().hex
  e.sql('postgres', 'CREATE DATABASE "' + name + '" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE ' + lit('en-US') + ';', label='legacy-new-production-ICU-world')
  return name
 e.database = icu_database
 try:
  base = adaptive.prepare_base(e)
 finally:
  e.database = original
 provenance=(ROOT/'supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql').read_text()
 start=provenance.index('CREATE TABLE public.cash_hand_provenance_receipts (')
 end=provenance.index('CREATE FUNCTION public.fn_cash_provenance_immutable()',start)
 e.sql(base,provenance[start:end],label='legacy-original-cash-provenance-table')
 for filename in SUCCESSORS:
  path = ROOT / 'supabase/migrations' / filename
  e.sql(base, file=path, label='legacy-original-' + filename[:14])
  e.report['source_sha256'][str(path.relative_to(ROOT))] = sha(path)
 actual = json.loads(e.sql(base, "SELECT jsonb_build_object('prune',md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)),'retire',md5(pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure)))::text;", label='legacy-production-owner-preimages')[1])
 assert actual == {'prune':'70231d2cc066971c13a269b5cc374be8', 'retire':'f1147867f410f36e244e8849df4ac6d7'}, actual
 return base

# Compare complete rows for every existing non-learning public relation, plus
# immutable settlement/ordinary-retention evidence. This independently covers
# the fixture's human histories, atomic commits, wallet/accounting relations.
PROTECTED_SNAPSHOT = """
CREATE FUNCTION pg_temp.legacy_protected_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE r record; v jsonb; result jsonb:='{}';
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND (
  (n.nspname='public' AND c.relname NOT LIKE 'horse_adaptive_%') OR
  (n.nspname='smarter_private' AND c.relname IN ('hand_submissions','hand_submission_disposals',
   'horse_adaptive_disposal_certificates','horse_adaptive_statistics','horse_adaptive_observation_fences')))
 ORDER BY 1,2 LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',r.nspname,r.relname) INTO v;
  result:=result||jsonb_build_object(r.nspname||'.'||r.relname,v);
 END LOOP;
 RETURN result;
END $fn$;
SELECT pg_temp.legacy_protected_snapshot();
"""

def digest(value):
 return hashlib.sha256(value.encode()).hexdigest()

def fixture(e, template):
 d = e.database(template)
 old = module(ROOT / 'scripts/ci/test-hand-submission-retention-disposal.py', 'legacy_history_fixture')
 # This genuine human history and completed atomic settlement are protected.
 e.sql(d, old.SEED + "UPDATE public.hand_history SET has_human=true; UPDATE public.profiles SET is_horse=false;", label='legacy-protected-human-history-and-financial-world')
 actor = digest('legacy-test-actor')
 scope = json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'))
 def fact(hand, number, observed=1791068400000, origin='horse_policy'):
  return json.dumps([1,hand+':'+str(number),hand,actor,'00000001'+'c'*56,observed,'training',digest(scope),scope,'call',True,origin],separators=(',',':'))
 def batch(name, rows):
  times=[json.loads(row)[5] for row in rows]
  start=min(times)-1000; through=max(times)+1000
  # A source window can span at most six hours. Newer same-hand veto facts
  # therefore get their own batch, matching the actual cross-batch case.
  assert through-start <= 21600000
  source=digest(name);key=digest('|'.join(['adaptive-journal-v1',actor,source,str(start),str(through)]))
  return key,json.dumps([1,key,actor,start,through,source,[],rows],separators=(',',':'))
 return d,old,fact,batch

MIGRATION = Path('supabase/migrations/20261015212515_one_time_legacy_test_learning_purge.sql')
LEDGER = 'smarter_private.horse_adaptive_legacy_learning_purges'
PURGE = 'smarter_private.purge_legacy_horse_learning'
CACHE_MIGRATION = Path('supabase/migrations/20261016131548_legacy_learning_retirement_validates_each_locked_batch_once_.sql')
REQUESTED_MIGRATION = Path('supabase/migrations/20261016171029_legacy_learning_requested_hands_are_keyed_once.sql')

def qualify(e, base):
 checks=[]
 read=lambda d,q,label:e.sql(d,q,label=label)[1].strip()
 def yes(d,q,label):
  assert read(d,q,label)=='t',label
  checks.append(label)
 def invoke(d,ids,label, prefix='',suffix=''):
  return json.loads(read(d,prefix+'SELECT '+PURGE+'(ARRAY['+','.join(lit(x) for x in ids)+']::uuid[]);'+suffix,label))
 d,old,fact,batch=fixture(e,base)
 legacy='1e000001-0000-4000-8000-000000000001'
 veto='1e000002-0000-4000-8000-000000000002'
 young='1e000003-0000-4000-8000-000000000003'
 active='1e000004-0000-4000-8000-000000000004'
 unfinished='1e000005-0000-4000-8000-000000000005'
 adjacent='1e000006-0000-4000-8000-000000000006'
 rollback_hand='1e000007-0000-4000-8000-000000000007'
 atomic='1e000008-0000-4000-8000-000000000008'
 normal='1e000009-0000-4000-8000-000000000009'
 cash_human='1e000010-0000-4000-8000-000000000010'
 reported_submission='1e000011-0000-4000-8000-000000000011'
 reported_cash='1e000012-0000-4000-8000-000000000012'
 string_submission='1e000013-0000-4000-8000-000000000013'
 string_cash='1e000014-0000-4000-8000-000000000014'
 string_disposal='1e000015-0000-4000-8000-000000000015'
 facts=[fact(legacy,3),fact(legacy,30)]
 hf=fact(old.HAND_ID,3,origin='player')
 adjacent_fact=fact(adjacent,3,origin='player')
 key,payload=batch('legacy-main',facts+[hf,adjacent_fact,fact(veto,3),fact(active,3),fact(rollback_hand,3)])
 veto_key,veto_payload=batch('legacy-veto-newer',[fact(veto,30,1791158400000)])
 young_key,young_payload=batch('legacy-only-newer',[fact(young,3,1791158400000)])
 work_key,work_payload=batch('legacy-unfinished',[fact(unfinished,3)])
 for name,p in [('main',payload),('veto',veto_payload),('young',young_payload),('unfinished',work_payload)]:
  e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(p)+');',label='legacy-real-append-'+name)
 e.sql(d,"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result) SELECT table_id,hand_number+1,"+lit(atomic)+",payload_hash,stack_result FROM public.hand_atomic_commits;",label='legacy-atomic-without-history-protection')
 normal_seed=old.SEED.replace(str(old.HAND_NUMBER),str(old.HAND_NUMBER+2))
 for i,value in enumerate([old.HAND_ID,old.TABLE,old.HORSE,old.DEAD_GEN,old.LIVE_GEN,old.SEATED]):
  normal_seed=normal_seed.replace(value, normal if value==old.HAND_ID else f'1e00100{i}-0000-4000-8000-000000000009')
 normal_horse='1e001002-0000-4000-8000-000000000009'
 normal_seed=normal_seed.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId',"+lit(normal_horse)+"))))")
 e.sql(d,normal_seed+"UPDATE hand_history SET has_human=false WHERE id="+lit(normal)+";"+old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal(ARRAY["+lit(normal)+"]::uuid[],'Native normal certificate remains outside legacy exception');",label='legacy-genuine-normal-certificate-protection')
 protect_key,protect_payload=batch('legacy-atomic-and-normal',[fact(atomic,3),fact(normal,3),fact(cash_human,3),fact(reported_submission,3),fact(reported_cash,3),fact(string_submission,3),fact(string_cash,3),fact(string_disposal,3)])
 e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(protect_payload)+');',label='legacy-atomic-normal-raw')
 e.sql(d,"INSERT INTO public.hand_history(id,has_human,created_at) VALUES("+lit(active)+",false,'2026-09-01'); SELECT fn_queue_horse_adaptive_batch("+lit(work_payload)+");",label='legacy-protected-active-and-unfinished')
 e.sql(d,"INSERT INTO cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,status,participants,all_players_included,funding_provenance_complete,issues) VALUES("+lit(old.TABLE)+",1000310,"+lit(cash_human)+",repeat('a',64),'{\"hand_row\":{\"has_human\":true}}','{}','{}','{}','captured','[]',true,true,'[]');",label='legacy-original-human-cash-receipt')
 e.sql(d,"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash) VALUES("+lit(reported_submission)+','+lit(old.TABLE)+",1000311,'original-reported-test',"+lit(old.DEAD_GEN)+",'{\"p_hand_row\":{\"has_human\":false,\"reported\":true}}',repeat('b',64));",label='legacy-original-reported-submission')
 e.sql(d,"INSERT INTO cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,status,participants,all_players_included,funding_provenance_complete,issues) VALUES("+lit(old.TABLE)+",1000312,"+lit(reported_cash)+",repeat('c',64),'{\"hand_row\":{\"has_human\":false,\"reported\":true}}','{}','{}','{}','captured','[]',true,true,'[]');",label='legacy-original-reported-cash-receipt')
 e.sql(d,"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash) VALUES("+lit(string_submission)+','+lit(old.TABLE)+",1000313,'original-string-human-test',"+lit(old.DEAD_GEN)+",'{\"p_hand_row\":{\"has_human\":\"true\"}}',repeat('d',64));",label='legacy-original-string-human-submission')
 e.sql(d,"INSERT INTO cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,status,participants,all_players_included,funding_provenance_complete,issues) VALUES("+lit(old.TABLE)+",1000314,"+lit(string_cash)+",repeat('e',64),'{\"hand_row\":{\"has_human\":\"true\"}}','{}','{}','{}','captured','[]',true,true,'[]');",label='legacy-original-string-human-cash-receipt')
 e.sql(d,"INSERT INTO smarter_private.hand_submission_disposals(table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected) VALUES("+lit(old.TABLE)+",1000315,"+lit(string_disposal)+",'3e000015-0000-4000-8000-000000000015',1000316,'Native immutable original string human disposal protection witness','{\"original_has_human\":\"true\"}');",label='legacy-original-string-human-disposal-receipt')
 yes(d,'SELECT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id='+lit(normal)+');','fixture-has-genuine-original-normal-certificate')
 before=read(d,PROTECTED_SNAPSHOT,'legacy-protected-preimage')
 # The original owner has no authority for these erased, uncertified hands.
 e.sql(d,'SELECT fn_prune_horse_adaptive_journal();',label='legacy-original-owner-before-exception')
 yes(d,"SELECT count(*)=2 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id="+lit(legacy)+") FROM horse_adaptive_observation_journal WHERE hand_id="+lit(legacy)+';', 'fail-before-legacy-uncertified-raw-is-retained')
 e.sql(d,file=ROOT/MIGRATION,label='legacy-qualified-exception-migration')
 code,_,err=e.sql(d,file=ROOT/MIGRATION,label='legacy-migration-replay-refused',check=False)
 assert code!=0, 'migration replay unexpectedly accepted'
 checks.append('legacy-migration-replay-refused')
 e.sql(d,file=ROOT/CACHE_MIGRATION,label='legacy-locked-batch-cache-migration')
 e.sql(d,file=ROOT/REQUESTED_MIGRATION,label='legacy-requested-keyset-migration')
 code,_,err=e.sql(d,file=ROOT/CACHE_MIGRATION,label='legacy-cache-migration-replay-refused',check=False)
 assert code!=0 and 'LEGACY_BATCH_CACHE_PREIMAGE_CHANGED' in err,err
 checks.append('legacy-cache-migration-replay-refused')
 e.report['source_sha256'][str(CACHE_MIGRATION)]=sha(ROOT/CACHE_MIGRATION)
 # Actual current state, not output counts, determines protection.
 r=invoke(d,[legacy,veto,young,active,unfinished,old.HAND_ID,atomic,normal,cash_human,reported_submission,reported_cash,string_submission,string_cash,string_disposal],'legacy-one-bounded-exception')
 assert r['status']=='purged' and r['handsPurged']==1 and r['observationsDeleted']==2,r
 checks.append('only-explicit-old-erased-legacy-hand-is-purged')
 yes(d,"SELECT count(*)=1 AND bool_and(observed_through_ms=1791158399999 AND authorized_reason='owner-one-time-legacy-test-learning-20261015' AND observations_deleted=2) FROM "+LEDGER+';', 'exception-ledger-is-distinct-fixed-owner-authority')
 yes(d,"SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id="+lit(legacy)+');','legacy-raw-absent-after-committed-purge')
 yes(d,"SELECT canonical_payload::jsonb->7=jsonb_build_array("+','.join(lit(x) for x in [hf,adjacent_fact,fact(veto,3),fact(active,3),fact(rollback_hand,3)])+") AND batch_digest="+lit(digest(payload))+" AND retention_compacted FROM horse_adaptive_observation_batches WHERE batch_key="+lit(key)+';', 'shared-batch-keeps-protected-tuple-bytes-and-original-digest')
 for hand,count,label in [(veto,2,'newer-same-hand-veto-across-batches'),(young,1,'outside-fixed-cutoff-retained'),(active,1,'existing-history-retained'),(unfinished,1,'unfinished-work-retained'),(old.HAND_ID,1,'human-history-learning-retained'),(atomic,1,'atomic-without-history-retained'),(normal,1,'ordinary-qualified-certificate-retained'),(cash_human,1,'original-cash-human-evidence-retained'),(reported_submission,1,'original-reported-submission-retained'),(reported_cash,1,'original-reported-cash-receipt-retained'),(string_submission,1,'original-string-true-human-submission-retained'),(string_cash,1,'original-string-true-human-cash-retained'),(string_disposal,1,'original-string-true-human-disposal-retained')]:
  yes(d,'SELECT count(*)='+str(count)+' FROM horse_adaptive_observation_journal WHERE hand_id='+lit(hand)+';',label)
 assert read(d,PROTECTED_SNAPSHOT,'legacy-protected-postimage')==before
 checks.append('every-financial-human-history-normal-certificate-statistic-and-fence-row-unchanged')
 # Repeating the same request cannot fabricate additional outcomes.
 ledger=read(d,'SELECT jsonb_agg(to_jsonb(p) ORDER BY hand_id)::text FROM '+LEDGER+' p;','legacy-ledger-before-repeat')
 again=invoke(d,[legacy],'legacy-repeat')
 assert again['handsPurged']==0 and again['observationsDeleted']==0,again
 assert read(d,'SELECT jsonb_agg(to_jsonb(p) ORDER BY hand_id)::text FROM '+LEDGER+' p;','legacy-ledger-after-repeat')==ledger
 checks.append('exception-repeat-is-idempotent')
 # The entire transition rolls back together.
 raw_before=read(d,"SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id="+lit(rollback_hand)+';','legacy-rollback-raw-before')
 batch_before=read(d,'SELECT canonical_payload FROM horse_adaptive_observation_batches WHERE batch_key='+lit(key)+';','legacy-rollback-batch-before')
 rolled=invoke(d,[rollback_hand],'legacy-explicit-transaction-rollback',prefix='BEGIN;',suffix='ROLLBACK;')
 assert rolled['handsPurged']==1,rolled
 assert read(d,"SELECT count(*) FROM horse_adaptive_observation_journal WHERE hand_id="+lit(rollback_hand)+';','legacy-rollback-raw-after')==raw_before
 assert read(d,'SELECT canonical_payload FROM horse_adaptive_observation_batches WHERE batch_key='+lit(key)+';','legacy-rollback-batch-after')==batch_before
 yes(d,'SELECT NOT EXISTS(SELECT 1 FROM '+LEDGER+' WHERE hand_id='+lit(rollback_hand)+');','rollback-restores-raw-batch-and-exception-ledger')
 exact_replay=json.loads(read(d,'SELECT fn_append_horse_adaptive_observations('+lit(payload)+');','legacy-original-identical-batch-replay'))
 assert exact_replay['status']=='recorded',exact_replay
 yes(d,'SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal WHERE hand_id='+lit(legacy)+');','identical-old-batch-replay-stays-idempotent-without-raw')
 # A fresh batch key and cached old direct writer must both fail closed.
 new_key,new_payload=batch('legacy-replay-new-key',facts+[adjacent_fact])
 code,_,err=e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(new_payload)+');',label='legacy-new-batch-replay-refused',check=False)
 assert code!=0 and 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' in err,err
 checks.append('new-batch-replay-cannot-resurrect-legacy-raw')
 queued=json.loads(read(d,'SELECT fn_queue_horse_adaptive_batch('+lit(new_payload)+');','legacy-replay-queue-refused'))
 assert queued.get('reason')=='retention_compacted',queued
 checks.append('queue-refuses-retired-legacy-cohort')
 original=json.loads(facts[0])
 direct="INSERT INTO public.horse_adaptive_observation_journal(observation_id,hand_id,actor_key,session_key,observed_at_ms,partition,scope_key,origin,payload) VALUES("+','.join([lit(original[1]),lit(legacy),lit(original[3]),lit(original[4]),str(original[5]),lit(original[6]),lit(original[7]),lit(original[11]),lit(facts[0])])+');'
 code,_,err=e.sql(d,direct,label='legacy-cached-direct-writer-refused',check=False)
 assert code!=0 and 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' in err,err
 checks.append('raw-before-insert-fence-refuses-cached-writer-resurrection')
 yes(d,'SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_batches WHERE batch_key='+lit(new_key)+') AND NOT EXISTS(SELECT 1 FROM horse_adaptive_journal_work WHERE batch_key='+lit(new_key)+');','failed-replays-have-no-partial-batch-or-work-write')
 retained=read(d,'SELECT smarter_private.adaptive_retained_batch('+lit(new_payload)+');','legacy-original-retained-batch-sanitizer')
 assert json.loads(retained)[7]==[adjacent_fact],retained
 checks.append('original-retained-batch-sanitizer-removes-only-exception-hand')
 cached_key,cached_payload=batch('legacy-cached-batch-only',facts+[adjacent_fact])
 cached=json.loads(cached_payload)
 cached_sql='INSERT INTO horse_adaptive_observation_batches(batch_key,batch_digest,actor_key,source_digest,from_ms,through_ms,observation_count,rejected,canonical_payload) VALUES('+','.join([lit(cached_key),lit(digest(cached_payload)),lit(cached[2]),lit(cached[5]),str(cached[3]),str(cached[4]),str(len(cached[7])),"'[]'::jsonb",lit(cached_payload)])+');'
 e.sql(d,cached_sql,label='legacy-cached-old-batch-writer')
 yes(d,'SELECT retention_compacted AND retention_membership_ready AND canonical_payload::jsonb->7=jsonb_build_array('+lit(adjacent_fact)+') AND batch_digest='+lit(digest(cached_payload))+' FROM horse_adaptive_observation_batches WHERE batch_key='+lit(cached_key)+';','membership-on-append-sanitizes-cached-old-batch-and-preserves-digest')
 # Ledger authority is immutable and not a forgeable normal certificate.
 for op,sql in [('update','UPDATE '+LEDGER+" SET authorized_reason='forged';"),('delete','DELETE FROM '+LEDGER+';'),('truncate','TRUNCATE '+LEDGER+';')]:
  code,_,err=e.sql(d,sql,label='legacy-ledger-'+op+'-refused',check=False)
  assert code!=0,op
  checks.append('exception-ledger-'+op+'-refused')
 for role in ['anon','authenticated','service_role']:
  code,_,err=e.sql(d,'SET ROLE '+role+'; SELECT '+PURGE+'(ARRAY['+lit(legacy)+']::uuid[]);',label='legacy-'+role+'-denied',check=False)
  assert code!=0 and 'permission denied' in err.lower(),err
  checks.append('private-purge-denies-'+role)
 code,_,err=e.sql(d,'INSERT INTO '+LEDGER+" SELECT '"+rollback_hand+"'::uuid,encode(sha256(convert_to('"+rollback_hand+"','UTF8')),'hex'),observed_through_ms,authorized_reason,clock_timestamp(),0,0 FROM "+LEDGER+' LIMIT 1;',label='legacy-direct-forged-ledger-insert-refused',check=False)
 assert code!=0 and 'LEGACY_LEARNING_PURGE_UNAUTHORIZED' in err,err
 checks.append('direct-forged-exception-ledger-insert-refused')
 # Bounds and maintenance refusal happen before any mutation.
 code,_,err=e.sql(d,'SELECT '+PURGE+"(ARRAY(SELECT gen_random_uuid() FROM generate_series(1,251)));",label='legacy-over-budget-refused',check=False)
 assert code!=0,err
 checks.append('more-than250-requested-hands-refused')
 frozen=invoke(d,[rollback_hand],'legacy-platform-freeze-refused',prefix="SET app.test_platform_frozen='true';")
 assert frozen['status']=='unavailable',frozen
 yes(d,'SELECT NOT EXISTS(SELECT 1 FROM '+LEDGER+' WHERE hand_id='+lit(rollback_hand)+');','maintenance-refusal-preserves-exception-and-raw')
 # Two real native sessions prove nonwaiting shared capacity reservation.
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',d,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=e.env)
 try:
  lock.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0));SELECT 'locked';SELECT pg_sleep(2);ROLLBACK;\n");lock.stdin.close()
  while lock.stdout.readline().strip()!='locked':
   if lock.poll() is not None:raise RuntimeError('legacy-native-lock-not-acquired')
  busy=invoke(d,[rollback_hand],'legacy-real-capacity-contention')
  assert busy['status']=='unavailable' and busy['reason']=='capacity_busy',busy
  checks.append('real-two-session-capacity-contention-is-nonwaiting-and-preserves-raw')
  lock.wait(timeout=10);assert lock.returncode==0
 finally:
  if lock.poll() is None:lock.terminate();lock.wait(timeout=10)
 assert read(d,PROTECTED_SNAPSHOT,'legacy-final-protected-snapshot')==before
 checks.append('protected-records-still-byte-identical-after-all-refusals')
 postimage_query="SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner::regrole::text,'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)) FROM pg_proc p WHERE p.oid IN ('smarter_private.purge_legacy_horse_learning(uuid[])'::regprocedure,'smarter_private.legacy_learning_purge_immutable()'::regprocedure,'public.fn_append_horse_adaptive_observations(text)'::regprocedure,'public.fn_queue_horse_adaptive_batch(text)'::regprocedure,'smarter_private.adaptive_retained_batch(text)'::regprocedure,'smarter_private.horse_adaptive_raw_retirement_fence()'::regprocedure,'smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure);"
 e.report['qualified_postimages']=json.loads(read(d,postimage_query,'legacy-exact-seven-qualified-postimages'))
 assert len(e.report['qualified_postimages'])==7
 e.report['legacy_test_learning_purge']={'proven':checks,'receipt':r,'cutoff_ms':1791158399999}
 e.report['source_sha256'][str(REQUESTED_MIGRATION)]=sha(ROOT/REQUESTED_MIGRATION)
 e.report['source_sha256'][str(MIGRATION)]=sha(ROOT/MIGRATION)
 e.report['source_sha256'][str(Path(__file__).relative_to(ROOT))]=sha(Path(__file__))
 e.discard(d)
 return checks

def run_icu(e):
 base=prepare(e)
 try:
  checks=qualify(e,base)
  cached=module(ROOT/'scripts/verification-harness/horse-legacy-batch-cache.py','legacy_cache_comparison')
  checks+=cached.qualify(e,base,SimpleNamespace(ROOT=ROOT,MIGRATION=MIGRATION,CACHE_MIGRATION=CACHE_MIGRATION,REQUESTED_MIGRATION=REQUESTED_MIGRATION,PROTECTED_SNAPSHOT=PROTECTED_SNAPSHOT,PURGE=PURGE,fixture=fixture,lit=lit))
  return checks
 finally:e.discard(base)

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch-root',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 a.scratch_root.mkdir(parents=True,exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','legacy_purge_native')
 e=native.Execution(ROOT,out,a.pg_bin.resolve(),a.scratch_root.resolve(),300,socket_parent=str(a.scratch_root.resolve()))
 try:e.start();run_icu(e);e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  (out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n')
  print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup_failure']}))
 return 0 if e.report.get('status')=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
