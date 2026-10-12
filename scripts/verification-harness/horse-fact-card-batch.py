"""One original card UPDATE per qualified batch, actual nine rollup bodies.
Every fixture is inside the existing isolated PostgreSQL owner, never production.
"""
from pathlib import Path
import json,subprocess,time
from satellite_qualifier_fixture import module,sha,lit
MIG=Path('supabase/migrations/20261012174400_horse_fact_cards_retire_in_one_bounded_original_update.sql')
def qualify(e,template,keep_template=False):
 root=e.root;base=e.database(template);passed=[]
 e.report['source_sha256'].update({str(MIG):sha(root/MIG),'scripts/verification-harness/horse-fact-card-batch.py':sha(Path(__file__))})
 old=module(root/'scripts/ci/test-hand-submission-retention-disposal.py','batch_old')
 data=json.loads((root/'scripts/verification-harness/horse-fact-card-preimage.json').read_text())
 def yes(db,q,label):
  _,v,_=e.sql(db,q,label='factbatch-'+label);assert v.strip()=='t',(label,v);passed.append(label)
 def read(db,q,label):return e.sql(db,q,label='factbatch-'+label)[1].strip()
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")+"UPDATE public.hand_history SET has_human=false;"
 columns=[];values=[]
 special={'hand_id':lit(old.HAND_ID)+'::uuid','user_id':lit(old.HORSE)+'::uuid','table_id':lit(old.TABLE)+'::uuid','club_id':"'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid",'tournament_id':'NULL','played_at':"now()-interval '30 days'",'hole_cards':"'[\"As\",\"Ks\"]'::jsonb"}
 for c in data['columns']:
  if c['relname']!='ca_hand_facts':continue
  k=c['attname'];typ=c['type'];columns.append('"'+k+'"')
  values.append(special.get(k,'true' if typ=='boolean' else "'{}'::jsonb" if typ=='jsonb' else "'{}'::uuid[]" if typ=='uuid[]' else "'{}'::text[]" if typ=='text[]' else "now()-interval '30 days'" if 'timestamp' in typ else "'derived'" if typ=='text' else "'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid" if typ=='uuid' else '3'))
 seed+='INSERT INTO public.ca_hand_facts('+','.join(columns)+') VALUES('+','.join(values)+');'
 # 250 distinct identities, exact original rows, distinct retained numeric data.
 for relation,idcolumn,extra in [('hand_history','id',"'hand_number',hand_number+n,'created_at',created_at+make_interval(mins=>n)"),('hand_atomic_commits','hand_id',"'hand_number',hand_number+n"),('smarter_private.hand_submissions','submission_id',"'hand_number',hand_number+n"),('ca_hand_facts','hand_id',"'net',net+n,'rake_paid',rake_paid+n/100.0")]:
  table=relation if '.' in relation else 'public.'+relation
  seed+="INSERT INTO "+table+" SELECT (jsonb_populate_record(NULL::"+table+",to_jsonb(r)||jsonb_build_object('"+idcolumn+"',md5('batch-horse:'||n::text)::uuid,"+extra+"))).* FROM "+table+" r CROSS JOIN generate_series(1,249) n WHERE r."+idcolumn+"='"+old.HAND_ID+"';"
 seed+="ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER USER;UPDATE smarter_private.hand_submissions s SET request=jsonb_set(request,'{p_hand_row,_accepted_post_commit_facts}',jsonb_build_object('stats_facts',jsonb_build_object('version',2,'facts',(SELECT jsonb_agg(to_jsonb(f)) FROM public.ca_hand_facts f WHERE f.hand_id=s.submission_id),'transfers','[]'::jsonb)));ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER USER;UPDATE public.hand_atomic_commits a SET post_commit_payload=jsonb_build_object('accepted_hand_facts',jsonb_build_object('stats_facts',(SELECT request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}' FROM smarter_private.hand_submissions s WHERE s.submission_id=a.hand_id)));"
 ids='ARRAY(SELECT id FROM public.hand_history ORDER BY id)'
 disposal=next(f['definition'] for f in data['functions'] if f['signature'].startswith('smarter_private.hand_submission_retention_disposal'))
 start=disposal.index('  INSERT INTO smarter_private.hand_submission_disposals');end=disposal.index('  GET DIAGNOSTICS',start)
 seed+=disposal[start:end].replace('p_hand_ids',ids).replace('p_reason',lit('Native original settled horse retention batch verification'))
 seed+='SELECT smarter_private.capture_horse_adaptive_disposals('+ids+');SELECT smarter_private.capture_horse_stats_basis('+ids+');'
 seeded=e.database(base);e.sql(seeded,seed,label='factbatch-original-distinct-hand-seed')
 snap="SELECT jsonb_build_object('facts',(SELECT jsonb_agg(to_jsonb(f)-'hole_cards' ORDER BY hand_id,user_id) FROM ca_hand_facts f),'daily',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id,played_on) FROM club_member_daily_facts t),'play',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM club_member_play_totals t),'roster',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM club_roster_hand_totals t),'basis',(SELECT jsonb_agg(to_jsonb(b) ORDER BY hand_id) FROM smarter_private.horse_retained_stats_basis b));"
 original=read(seeded,snap,'original-all-derived-and-capsules')
 # Instrument the actual statement-trigger bodies only in this isolated proof.
 # Their full financial logic remains intact; do not substitute no-op stubs.
 e.sql(seeded,'CREATE TABLE public.batch_native_calls(name text);',label='factbatch-native-invocation-observer')
 names=['fn_club_member_daily_facts_update','fn_club_member_play_totals_update','fn_club_roster_hand_totals_update']
 for name in names:
  source=next(f['definition'] for f in data['functions'] if f['signature']==name+'()')
  assert source.count('BEGIN\n')==1
  e.sql(seeded,source.replace('BEGIN\n',"BEGIN\n INSERT INTO public.batch_native_calls VALUES('"+name+"');\n"),label='factbatch-instrument-actual-'+name)
 before=e.database(seeded);start=time.monotonic();yes(before,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=250;','before-original-250-cards');before_time=time.monotonic()-start
 yes(before,'SELECT count(*)=750 AND count(DISTINCT name)=3 FROM batch_native_calls;','before-750-real-rollup-trigger-invocations')
 assert json.loads(original)==json.loads(read(before,snap,'before-derived-unchanged'));passed.append('before-original-derived-preserved');e.discard(before)
 e.sql(base,file=root/MIG,label='factbatch-qualified-install')
 e.sql(seeded,file=root/MIG,label='factbatch-seeded-install')
 code,_,err=e.sql(base,file=root/MIG,label='factbatch-migration-replay-refusal',check=False);assert code and 'SOURCE_CHANGED_OR_ALREADY_INSTALLED' in err;passed.append('migration-replay-refused')
 rollback=e.database(seeded);e.sql(rollback,'BEGIN;SELECT smarter_private.compact_horse_fact_cards('+ids+');ROLLBACK;',label='factbatch-original-owner-rollback');yes(rollback,'SELECT bool_and(hole_cards IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals) AND NOT EXISTS(SELECT 1 FROM batch_native_calls) FROM ca_hand_facts;','rollback-preserves-all-cards-certificates-and-rollups');e.discard(rollback)
 protected=e.database(seeded);e.sql(protected,"UPDATE public.hand_history SET reported=true WHERE id='"+old.HAND_ID+"';",label='factbatch-one-protected-reported-hand');yes(protected,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=249;','protected-hand-excluded-from-bulk-transition');yes(protected,"SELECT hole_cards IS NOT NULL AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals WHERE hand_id='"+old.HAND_ID+"') FROM ca_hand_facts WHERE hand_id='"+old.HAND_ID+"';",'protected-hand-card-and-disposal-unchanged');assert json.loads(original)==json.loads(read(protected,snap,'protected-derived-unchanged'));passed.append('protected-all-derived-and-capsules-unchanged');e.discard(protected)
 # Actual shared admission lock protects a busy hand while the other249 retire.
 race=e.database(seeded);argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',race,'-v','ON_ERROR_STOP=1'];holder=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  holder.stdin.write("BEGIN;UPDATE ca_hand_facts SET hole_cards=hole_cards WHERE hand_id='"+old.HAND_ID+"';SELECT 'held';\n");holder.stdin.flush();assert holder.stdout.readline().strip()=='held'
  yes(race,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=249;','concurrent-shared-admission-skips-only-busy-hand');yes(race,"SELECT hole_cards IS NOT NULL FROM ca_hand_facts WHERE hand_id='"+old.HAND_ID+"';",'busy-hand-cards-preserved')
  holder.stdin.write('COMMIT;\n');holder.stdin.close();holder.wait(timeout=10);assert holder.returncode==0
  yes(race,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=1;','busy-hand-retires-after-original-admission-completes')
 finally:
  if holder.poll() is None:holder.terminate();holder.wait(timeout=10)
 e.discard(race)
 start=time.monotonic();yes(seeded,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=250;','batch-250-original-cards');after_time=time.monotonic()-start
 yes(seeded,'SELECT count(*)=3 AND count(DISTINCT name)=3 FROM batch_native_calls;','batch-three-real-rollup-trigger-invocations')
 assert json.loads(original)==json.loads(read(seeded,snap,'after-derived-and-capsules'));passed.append('all-noncard-fields-three-rollups-and-capsules-byte-identical')
 yes(seeded,'SELECT bool_and(hole_cards IS NULL) AND (SELECT count(*)=250 FROM smarter_private.horse_fact_card_disposals) FROM ca_hand_facts;','all250-cards-erased-exact-disposal-count')
 yes(seeded,'SELECT smarter_private.compact_horse_fact_cards('+ids+')=0;','replay-noop');yes(seeded,'SELECT count(*)=3 FROM batch_native_calls;','replay-does-not-fire-empty-rollup-update')
 code,_,err=e.sql(seeded,'SET ROLE service_role;SELECT smarter_private.compact_horse_fact_cards(ARRAY[]::uuid[]);',label='factbatch-helper-authority',check=False);assert code and 'permission denied' in err;passed.append('original-helper-authority-preserved')
 _,catalog,_=e.sql(base,"SELECT jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='smarter_private.compact_horse_fact_cards(uuid[])'::regprocedure;",label='factbatch-qualified-postimage')
 e.report['fact_card_batch_postimage']=json.loads(catalog);e.report['fact_card_batch_proven']=passed;e.report['fact_card_batch_timing']={'before_seconds':before_time,'after_seconds':after_time,'isolated_250_hand_fixture_only':True,'production_throughput_verified':False}
 e.discard(seeded)
 if keep_template:return base
 e.discard(base);return passed
