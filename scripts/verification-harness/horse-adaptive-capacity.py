"""Focused original-owner capacity proof. Native PostgreSQL only."""
from pathlib import Path
import hashlib,json,subprocess,time
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012185848_horse_adaptive_retention_commits_a_larger_time_bounded_original_pass.sql')
def qualify(e,template):
 root=Path(__file__).resolve().parents[2];checks=[];base=e.database(template)
 old=module(e.root/'scripts/ci/test-hand-submission-retention-disposal.py','capacity_original')
 def yes(db,q,label):
  _,v,_=e.sql(db,q,label=label);assert v.strip()=='t',(label,v);checks.append(label)
 def read(db,q,label):return e.sql(db,q,label=label)[1].strip()
 def receipt(db,label):
  start=time.monotonic();r=json.loads(read(db,'SELECT fn_prune_horse_adaptive_journal();',label));return r,time.monotonic()-start
 e.report.setdefault('source_sha256',{}).update({str(MIGRATION):sha(root/MIGRATION),'scripts/verification-harness/horse-adaptive-capacity.py':sha(Path(__file__))})
 funcs="'smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure,'smarter_private.capture_horse_adaptive_disposals(uuid[])'::regprocedure,'smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure"
 unchanged=read(base,'SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid=ANY(ARRAY['+funcs+']);','original-helper-hashes')
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")
 count=251;hands=[];sql=[];payloads=[];h=lambda v:hashlib.sha256(v.encode()).hexdigest();actor=h('capacity-actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope)
 observed=int(read(base,"SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",'original-observation-clock'))
 for i in range(1,count+1):
  suffix=f'{i:012x}';hand='9b200000-0000-4000-8000-'+suffix;hands.append(hand)
  row=seed.replace('000000000001',suffix).replace(str(old.HAND_NUMBER),str(old.HAND_NUMBER+i))
  if i>1:row=row.replace('INSERT INTO public.hand_history_retention_policy (horse_retention_days) VALUES (8);','')
  sql.append(row)
  fact=json.dumps([1,hand+':0',hand,actor,'00000001'+'c'*56,observed,'training',scopekey,scope,'call',True,'horse_policy'],separators=(',',':'));source=h('capacity-source-'+str(i));fromms=observed-1;toms=observed+1;key=h('|'.join(['adaptive-journal-v1',actor,source,str(fromms),str(toms)]));payloads.append(json.dumps([1,key,actor,fromms,toms,source,[],[fact]],separators=(',',':')))
 ids='ARRAY['+','.join(lit(x)+'::uuid' for x in hands)+']'
 seed_sql=''.join(sql)+'UPDATE hand_history SET has_human=false;'+''.join('SELECT fn_append_horse_adaptive_observations('+lit(p)+');' for p in payloads)
 fixture=e.database(base);e.sql(fixture,seed_sql,label='251-real-original-horse-hand-fixture')
 e.sql(fixture,old.AUTHORITY+'SELECT smarter_private.hand_submission_retention_disposal('+ids+",'Native original settled horse capacity boundary preserves accounting evidence');",label='original-disposal-certification')
 yes(fixture,'SELECT count(*)=251 FROM smarter_private.horse_adaptive_disposal_certificates;','251-original-immutable-certificates')
 e.sql(fixture,"SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');",label='native-only-activation')
 original=e.database(fixture);before=e.database(fixture);r,t=receipt(before,'predecessor-25-pass');assert r['version']==2 and r['retiredHands']==25 and r['observations']==25;(checks.append('fail-before-existing-owner-caps-at25'));e.report['capacity_predecessor_seconds']=t;e.discard(before)
 e.sql(base,file=root/MIGRATION,label='exact-capacity-successor');code,_,err=e.sql(base,file=root/MIGRATION,label='capacity-replay-refusal',check=False);assert code and 'ADAPTIVE_CAPACITY_PREIMAGE_CHANGED' in err;checks.append('capacity-migration-replay-refusal')
 # Apply exact successor independently to the original immutable fixture.
 e.sql(fixture,file=root/MIGRATION,label='fixture-exact-capacity-successor')
 r,t=receipt(fixture,'successor-250-pass');assert r['handsScanned']<=250 and r['retirementPending'];assert r['version']==3 and 25<r['retiredHands']<=250 and r['observations']==r['retiredHands'] and isinstance(r['budgetReached'],bool);checks.append('larger-original-pass-with-hard250-bound');e.report['capacity_successor_receipt']=r;e.report['capacity_successor_seconds']=t
 total=r['retiredHands'];r2,t2=receipt(fixture,'successor-remainder-pass');assert r2['retiredHands']<=250 and total+r2['retiredHands']==251;checks.append('bounded-next-pass-completes251-real-hands')
 yes(fixture,'SELECT NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_journal) AND (SELECT sum(observations) FROM smarter_private.horse_adaptive_statistics)=251 AND (SELECT count(*) FROM smarter_private.horse_adaptive_observation_fences)=251;','exact-original-statistics-and-replay-fences')
 # The same original certificate owner handles protected-prefix fairness.
 prefix=e.database(original);e.sql(prefix,file=root/MIGRATION,label='protected-prefix-successor')
 protected='ARRAY['+','.join(lit(x)+'::uuid' for x in hands[:250])+']'
 e.sql(prefix,'UPDATE hand_history SET reported=true WHERE id=ANY('+protected+');',label='fresh-original-reported-holds')
 evidence_sql='SELECT jsonb_build_object(\'raw\',(SELECT jsonb_agg(to_jsonb(j) ORDER BY observation_id) FROM horse_adaptive_observation_journal j WHERE hand_id=ANY('+protected+')),\'history\',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM hand_history h WHERE id=ANY('+protected+')),\'batch\',(SELECT jsonb_agg(to_jsonb(b) ORDER BY batch_key) FROM horse_adaptive_observation_batches b JOIN smarter_private.horse_adaptive_batch_hand_membership m USING(batch_key) WHERE m.hand_digest=ANY(SELECT hand_digest FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=ANY('+protected+'))));'
 protected_before=read(prefix,evidence_sql,'protected-original-byte-baseline')
 r,_=receipt(prefix,'protected250-prefix-scan');assert r['handsScanned']==250 and r['retiredHands']==0 and r['retirementPending'];checks.append('protected-prefix-cursor-advances-without-claiming-retirement')
 cursor=read(prefix,'SELECT to_jsonb(a) FROM smarter_private.horse_adaptive_retention_activation a;','persistent-fixed-pass-state')
 # Continuing ingress cannot move the already persisted pass high-water.
 extra_suffix=f'{252:012x}';extra_hand='9b200000-0000-4000-8000-'+extra_suffix
 extra_seed=seed.replace('000000000001',extra_suffix).replace(str(old.HAND_NUMBER),str(old.HAND_NUMBER+252)).replace('INSERT INTO public.hand_history_retention_policy (horse_retention_days) VALUES (8);','')
 extra_payload=json.loads(payloads[0]);extra_payload[5]=h('new-capacity-ingress');extra_payload[1]=h('|'.join(['adaptive-journal-v1',actor,extra_payload[5],str(extra_payload[3]),str(extra_payload[4])]))
 extra_fact=json.loads(extra_payload[7][0]);extra_fact[1]=extra_hand+':0';extra_fact[2]=extra_hand;extra_payload[7]=[json.dumps(extra_fact,separators=(',',':'))]
 e.sql(prefix,extra_seed+'UPDATE hand_history SET has_human=false WHERE id='+lit(extra_hand)+';SELECT fn_append_horse_adaptive_observations('+lit(json.dumps(extra_payload,separators=(',',':')))+');'+old.AUTHORITY+'SELECT smarter_private.hand_submission_retention_disposal(ARRAY['+lit(extra_hand)+"::uuid],'Native new original settled capacity ingress cannot move prior high-water');",label='new-ingress-after-fixed-window')
 assert read(prefix,'SELECT to_jsonb(a) FROM smarter_private.horse_adaptive_retention_activation a;','high-water-after-new-ingress')==cursor;checks.append('new-ingress-never-extends-fixed-original-pass')
 # Restart is a new connection/template: cursor and fixed high-water survive.
 restart=e.database(prefix);r,_=receipt(restart,'restart-reaches-later-eligible');assert r['handsScanned']==1 and r['retiredHands']==1 and r['retirementPending'];checks.append('restart-safe-cursor-reaches-later-eligible-original')
 assert read(restart,evidence_sql,'protected-original-byte-after')==protected_before;checks.append('protected-human-reported-raw-history-batches-byte-identical')
 r,_=receipt(restart,'wrapped-protected-prefix');assert r['handsScanned']==250 and r['retiredHands']==0 and r['retirementPending'];r,_=receipt(restart,'wrapped-new-ingress-tail');assert r['retiredHands']==1 and not r['retirementPending'];checks.append('fixed-pass-wrap-eventually-reaches-new-ingress')
 r,_=receipt(restart,'held-only-complete-pass');assert r['handsScanned']==250 and r['retiredHands']==0 and not r['retirementPending'] and not r['budgetReached'];checks.append('held-only-final-pass-does-not-request-perpetual-fast-retry')
 # A slow final protected helper exhausts elapsed time after the complete
 # window. With no expired statistics this is not unfinished fast-retry work.
 held=e.database(restart)
 held_body=read(held,"SELECT pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure);",'original-held-helper')
 e.sql(held,held_body.replace('BEGIN',"BEGIN\n IF p_hand="+lit(hands[249])+"::uuid THEN PERFORM pg_sleep(2.1); END IF;",1),label='native-only-slow-final-protected-helper')
 r,t=receipt(held,'slow-complete-protected-window');assert r['handsScanned']==250 and not r['retirementPending'] and not r['budgetReached'];checks.append('elapsed-final-protected-window-does-not-request-futile-fast-retry');e.report['capacity_slow_final_held_seconds']=t;e.discard(held)
 # Rollback restores both original raw facts and cursor atomically.
 rollback=e.database(original);e.sql(rollback,file=root/MIGRATION,label='rollback-successor')
 before_state=read(rollback,'SELECT to_jsonb(a) FROM smarter_private.horse_adaptive_retention_activation a;','rollback-original-state')
 e.sql(rollback,'BEGIN;SELECT fn_prune_horse_adaptive_journal();ROLLBACK;',label='rollback-actual-owner-pass')
 assert read(rollback,'SELECT to_jsonb(a) FROM smarter_private.horse_adaptive_retention_activation a;','rollback-final-state')==before_state
 yes(rollback,'SELECT count(*)=251 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics) FROM horse_adaptive_observation_journal;','rollback-keeps-all-original-facts-and-no-stats');e.discard(rollback)
 e.discard(prefix);e.discard(restart)
 # Explicit slow original operation, only in this disposable native world.
 # Add sleep to its exact captured body instead of stubbing its result/guards.
 slow=e.database(original);e.sql(slow,file=root/MIGRATION,label='soft-deadline-successor')
 original_retire=read(slow,"SELECT pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure);",'actual-original-retire-body')
 assert original_retire.count('BEGIN')==1
 e.sql(slow,original_retire.replace('BEGIN','BEGIN\n PERFORM pg_sleep(0.035);',1),label='native-only-delayed-original-helper')
 r,t=receipt(slow,'soft-deadline-commits-real-progress');assert 0<r['handsScanned']<250 and r['handsScanned']==r['retiredHands'] and r['budgetReached'] and r['retirementPending'];checks.append('soft-deadline-commits-below-count-cap-with-explicit-pending')
 e.report['capacity_slow_receipt']=r;e.report['capacity_slow_seconds']=t;assert t<4.5;checks.append('native-delayed-pass-leaves-five-second-rpc-headroom')
 yes(slow,'SELECT count(*)>0 FROM smarter_private.horse_adaptive_statistics;','soft-stop-actual-statistics-persisted');e.discard(slow)
 # Lost transaction reply cannot double count and rollback preserves originals.
 r3,_=receipt(fixture,'idempotent-capacity-repeat');assert r3['observations']==0 and r3['retiredHands']==0;checks.append('repeat-pass-never-double-counts')
 disabled=e.database(template);e.sql(disabled,file=root/MIGRATION,label='disabled-successor');e.sql(disabled,seed_sql,label='disabled-originals');r,_=receipt(disabled,'disabled-raw-owner');assert r['retiredHands']==0;yes(disabled,'SELECT count(*)=251 FROM horse_adaptive_observation_journal;','activation-off-keeps-original-raw');e.discard(disabled)
 # Existing legacy batches predate the append membership event; reproduce
 # exactly that supported predecessor phase, never weaken production triggers.
 legacy=e.database(base)
 e.sql(legacy,'ALTER TABLE horse_adaptive_observation_batches DISABLE TRIGGER horse_adaptive_batch_membership_on_append;'+''.join('SELECT fn_append_horse_adaptive_observations('+lit(p)+');' for p in payloads)+'ALTER TABLE horse_adaptive_observation_batches ENABLE TRIGGER horse_adaptive_batch_membership_on_append;',label='251-legacy-original-batches')
 r,_=receipt(legacy,'membership250-cap');assert r['membershipsRegistered']==250 and r['membershipPending'] and r['handsScanned']==0;checks.append('legacy-membership-cap250-with-no-futile-hand-scan')
 r,_=receipt(legacy,'membership-remainder');assert r['membershipsRegistered']==1 and not r['membershipPending'] and r['handsScanned']==0;checks.append('legacy-membership-next-pass-completes-original-tail');e.discard(legacy)
 # Three exact accepted 8MiB batches, each within the original input ceiling.
 # JSON whitespace is retained by the original canonical source receipt.
 metadata=e.database(base);e.sql(metadata,'ALTER TABLE horse_adaptive_observation_batches DISABLE TRIGGER horse_adaptive_batch_membership_on_append;',label='legacy-metadata-phase')
 for i,p in enumerate(payloads[:3]):
  padded=' '*(8388608-len(p.encode()))+p;assert len(padded.encode())==8388608
  e.sql(metadata,'SELECT fn_append_horse_adaptive_observations('+lit(padded)+');',label='accepted-original-eight-mib-'+str(i))
 e.sql(metadata,'ALTER TABLE horse_adaptive_observation_batches ENABLE TRIGGER horse_adaptive_batch_membership_on_append;',label='restore-original-membership-event')
 r,t=receipt(metadata,'unchanged-sixteen-mib-pass');assert r['membershipsRegistered']==2 and r['membershipPending'] and r['budgetReached'];checks.append('aggregate-metadata-ceiling-remains-exact16MiB')
 yes(metadata,'SELECT sum(octet_length(canonical_payload))=16777216 FROM horse_adaptive_observation_batches WHERE retention_membership_ready;','metadata-original-bytes-qualified-not-exceeded')
 e.report['capacity_metadata_seconds']=t;r,_=receipt(metadata,'metadata-remainder');assert r['membershipsRegistered']==1 and not r['membershipPending'];checks.append('metadata-budget-remainder-not-lost');e.discard(metadata)
 # Original contention is still nonwaiting. No alternate reservation.
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',base,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0));SELECT 'locked';SELECT pg_sleep(1);ROLLBACK;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='locked':
  if lock.poll() is not None:raise RuntimeError('capacity-lock-not-acquired')
 r,_=receipt(base,'original-capacity-reservation-busy');assert r=={'version':3,'status':'unavailable','reason':'capacity_busy'};checks.append('original-capacity-lock-busy-refusal');lock.wait(timeout=10);assert lock.returncode==0
 yes(base,"SELECT NOT has_function_privilege('anon','fn_prune_horse_adaptive_journal()','EXECUTE') AND NOT has_function_privilege('authenticated','fn_prune_horse_adaptive_journal()','EXECUTE') AND has_function_privilege('service_role','fn_prune_horse_adaptive_journal()','EXECUTE');",'original-rpc-authority-preserved')
 assert read(base,'SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid=ANY(ARRAY['+funcs+']);','unchanged-original-helper-hashes')==unchanged;checks.append('original-qualifiers-byte-identical')
 e.report['adaptive_capacity_postimage']=json.loads(read(base,"SELECT jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'settings',proconfig) FROM pg_proc WHERE oid='fn_prune_horse_adaptive_journal()'::regprocedure;",'capacity-final-postimage'))
 e.report['adaptive_capacity_proven']=checks;e.discard(original);e.discard(fixture);e.discard(base);return checks
