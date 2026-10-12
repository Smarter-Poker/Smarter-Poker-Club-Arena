#!/usr/bin/env python3
"""Real original hand disposal + real atomic review publication qualification."""
import json,sys,hashlib,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,lit
MIGRATION=Path('supabase/migrations/20261012170902_settled_horse_reviews_erase_raw_play_after_eight_days.sql')
def qualify(e,template,keep_template=False):
 old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','review_raw_old')
 hhr=module(ROOT/'scripts/ci/test-horse-hand-review-atomic.py','review_raw_atomic')
 checks=[]
 def yes(db,q,label):
  _,v,_=e.sql(db,q,label=label);assert v.strip()=='t',(label,v);checks.append(label)
 world=e.database(template)
 schema=(ROOT/'tests/sql/fixtures/horse-hand-review-atomic/schema.sql').read_text()
 for role in ['anon','authenticated','service_role']:
  schema=schema.replace('CREATE ROLE '+role+' NOLOGIN'+(' BYPASSRLS' if role=='service_role' else '')+';','')
 e.sql(world,schema,label='review-real-schema')
 for name in ['20261007020953_horse_hand_review_atomic_publication.sql','20261008041150_horse_hand_review_receipts_retention.sql']:
  e.sql(world,file=ROOT/'supabase/migrations'/name,label='review-original-'+name[:14])
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb", "jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))").replace("interval '30 days'","interval '20 days'")+"\nUPDATE public.hand_history SET has_human=false;\n"
 def publish(db,hand=old.HAND_ID,horse=old.HORSE,over=None):
  _,date,_=e.sql(db,"SELECT to_char(now()-interval '20 days','YYYY-MM-DD\"T\"HH24:MI:SS.USOF');",label='review-clock')
  row=hhr.row(hand,horse,table_id=old.TABLE,played_at=date.strip(),**(over or {}))
  e.sql(db,'SELECT fn_hhr_record_atomic('+hhr.literal([row])+');',label='review-real-publication');return row
 before=e.database(world);e.sql(before,seed,label='review-before-seed');publish(before)
 e.sql(before,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='review-original-disposal')
 yes(before,'SELECT hole_cards IS NOT NULL AND board IS NOT NULL AND actions IS NOT NULL FROM horse_hand_reviews;','fail-before-review-raw-outlives-eight-days');e.discard(before)
 e.sql(world,file=ROOT/MIGRATION,label='review-exact-candidate')
 code,_,err=e.sql(world,file=ROOT/MIGRATION,label='review-migration-replay-refused',check=False);assert code!=0 and 'HORSE_REVIEW_RETENTION_PREIMAGE_CHANGED' in err;checks.append('review-migration-replay-refused')
 case=e.database(world);e.sql(case,seed,label='review-qualified-seed');row=publish(case)
 e.sql(case,"CREATE TABLE review_before AS SELECT to_jsonb(r)-ARRAY['hole_cards','board','actions'] AS derived FROM horse_hand_reviews r; CREATE TABLE review_rollup_before AS SELECT to_jsonb(r) AS value FROM horse_review_rollup r; CREATE TABLE review_receipt_before AS SELECT to_jsonb(r) AS value FROM horse_hand_review_receipts r;",label='review-independent-baselines')
 e.sql(case,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='review-actual-owner-retention')
 yes(case,'SELECT hole_cards IS NULL AND board IS NULL AND actions IS NULL FROM horse_hand_reviews;','review-original-disposal-erases-raw')
 yes(case,"SELECT (SELECT derived FROM review_before)=(SELECT to_jsonb(r)-ARRAY['hole_cards','board','actions'] FROM horse_hand_reviews r) AND (SELECT value FROM review_rollup_before)=(SELECT to_jsonb(r) FROM horse_review_rollup r) AND (SELECT value FROM review_receipt_before)=(SELECT to_jsonb(r) FROM horse_hand_review_receipts r);",'review-every-derived-rollup-receipt-byte-identical')
 _,reply,_=e.sql(case,'SELECT fn_hhr_record_atomic('+hhr.literal([row])+');',label='review-exact-replay');assert json.loads(reply)['rows'][0]['status']=='replayed';checks.append('review-real-replay-after-compaction')
 changed=dict(row);changed['net_amount']=49
 code,_,err=e.sql(case,'SELECT fn_hhr_record_atomic('+hhr.literal([changed])+');',label='review-changed-money-refused',check=False);assert code!=0 and 'hhr_identity_conflict' in err;checks.append('review-conflicting-replay-still-refused')
 e.sql(case,"UPDATE horse_hand_reviews SET hole_cards='[\"As\"]',board='[\"Kd\"]',actions='[{}]';",label='review-restoration-attempt')
 yes(case,'SELECT hole_cards IS NULL AND board IS NULL AND actions IS NULL FROM horse_hand_reviews;','review-raw-cannot-return')
 late=publish(case,horse='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
 yes(case,"SELECT hole_cards IS NULL AND board IS NULL AND actions IS NULL FROM horse_hand_reviews WHERE horse_user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';",'review-late-publication-retention-safe')
 e.sql(case,"BEGIN; UPDATE horse_hand_reviews SET review_status='resolved'; ROLLBACK;",label='review-rollback')
 yes(case,"SELECT bool_and(review_status='auto_reviewed') FROM horse_hand_reviews;",'review-diagnostics-rollback-atomic')
 e.sql(case,'SELECT sp_prune_horse_hand_reviews(); SELECT sp_prune_horse_hand_reviews();',label='review-existing-owner-repeat')
 yes(case,'SELECT count(*)=2 FROM horse_hand_reviews;','review-thirty-day-derived-window-preserved');e.discard(case)
 # The real publisher holds the shared original-hand reservation while the
 # disposal transaction arrives. Its committed raw row must be redacted after
 # that wait, rather than escaping between two independent snapshots.
 race=e.database(world);e.sql(race,seed,label='review-race-seed')
 _,date,_=e.sql(race,"SELECT to_char(now()-interval '20 days','YYYY-MM-DD\"T\"HH24:MI:SS.USOF');",label='review-race-clock')
 raced=hhr.row(old.HAND_ID,old.HORSE,table_id=old.TABLE,played_at=date.strip())
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',race,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write("BEGIN; SELECT fn_hhr_record_atomic("+hhr.literal([raced])+" ); SELECT 'published'; SELECT pg_sleep(1); COMMIT;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='published':
  if lock.poll() is not None:raise RuntimeError('review race publisher failed')
 e.sql(race,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='review-concurrent-owner-disposal')
 lock.wait(timeout=10);assert lock.returncode==0,lock.stderr.read()
 yes(race,'SELECT hole_cards IS NULL AND board IS NULL AND actions IS NULL FROM horse_hand_reviews;','review-concurrent-publication-cannot-escape-retention');e.discard(race)
 for name,change in [('mixed',"UPDATE hand_history SET has_human=true;"),('original-human',"ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER hand_submission_immutable; UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,has_human}','true'); ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER hand_submission_immutable;"),('unknown',"DELETE FROM profiles;"),('failed',"UPDATE hand_atomic_commits SET post_commit_result='{\"ok\":false}';"),('young',"UPDATE hand_atomic_commits SET post_commit_completed_at=now();")]:
  case=e.database(world);e.sql(case,seed+change,label='review-'+name+'-seed');publish(case)
  e.sql(case,"UPDATE horse_hand_reviews SET created_at=now()-interval '40 days';"+old.AUTHORITY+'SELECT sp_prune_hand_history(10); SELECT sp_prune_horse_hand_reviews();',label='review-'+name+'-owners')
  yes(case,'SELECT count(*)=1 AND bool_and(hole_cards IS NOT NULL AND board IS NOT NULL AND actions IS NOT NULL) FROM horse_hand_reviews;','review-'+name+'-raw-and-row-preserved')
  for op in ['DELETE FROM horse_hand_reviews','TRUNCATE horse_hand_reviews']:
   code,_,err=e.sql(case,op,label='review-'+name+'-direct-'+op.split()[0].lower()+'-refused',check=False);assert code!=0 and 'HORSE_REVIEW_PROTECTED_SOURCE' in err;checks.append('review-'+name+'-direct-'+op.split()[0].lower()+'-refused')
  e.discard(case)
 _,cat,_=e.sql(world,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text)) FROM pg_proc p WHERE p.proname IN('horse_review_raw_disposable','horse_review_raw_retention_guard','compact_horse_review_raw','horse_review_raw_on_disposal','sp_prune_horse_hand_reviews');",label='review-qualified-postimages')
 e.report['review_qualified_postimages']=json.loads(cat)
 e.report['review_raw_retention']={'status':'passed','proven':checks,'migration':str(MIGRATION),'sha256':hashlib.sha256((ROOT/MIGRATION).read_bytes()).hexdigest()};
 if keep_template:return world
 e.discard(world)
 return checks
