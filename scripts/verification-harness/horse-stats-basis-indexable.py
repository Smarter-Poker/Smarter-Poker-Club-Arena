"""Native original immutable proof uses its existing hand primary key."""
from pathlib import Path
import json,re
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012212443_horse_stats_basis_checks_use_their_original_hand_key.sql')
def qualify(e,template,keep_template=False):
 root=e.root;db=e.database(template);passed=[]
 e.report.setdefault('source_sha256',{}).update({str(MIGRATION):sha(root/MIGRATION),'scripts/verification-harness/horse-stats-basis-indexable.py':sha(Path(__file__))})
 old=module(root/'scripts/ci/test-hand-submission-retention-disposal.py','indexable_original')
 def read(d,q,label):return e.sql(d,q,label='basis-key-'+label)[1].strip()
 def yes(d,q,label):
  assert read(d,q,label)=='t',label;passed.append(label)
 original=read(db,"SELECT pg_get_functiondef('smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)'::regprocedure);",'original-function')
 volume=e.database(db);tour='f2000000-0000-4000-8000-000000000001'
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"')),'tournament_id','"+tour+"'))")
 seed+="UPDATE hand_history SET has_human=false;INSERT INTO tournaments(id,status,variant,tournament_type,bounty_pool,bounty_pool_paid) VALUES('"+tour+"','COMPLETED','holdem','SNG',0,0);UPDATE tables SET tournament_id='"+tour+"';UPDATE hand_history SET tournament_id='"+tour+"';"
 for relation,idcolumn in [('hand_history','id'),('hand_atomic_commits','hand_id'),('smarter_private.hand_submissions','submission_id')]:
  table=relation if '.' in relation else 'public.'+relation
  seed+="INSERT INTO "+table+" SELECT (jsonb_populate_record(NULL::"+table+",to_jsonb(r)||jsonb_build_object('"+idcolumn+"',md5('basis-volume:'||n::text)::uuid,'hand_number',hand_number+n))).* FROM "+table+" r CROSS JOIN generate_series(1,8191) n WHERE r."+idcolumn+"='"+old.HAND_ID+"';"
 # Native original-constructor phase. All original admission/immutability
 # guards are enabled during capture and every measured read/cleanup.
 seed+="ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER USER;UPDATE smarter_private.hand_submissions s SET request=jsonb_set(request,'{p_hand_row,_accepted_post_commit_facts}',jsonb_build_object('stats_facts',jsonb_build_object('version',2,'facts',jsonb_build_array(jsonb_build_object('hand_id',s.submission_id,'table_id',s.table_id,'user_id','"+old.HORSE+"','hole_cards',jsonb_build_array('As','Kd'),'net',0,'rake_paid',0,'vpip',true)),'transfers','[]'::jsonb)));ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER USER;UPDATE hand_atomic_commits a SET post_commit_payload=jsonb_build_object('accepted_hand_facts',jsonb_build_object('stats_facts',(SELECT request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}' FROM smarter_private.hand_submissions s WHERE s.submission_id=a.hand_id)));"
 e.sql(volume,seed,label='basis-key-original-volume-constructors')
 ids='((SELECT array_agg(submission_id) FROM smarter_private.hand_submissions)::uuid[])'
 disposal=read(volume,"SELECT pg_get_functiondef('smarter_private.hand_submission_retention_disposal(uuid[],text)'::regprocedure);",'original-disposal-boundary')
 insert=disposal[disposal.index('  INSERT INTO smarter_private.hand_submission_disposals'):disposal.index('  GET DIAGNOSTICS')]
 insert=insert.replace('p_hand_ids',ids).replace('p_reason',lit('Native original settled horse stats identity volume proof preserves accounting evidence'))
 e.sql(volume,old.AUTHORITY+insert+'SELECT smarter_private.capture_horse_stats_basis('+ids+');',label='basis-key-original-guarded-admission')
 yes(volume,'SELECT count(*)=8192 FROM smarter_private.horse_retained_stats_basis;','8192-original-admitted-capsules')
 snapshot="SELECT md5(jsonb_agg(to_jsonb(b) ORDER BY hand_id)::text) FROM smarter_private.horse_retained_stats_basis b;"
 before_rows=read(volume,snapshot,'original-all-capsules')
 identity=read(volume,"SELECT submission_id::text FROM smarter_private.hand_submissions ORDER BY submission_id DESC LIMIT 1;",'real-original-identity')
 raw=json.loads(read(volume,"SELECT request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}' FROM smarter_private.hand_submissions WHERE submission_id="+lit(identity)+';', 'actual-original-stats'))
 number=read(volume,'SELECT hand_number FROM smarter_private.hand_submissions WHERE submission_id='+lit(identity)+';','actual-original-number')
 args=[lit(identity),lit(old.TABLE),number,lit(json.dumps(raw))+'::jsonb']
 variants=[('valid',args)]
 for label,index,value in [('missing-hand',0,"'ffffffff-ffff-4fff-8fff-ffffffffffff'"),('null-hand',0,'NULL'),('null-table',1,'NULL'),('null-number',2,'NULL'),('null-stats',3,'NULL'),('wrong-table',1,"'ffffffff-ffff-4fff-8fff-ffffffffffff'"),('wrong-number',2,str(int(number)+1))]:
  a=list(args);a[index]=value;variants.append((label,a))
 for label,change in [('changed-cards',lambda x:x['facts'][0].__setitem__('hole_cards',['Ah','Kh'])),('changed-net',lambda x:x['facts'][0].__setitem__('net',1)),('unknown-field',lambda x:x.__setitem__('unknown',True)),('changed-version',lambda x:x.__setitem__('version',1))]:
  value=json.loads(json.dumps(raw));change(value);a=list(args);a[3]=lit(json.dumps(value))+'::jsonb';variants.append((label,a))
 for label,value in [('empty','{}'),('json-null','null'),('array','[]')]:
  a=list(args);a[3]=lit(value)+'::jsonb';variants.append((label,a))
 def vector(d):
  return {label:read(d,'SELECT smarter_private.horse_stats_basis_matches('+','.join(a)+');',label) for label,a in variants}
 baseline=vector(volume);assert baseline['valid']=='t' and all(v=='f' for k,v in baseline.items() if k!='valid');passed.append('original-positive-and-independent-negatives')
 def plan(d,definition,label):
  body=definition.split('AS $function$',1)[1].split('$function$',1)[0].strip()
  for name,value in zip(['p_hand','p_table','p_number','p_stats'],[args[0]+'::uuid',args[1]+'::uuid',args[2]+'::bigint',args[3]]):
   body=re.sub(r'\b'+name+r'\b',lambda _:value,body)
  value=json.loads(read(d,'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body+';',label))[0];scans=[]
  def walk(n):
   if n.get('Relation Name')=='horse_retained_stats_basis':scans.append(n)
   for child in n.get('Plans',[]):walk(child)
  walk(value['Plan']);assert len(scans)==1
  return {'execution_ms':value['Execution Time'],'scan':scans[0]}
 old_plan=plan(volume,original,'original-volume-plan');assert old_plan['scan']['Node Type']=='Seq Scan';passed.append('fail-before-original-identity-scans-capsule-table')
 rollback=e.database(volume);e.sql(rollback,(root/MIGRATION).read_text().replace('COMMIT;','ROLLBACK;'),label='basis-key-install-rollback')
 assert read(rollback,"SELECT pg_get_functiondef('smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)'::regprocedure);",'rollback-definition')==original
 assert read(rollback,snapshot,'rollback-capsules')==before_rows;passed.append('installation-rollback-preserves-every-capsule-and-function');e.discard(rollback)
 e.sql(db,file=root/MIGRATION,label='basis-key-unseeded-install');e.sql(volume,file=root/MIGRATION,label='basis-key-volume-install')
 updated=read(volume,"SELECT pg_get_functiondef('smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)'::regprocedure);",'new-function')
 assert updated.replace('  WHERE b.hand_id=p_hand\n  AND (','  WHERE (')==original;passed.append('every-original-identity-digest-canonical-clause-byte-identical')
 assert vector(volume)==baseline;passed.append('all-original-positive-negative-null-results-identical')
 new_plan=plan(volume,updated,'new-volume-plan');assert new_plan['scan']['Node Type']=='Index Scan' and new_plan['scan']['Index Name'].endswith('pkey');passed.append('existing-hand-primary-key-qualifies-without-full-scan')
 assert read(volume,snapshot,'all-capsules-after')==before_rows;passed.append('every-retained-capsule-byte-identical')
 # Reuse only the maintained original cash constructor, not its unchanged
 # qualification suite. Seed once, clone both readers from the same immutable
 # financial originals, then exercise the actual cleanup owner on both.
 path=root/'scripts/verification-harness/horse-cash-producer-phase-retention.py'
 source=path.read_text();marker=' original=e.database(base);'
 assert source.count(marker)==1
 namespace={'__file__':str(path),'__name__':'basis_index_cash_constructor'}
 exec(compile(source[:source.index(marker)]+' return base,seed,financial\n',str(path),'exec'),namespace)
 cash,seed_cash,financial=namespace['qualify'](e,db)
 e.sql(cash,seed_cash,label='basis-key-real-original-cash-constructor')
 baseline_financial=read(cash,financial,'actual-cash-original-financial-oracle')
 before_cash=e.database(cash);e.sql(before_cash,original,label='basis-key-original-cash-reader')
 after_cash=e.database(cash)
 final_financial=[]
 for label,case in [('old',before_cash),('new',after_cash)]:
  e.sql(case,old.AUTHORITY+'SELECT sp_prune_hand_history(250);',label='basis-key-'+label+'-actual-cash-owner')
  final_financial.append(read(case,financial,label+'-actual-cash-final-financial-oracle'))
  yes(case,"SELECT request='{}'::jsonb AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=submission_id) AND NOT EXISTS(SELECT 1 FROM hand_history) AND NOT EXISTS(SELECT 1 FROM hand_atomic_commits) FROM smarter_private.hand_submissions;",label+'-actual-cash-owner-completes-original-retention')
 assert final_financial[0]==final_financial[1]==baseline_financial
 passed.append('real-old-new-cleanup-preserves-exact-financial-evidence-money-manifest-funding')
 replay="SELECT fn_ca_settle_hand_stacks_absolute('c1000000-0000-4000-8000-000000000001',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0);"
 old_reply=read(before_cash,replay,'old-original-exact-replay')
 assert read(after_cash,replay,'new-original-exact-replay')==old_reply
 passed.append('actual-original-settlement-replay-byte-identical')
 code,_,err=e.sql(after_cash,replay.replace("0,0,'',0","1,0,'',0"),label='basis-key-changed-replay-refused',check=False)
 assert code and 'different payload' in err;passed.append('actual-changed-settlement-replay-still-refused')
 e.discard(before_cash);e.discard(after_cash);e.discard(cash)
 code,_,err=e.sql(db,file=root/MIGRATION,label='basis-key-replay',check=False);assert code and 'HORSE_STATS_INDEXABLE_ORIGINAL_PROOF_CHANGED' in err;passed.append('installed-successor-replay-refused')
 # Fresh human/report guards remain in the original owner, independent of
 # the previously admitted and immutable statistics proof.
 for label,change in [('human','UPDATE profiles SET is_horse=false;'),('reported','UPDATE hand_history SET reported=true;')]:
  child=e.database(volume);e.sql(child,change+old.AUTHORITY+'SELECT sp_prune_hand_history(250);',label='basis-key-fresh-'+label)
  yes(child,"SELECT count(*)=8192 AND bool_and(request<>'{}'::jsonb) FROM smarter_private.hand_submissions;",'fresh-'+label+'-raw-owner-still-protected');e.discard(child)
 yes(db,"SELECT NOT has_function_privilege('anon','smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)','EXECUTE') AND NOT has_function_privilege('service_role','smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)','EXECUTE');",'original-private-authority-unexpanded')
 e.report['stats_basis_indexable_postimage']=json.loads(read(db,"SELECT jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'settings',proconfig) FROM pg_proc WHERE oid='smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)'::regprocedure;",'final-function-metadata'))
 e.report['stats_basis_indexable_plans']={'before':old_plan,'after':new_plan,'limit':'Native8192admittedcapsules; fixture timings are not production capacity proof. Live leaf and postinstallation original job must be measured separately.'}
 e.report['stats_basis_indexable_proven']=passed;e.discard(volume)
 if keep_template:return db
 e.discard(db);return passed
