"""Exact original membership semantics with fewer SQL statements. Native only."""
from pathlib import Path
import json,hashlib,time,subprocess
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012192304_horse_adaptive_batch_membership_validates_once_and_records_as_one_set.sql')
def qualify(e,template,keep_template=False,successor=None):
 root=Path(__file__).resolve().parents[2];base=e.database(template);passed=[]
 def read(d,q,label):return e.sql(d,q,label=label)[1].strip()
 def yes(d,q,label):
  v=read(d,q,label);assert v=='t',(label,v);passed.append(label)
 e.report.setdefault('source_sha256',{}).update({str(MIGRATION):sha(root/MIGRATION),'scripts/verification-harness/horse-adaptive-membership-set.py':sha(Path(__file__))})
 h=lambda v:hashlib.sha256(v.encode()).hexdigest();actor=h('membership-actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope);now=int(read(base,"SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",'membership-clock'))
 def payload(count=4096,source='membership-source'):
  digest=h(source);key=h('|'.join(['adaptive-journal-v1',actor,digest,str(now-1),str(now+1)]));facts=[]
  for i in range(count):
   hand='ac000000-0000-4000-8000-'+f'{i%64+1:012x}';facts.append(json.dumps([1,hand+':'+str(i),hand,actor,'00000001'+'c'*56,now,'training',scopekey,scope,'call',True,'player' if i%2 else 'horse_policy'],separators=(',',':')))
  return key,json.dumps([1,key,actor,now-1,now+1,digest,[],facts],separators=(',',':'))
 key,canonical=payload();single_key,single=payload(1,'single-source')
 observer="""CREATE SCHEMA membership_probe;CREATE TABLE membership_probe.audit(inserts integer,sanitizes integer);INSERT INTO membership_probe.audit VALUES(0,0);
 CREATE FUNCTION membership_probe.insert_seen() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE membership_probe.audit SET inserts=inserts+1;RETURN NULL;END$$;
 CREATE TRIGGER native_membership_insert_seen AFTER INSERT ON smarter_private.horse_adaptive_batch_hand_membership FOR EACH STATEMENT EXECUTE FUNCTION membership_probe.insert_seen();
 ALTER FUNCTION smarter_private.adaptive_retained_batch(text) RENAME TO native_actual_retained_batch;
 CREATE FUNCTION smarter_private.adaptive_retained_batch(p_batch text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$BEGIN UPDATE membership_probe.audit SET sanitizes=sanitizes+1;RETURN smarter_private.native_actual_retained_batch(p_batch);END$$;"""
 def legacy(d,p=canonical):e.sql(d,'ALTER TABLE horse_adaptive_observation_batches DISABLE TRIGGER horse_adaptive_batch_membership_on_append;SELECT fn_append_horse_adaptive_observations('+lit(p)+');ALTER TABLE horse_adaptive_observation_batches ENABLE TRIGGER horse_adaptive_batch_membership_on_append;',label='actual-legacy-append-phase')
 def snapshot(d,k=key):return read(d,"SELECT jsonb_build_object('batch',(SELECT to_jsonb(b)-'retention_membership_ready' FROM horse_adaptive_observation_batches b WHERE batch_key="+lit(k)+"),'raw',(SELECT jsonb_agg(to_jsonb(j) ORDER BY observation_id) FROM horse_adaptive_observation_journal j),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY hand_digest) FROM smarter_private.horse_adaptive_batch_hand_membership m));",'exact-original-membership-snapshot')
 original=e.database(base);legacy(original);before=e.database(original);e.sql(before,observer,label='native-old-statement-observer');start=time.monotonic();e.sql(before,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(key)+');',label='original-rowwise-member-owner');oldtime=time.monotonic()-start
 yes(before,'SELECT inserts=4096 AND sanitizes=1 FROM membership_probe.audit;','fail-before4096-insert-statements-and-unneeded-sanitizer');old_snapshot=snapshot(before);e.discard(before)
 e.sql(base,file=root/MIGRATION,label='exact-membership-set-successor')
 if successor:e.sql(base,file=root/successor,label='exact-membership-point-lookup-successor')
 code,_,err=e.sql(base,file=root/MIGRATION,label='membership-migration-replay-refusal',check=False);assert code and 'ADAPTIVE_MEMBERSHIP_SET_PREIMAGE_CHANGED' in err;passed.append('membership-successor-replay-refused')
 after=e.database(original);e.sql(after,file=root/MIGRATION,label='original-fixture-new-set-owner')
 if successor:e.sql(after,file=root/successor,label='original-fixture-new-point-lookup-owner')
 e.sql(after,observer,label='native-new-statement-observer');start=time.monotonic();e.sql(after,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(key)+');',label='actual-setwise-member-owner');newtime=time.monotonic()-start
 yes(after,'SELECT inserts=1 AND sanitizes=0 FROM membership_probe.audit;','one-set-insert-and-no-sanitizer-without-retired-members');assert snapshot(after)==old_snapshot;passed.append('all-original-memberships-raw-and-batch-digests-identical')
 yes(after,'SELECT count(*)=64 FROM smarter_private.horse_adaptive_batch_hand_membership;','duplicate-observations-exact64-original-hand-digests')
 e.sql(after,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(key)+');',label='ready-member-repeat');yes(after,'SELECT inserts=1 AND sanitizes=0 FROM membership_probe.audit;','ready-repeat-remains-exact-noop')
 # The same helper is called by the actual future append event.
 future=e.database(base);e.sql(future,observer,label='future-event-observer');e.sql(future,'SELECT fn_append_horse_adaptive_observations('+lit(canonical)+');',label='future-original-append-event');yes(future,'SELECT inserts=1 AND sanitizes=0 FROM membership_probe.audit;','future-append-trigger-uses-exact-set-owner');future_snapshot=json.loads(snapshot(future));expected=json.loads(old_snapshot)
 for value in [future_snapshot,expected]:
  value['batch'].pop('recorded_at',None)
  for row in value['raw']:row.pop('recorded_at',None)
 assert future_snapshot==expected;passed.append('future-and-legacy-original-membership-equivalent');e.discard(future)
 # Real original retirement followed by a changed-source exact replay. The
 # future append event must lazily sanitize only the actually retired tuple.
 retired=e.database(base);e.sql(retired,observer,label='retired-branch-observer')
 old=module(e.root/'scripts/ci/test-hand-submission-retention-disposal.py','membership_original_hands')
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")+'UPDATE hand_history SET has_human=false;'
 rkey,rpayload=payload(2,'actual-retirement-source');batch=json.loads(rpayload)
 horse=json.loads(batch[7][0]);horse[1]=old.HAND_ID+':0';horse[2]=old.HAND_ID;horse[11]='horse_policy';batch[7][0]=json.dumps(horse,separators=(',',':'));human=batch[7][1];rpayload=json.dumps(batch,separators=(',',':'))
 e.sql(retired,seed+'SELECT fn_append_horse_adaptive_observations('+lit(rpayload)+');'+old.AUTHORITY+'SELECT smarter_private.hand_submission_retention_disposal(ARRAY['+lit(old.HAND_ID)+"::uuid],'Native original horse membership retirement keeps protected tuples exact');SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');SELECT smarter_private.retire_horse_adaptive_hand("+lit(old.HAND_ID)+');',label='actual-qualified-original-retirement')
 yes(retired,'SELECT retired_at IS NOT NULL FROM smarter_private.horse_adaptive_disposal_certificates;','real-original-certificate-retired-before-replay')
 batch[5]=h('actual-retirement-replay');batch[1]=h('|'.join(['adaptive-journal-v1',actor,batch[5],str(now-1),str(now+1)]));replay=json.dumps(batch,separators=(',',':'))
 e.sql(retired,'UPDATE membership_probe.audit SET inserts=0,sanitizes=0;SELECT fn_append_horse_adaptive_observations('+lit(replay)+');',label='future-retired-exact-facts-new-batch')
 yes(retired,'SELECT sanitizes=2 AND inserts=1 FROM membership_probe.audit;','retired-helper-and-original-append-each-keep-their-sanitizer')
 yes(retired,'SELECT retention_compacted AND retention_membership_ready AND canonical_payload::jsonb->7='+lit(json.dumps([human],separators=(',',':')))+"::jsonb AND batch_digest="+lit(h(replay))+" FROM horse_adaptive_observation_batches WHERE batch_key="+lit(batch[1])+';','retired-replay-keeps-human-string-and-original-batch-digest')
 yes(retired,"SELECT count(*)=1 AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=1 FROM horse_adaptive_observation_journal;",'retired-replay-never-reinserts-original-raw')
 bad=json.loads(replay);fact=json.loads(bad[7][0]);fact[9]='raise';bad[7][0]=json.dumps(fact,separators=(',',':'));bad[5]=h('changed-retired-fact');bad[1]=h('|'.join(['adaptive-journal-v1',actor,bad[5],str(now-1),str(now+1)]))
 code,_,err=e.sql(retired,'SELECT fn_append_horse_adaptive_observations('+lit(json.dumps(bad,separators=(',',':')))+');',label='changed-retired-payload-refused',check=False);assert code and 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' in err;passed.append('retired-replay-conflicting-payload-remains-refused');e.discard(retired)
 # Invalid human/unknown/duplicate tuple is checked before any distinct write.
 for label,change in [('unknown-hand-null',lambda x:x.__setitem__(2,None)),('human-hand-invalid',lambda x:x.__setitem__(2,'not-a-uuid')),('late-duplicate-invalid',lambda x:x.__setitem__(2,'AC000000-0000-4000-8000-000000000001'))]:
  d=e.database(base);e.sql(d,observer,label=label+'-observer');legacy(d,single);bad=json.loads(single);fact=json.loads(bad[7][0]);change(fact);fact[11]='player';bad[7].append(json.dumps(fact,separators=(',',':')))
  e.sql(d,'UPDATE horse_adaptive_observation_batches SET canonical_payload='+lit(json.dumps(bad,separators=(',',':')))+' WHERE batch_key='+lit(single_key)+';',label=label+'-original-invalid-metadata');raw=snapshot(d,single_key)
  code,_,err=e.sql(d,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(single_key)+');',label=label+'-refused',check=False);assert code and 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID' in err;assert snapshot(d,single_key)==raw;passed.append(label+'-refuses-and-rolls-back-original-boundary');yes(d,'SELECT inserts=0 AND sanitizes=0 FROM membership_probe.audit;',label+'-before-any-distinct-insert');e.discard(d)
 null=e.database(base);e.sql(null,observer,label='null-observer');legacy(null,single);e.sql(null,'UPDATE horse_adaptive_observation_batches SET canonical_payload=NULL WHERE batch_key='+lit(single_key)+';SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(single_key)+');',label='null-original-canonical-owner');yes(null,'SELECT retention_membership_ready AND NOT retention_compacted AND canonical_payload IS NULL FROM horse_adaptive_observation_batches;','null-original-canonical-retains-ready-semantics');yes(null,'SELECT inserts=0 AND sanitizes=0 FROM membership_probe.audit;','null-canonical-no-fabricated-membership');e.discard(null)
 # Caller transaction rollback restores readiness and memberships together.
 rollback=e.database(base);legacy(rollback,single);pre=snapshot(rollback,single_key);e.sql(rollback,'BEGIN;SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(single_key)+');ROLLBACK;',label='membership-owner-rollback');assert snapshot(rollback,single_key)==pre;passed.append('membership-rollback-exact-original-state');e.discard(rollback)
 # Two sessions contend on the original batch row, then both converge to exact
 # membership. No new global lock or production probe is introduced.
 concurrent=e.database(base);legacy(concurrent,single)
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',concurrent,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write('BEGIN;SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(single_key)+");SELECT 'locked';SELECT pg_sleep(0.2);COMMIT;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='locked':
  if lock.poll() is not None:raise RuntimeError('original-row-lock-not-acquired')
 e.sql(concurrent,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(single_key)+');',label='concurrent-original-member-owner');lock.wait(timeout=10);assert lock.returncode==0;yes(concurrent,'SELECT retention_membership_ready AND (SELECT count(*) FROM smarter_private.horse_adaptive_batch_hand_membership)=1 FROM horse_adaptive_observation_batches;','two-session-original-lock-replay-converges');e.discard(concurrent)
 yes(base,"SELECT NOT has_function_privilege('anon','smarter_private.register_horse_adaptive_batch_membership(text)','EXECUTE') AND NOT has_function_privilege('authenticated','smarter_private.register_horse_adaptive_batch_membership(text)','EXECUTE') AND NOT has_function_privilege('service_role','smarter_private.register_horse_adaptive_batch_membership(text)','EXECUTE');",'private-original-helper-remains-postgres-only')
 e.report['membership_set_native_timing']={'old_seconds':oldtime,'new_seconds':newtime,'observations':4096,'distinct_hands':64,'old_insert_statements':4096,'new_insert_statements':1,'unneeded_sanitizer_old':1,'unneeded_sanitizer_new':0,'limit':'Native fixture timings, not universal production throughput.'}
 e.report['membership_set_postimage']=json.loads(read(base,"SELECT jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure;",'membership-final-postimage'))
 e.report['membership_set_proven']=passed;e.discard(after);e.discard(original)
 if keep_template:return base
 e.discard(base);return passed
