"""Actual captured fact schema plus nine production rollup bodies. Native only.
Caller supplies isolated template with strict qualifier, adaptive certificate,
and cash243 preimage installed. No production connection is accepted here.
"""
import json,re,subprocess
from satellite_qualifier_fixture import module,sha,lit
FIX='scripts/verification-harness/horse-fact-card-preimage.json'

def qualify(e,template,migration,keep_template=False):
 root=e.root;passed=[];base=e.database(template)
 e.sql(base,'REVOKE ALL ON FUNCTION smarter_private.hand_submission_immutable() FROM PUBLIC,anon,authenticated,service_role;',label='facts-original-raw-row-owner-authority')
 e.sql(base,'ALTER TABLE public.hand_atomic_commits ADD COLUMN IF NOT EXISTS post_commit_payload jsonb;',label='facts-actual-atomic-stats-column')
 data=json.loads((root/FIX).read_text())
 e.report.setdefault('source_sha256',{}).update({FIX:sha(root/FIX),str(migration):sha(root/migration),'scripts/verification-harness/horse-fact-card-proof.py':sha(root/'scripts/verification-harness/horse-fact-card-proof.py')})
 def yes(db,sql,label):
  _,v,_=e.sql(db,sql,label='facts-'+label);assert v.strip()=='t',(label,v);passed.append(label)
 def read(db,sql,label):return e.sql(db,sql,label='facts-'+label)[1].strip()
 tables=sorted(set(c['relname'] for c in data['columns']))
 for table in tables:
  cols=[c for c in data['columns'] if c['relname']==table]
  ddl='DROP TABLE IF EXISTS public.'+table+' CASCADE;CREATE TABLE public.'+table+'('+','.join('"'+c['attname']+'" '+c['type']+(' DEFAULT '+c['default_expression'] if c['default_expression'] else '')+(' NOT NULL' if c['attnotnull'] else '') for c in cols)+');'
  e.sql(base,ddl,label='facts-schema-'+table)
 for t,keys in [('ca_hand_facts','hand_id,user_id'),('club_member_daily_facts','club_id,user_id,played_on,game_variant,is_mtt'),('club_member_play_totals','club_id,user_id'),('club_roster_hand_totals','club_id,user_id')]:e.sql(base,'ALTER TABLE public.'+t+' ADD UNIQUE('+keys+');',label='facts-conflict-'+t)
 for f in data['functions']:
  if f['signature'].startswith('smarter_private.'):continue
  e.sql(base,f['definition'],label='facts-exact-'+f['signature'])
  e.sql(base,'REVOKE ALL ON FUNCTION public.'+f['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION public.'+f['signature']+' TO service_role;' if 'service_role=' in f['acl'] else ''),label='facts-exact-authority-'+f['signature'])
  yes(base,"SELECT md5(pg_get_functiondef('public."+f['signature']+"'::regprocedure))="+lit(f['definition_md5'])+';','captured-'+f['signature'])
 for name in ['20261010064938_player_command_hand_totals_advance_with_their_facts.sql','20261010073005_player_command_retained_play_totals_advance_atomically.sql','20261010090246_player_command_utc_daily_facts_advance_atomically.sql']:
  source=(root/'supabase/migrations'/name).read_text()
  bindings=re.findall(r'CREATE TRIGGER\s+[\s\S]*?EXECUTE FUNCTION public\.fn_club_[\s\S]*?;',source)
  assert len(bindings)==3,(name,len(bindings))
  for i,b in enumerate(bindings):e.sql(base,b,label='facts-original-trigger-'+name[:14]+'-'+str(i))
 old=module(root/'scripts/ci/test-hand-submission-retention-disposal.py','facts_old')
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")+"UPDATE public.hand_history SET has_human=false;"
 # Populate every captured derived field, independently snapshot all columns.
 values=[];columns=[]
 special={'hand_id':"'"+old.HAND_ID+"'::uuid",'user_id':"'"+old.HORSE+"'::uuid",'table_id':"'"+old.TABLE+"'::uuid",'club_id':"'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid",'tournament_id':'NULL','played_at':"now()-interval '30 days'",'hole_cards':"'[\"As\",\"Ks\"]'::jsonb"}
 for c in data['columns']:
  if c['relname']!='ca_hand_facts':continue
  k=c['attname'];typ=c['type'];columns.append('"'+k+'"')
  values.append(special.get(k, 'true' if typ=='boolean' else "'{}'::jsonb" if typ=='jsonb' else "'{}'::uuid[]" if typ=='uuid[]' else "'{}'::text[]" if typ=='text[]' else "now()-interval '30 days'" if 'timestamp' in typ else "'derived'" if typ=='text' else "'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid" if typ=='uuid' else '3'))
 facts='INSERT INTO public.ca_hand_facts('+','.join(columns)+') VALUES('+','.join(values)+');'
 snap="SELECT jsonb_build_object('facts',(SELECT jsonb_agg(to_jsonb(f)-'hole_cards' ORDER BY user_id) FROM public.ca_hand_facts f),'daily',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.club_member_daily_facts t),'play',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.club_member_play_totals t),'roster',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.club_roster_hand_totals t));"
 before=e.database(base);e.sql(before,seed+facts+"UPDATE public.hand_history SET has_human=true;",label='facts-mixed-before-seed');original=read(before,snap,'before-snapshot');e.sql(before,'SELECT fn_prune_ca_hand_facts(250);',label='facts-old-prune')
 yes(before,'SELECT NOT EXISTS(SELECT 1 FROM ca_hand_facts) AND (SELECT hands=0 FROM club_member_play_totals) AND (SELECT hands=0 FROM club_roster_hand_totals) AND (SELECT hands=0 FROM club_member_daily_facts);','fail-before-mixed-horse-fact-and-all-three-counter-loss');e.discard(before)
 e.sql(base,file=root/migration,label='facts-exact-candidate')
 code,_,err=e.sql(base,file=root/migration,label='facts-replay-refusal',check=False);assert code and 'ALREADY_INSTALLED' in err;passed.append('migration-replay-refused')
 for name,change in [('qualified',''),('mixed','UPDATE public.hand_history SET has_human=true;'),('unknown','UPDATE public.hand_history SET has_human=NULL;'),('human','UPDATE public.profiles SET is_horse=false;'),('unfinished','UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL;'),('failed','UPDATE public.hand_atomic_commits SET post_commit_result=\'{"ok":false}\'::jsonb;'),('reported','UPDATE public.hand_history SET reported=true;'),('stats-conflict',''),('rogue-fact',''),('missing-basis','')]:
  db=e.database(base);e.sql(db,seed+facts+change,label='facts-'+name+'-seed')
  # Accepted stats capsule copied from actual complete fact row; no raw hand tuple.
  e.sql(db,"ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER USER;UPDATE smarter_private.hand_submissions SET request=jsonb_set(request,'{p_hand_row,_accepted_post_commit_facts}',jsonb_build_object('stats_facts',jsonb_build_object('version',2,'facts',(SELECT jsonb_agg(to_jsonb(f)) FROM public.ca_hand_facts f),'transfers','[]'::jsonb)));ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER USER;UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object('accepted_hand_facts',jsonb_build_object('stats_facts',(SELECT request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}' FROM smarter_private.hand_submissions)));",label='facts-'+name+'-accepted-stats-fixture')
  current=read(db,snap,name+'-original-derived')
  original_basis=read(db,"SELECT jsonb_build_object('sha',encode(extensions.digest(convert_to((request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}')::text,'UTF8'),'sha256'),'hex'),'compact',jsonb_set(request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}','{facts}',(SELECT jsonb_agg(to_jsonb(f)-'hole_cards') FROM public.ca_hand_facts f))) FROM smarter_private.hand_submissions;",name+'-original-basis')
  if name=='qualified':
   disposal_source=next(f['definition'] for f in data['functions'] if f['signature'].startswith('smarter_private.hand_submission_retention_disposal'))
   start=disposal_source.index('  INSERT INTO smarter_private.hand_submission_disposals');end=disposal_source.index('  GET DIAGNOSTICS',start)
   original_insert=disposal_source[start:end].replace('p_hand_ids',"ARRAY['"+old.HAND_ID+"'::uuid]").replace('p_reason',lit('Native original settled horse retention verification'))
   e.sql(db,original_insert,label='facts-actual-original-disposal-record-fixture')
   raw=e.database(db);code,_,err=e.sql(raw,"UPDATE smarter_private.hand_submissions SET request='{}'::jsonb;",label='facts-direct-raw-erasure-without-basis-refused',check=False);assert code and 'immutable' in err.lower();passed.append('direct-qualified-raw-erasure-without-capsule-refused');e.discard(raw)
   e.sql(db,"SELECT smarter_private.capture_horse_adaptive_disposals(ARRAY['"+old.HAND_ID+"'::uuid]);SELECT smarter_private.capture_horse_stats_basis(ARRAY['"+old.HAND_ID+"'::uuid]);",label='facts-original-certificate-and-capsule-capture')
   holder=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    holder.stdin.write('BEGIN;UPDATE public.ca_hand_facts SET hole_cards=hole_cards;SELECT \'held\';\n');holder.stdin.flush();assert holder.stdout.readline().strip()=='held'
    yes(db,"SELECT smarter_private.compact_horse_fact_cards(ARRAY['"+old.HAND_ID+"'::uuid])=0 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals);",'concurrent-shared-fact-admission-skips-exclusive-retirement')
    yes(db,"SELECT bool_and(hole_cards IS NOT NULL) FROM public.ca_hand_facts;",'concurrent-busy-retirement-preserves-cards')
    holder.stdin.write('COMMIT;\n');holder.stdin.close();holder.wait(timeout=10);assert holder.returncode==0
   finally:
    if holder.poll() is None:holder.terminate();holder.wait(timeout=10)
  if name=='missing-basis':
   e.sql(db,"ALTER TABLE smarter_private.hand_submissions DISABLE TRIGGER USER;UPDATE smarter_private.hand_submissions SET request=request#-'{p_hand_row,_accepted_post_commit_facts,stats_facts}';ALTER TABLE smarter_private.hand_submissions ENABLE TRIGGER USER;UPDATE hand_atomic_commits SET post_commit_payload=post_commit_payload#-'{accepted_hand_facts,stats_facts}';",label='facts-unknown-original-derived-basis')
   e.sql(db,old.AUTHORITY+'SELECT sp_prune_hand_history(10);SELECT fn_prune_ca_hand_facts(250);',label='facts-missing-basis-owner-protects-cards')
   yes(db,"SELECT bool_and(hole_cards IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals) FROM ca_hand_facts;",'missing-original-stats-basis-protects-existing-cards');assert json.loads(current)==json.loads(read(db,snap,'missing-basis-derived-after'));passed.append('missing-basis-all-derived-fields-and-rollups-preserved');e.discard(db);continue
  if name=='rogue-fact':
   e.sql(db,"INSERT INTO ca_hand_facts SELECT (jsonb_populate_record(NULL::public.ca_hand_facts,to_jsonb(f)||jsonb_build_object('user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))).* FROM ca_hand_facts f;",label='facts-unrelated-admitted-row')
   rogue=read(db,snap,'rogue-derived-before');e.sql(db,old.AUTHORITY+'SELECT sp_prune_hand_history(10);SELECT fn_prune_ca_hand_facts(250);',label='facts-unrelated-cards-owner-refuses')
   yes(db,"SELECT bool_and(hole_cards IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals) FROM ca_hand_facts;",'unrelated-fact-roster-cards-protected');assert json.loads(rogue)==json.loads(read(db,snap,'rogue-derived-after'));passed.append('unrelated-fact-all-derived-fields-and-rollups-preserved');e.discard(db);continue
  if name=='stats-conflict':
   e.sql(db,"UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_set(post_commit_payload,'{accepted_hand_facts,stats_facts,version}','1'::jsonb);",label='facts-conflicting-atomic-last-basis')
   code,_,err=e.sql(db,old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='facts-conflict-original-transition-refused',check=False);assert code and 'HORSE_STATS_BASIS' in err
   yes(db,"SELECT request<>'{}'::jsonb AND EXISTS(SELECT 1 FROM hand_history) AND EXISTS(SELECT 1 FROM hand_atomic_commits) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates) FROM smarter_private.hand_submissions;",'conflicting-last-stats-copy-rolls-back-entire-owner-transition')
   assert json.loads(current)==json.loads(read(db,snap,'conflict-derived-retained'));passed.append('conflicting-last-basis-preserves-all-facts-and-rollups');e.discard(db);continue
  e.sql(db,old.AUTHORITY+'SELECT sp_prune_hand_history(10);SELECT fn_prune_ca_hand_facts(250);',label='facts-'+name+'-original-retention-owner')
  assert json.loads(current)==json.loads(read(db,snap,name+'-retained-derived'));passed.append(name+'-all-noncard-fields-and-three-rollups-identical')
  if name=='qualified':
   basis=read(db,"SELECT jsonb_build_object('sha',original_stats_sha256,'compact',compact_stats) FROM smarter_private.horse_retained_stats_basis;",'qualified-final-capsule');assert json.loads(basis)==json.loads(original_basis);passed.append('original-stats-digest-and-every-derived-basis-field-exact')
   yes(db,"SELECT (SELECT bool_and(hole_cards IS NULL) FROM ca_hand_facts) AND request='{}'::jsonb AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=submission_id AND b.compact_stats#>'{facts,0,hole_cards}' IS NULL AND b.compact_stats->>'version'='2' AND b.original_stats_sha256~'^[a-f0-9]{64}$') FROM smarter_private.hand_submissions;",'qualified-cards-erased-basis-captured-before-original-erasure')
   e.sql(db,"UPDATE ca_hand_facts SET hole_cards='[\"Ah\",\"Kh\"]';",label='facts-restoration-attempt');yes(db,'SELECT bool_and(hole_cards IS NULL) FROM ca_hand_facts;','retired-cards-cannot-be-restored')
   e.sql(db,"INSERT INTO ca_hand_facts SELECT (jsonb_populate_record(NULL::public.ca_hand_facts,to_jsonb(f)||jsonb_build_object('user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','hole_cards',jsonb_build_array('Ah','Kh')))).* FROM ca_hand_facts f;",label='facts-unrelated-after-retirement-admission')
   yes(db,"SELECT hole_cards IS NOT NULL FROM ca_hand_facts WHERE user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';",'retired-hand-does-not-strip-unrelated-new-fact-cards')
   for op in ['UPDATE smarter_private.horse_retained_stats_basis SET compact_stats=\'{}\';','DELETE FROM smarter_private.horse_retained_stats_basis;','TRUNCATE smarter_private.horse_retained_stats_basis;','SET ROLE service_role;SELECT smarter_private.compact_horse_fact_cards(ARRAY[\''+old.HAND_ID+'\'::uuid]);']:
    code,_,err=e.sql(db,op,label='facts-immutability-or-authorization',check=False);assert code and ('IMMUTABLE' in err or 'permission denied' in err);passed.append('basis-or-retirement-mutation-refused')
  else:yes(db,"SELECT bool_and(hole_cards IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis) AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals) FROM ca_hand_facts;",name+'-raw-cards-and-original-basis-protected')
  e.discard(db)
 # Real captured cash seed with well-shaped accepted v2 derived facts, shared
 # byte-for-byte in original request and atomic accepted payload before receipt.
 cashhand='c2000000-0000-4000-8000-000000000001';cashtable='c1000000-0000-4000-8000-000000000001';cashuser='c5000000-0000-4000-8000-000000000001';ids="ARRAY['"+cashhand+"'::uuid]"
 stats=json.dumps({'version':2,'facts':[{'hand_id':cashhand,'table_id':cashtable,'user_id':cashuser,'hole_cards':['As','Kd'],'net':0,'rake_paid':0,'vpip':True}],'transfers':[]},separators=(',',':'))
 cashseed=(root/'scripts/verification-harness/fixtures/horse-cash-play-contents/seed.sql').read_text().replace('{"version":1,"private_holding":["As","Kd"]}',stats)
 cashseed="BEGIN;INSERT INTO public.hand_history_retention_policy(horse_retention_days) VALUES(8);"+cashseed+"INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),now(),now());INSERT INTO public.union_pnl_cash_outcomes(table_id,hand_number,hand_id,transaction_id,recognized_at,payload_hash,game_scope,evidence) SELECT a.table_id,a.hand_number,a.hand_id,pg_current_xact_id(),a.committed_at,a.payload_hash,p.game_scope,public.fn_pnl_cash_hand_evidence(a.table_id,a.hand_number) FROM public.hand_atomic_commits a JOIN public.cash_hand_provenance_receipts p USING(table_id,hand_number);COMMIT;"
 cash=e.database(base);e.sql(cash,cashseed,label='facts-cash-valid-original-stats-seed')
 evidence="SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence('"+cashtable+"',1000001),'money',(SELECT jsonb_agg(to_jsonb(l)) FROM chip_ledger l),'stack',stack_result) FROM hand_atomic_commits;"
 original=read(cash,evidence,'cash-original-derived-money-evidence')
 missing=e.database(cash);e.sql(missing,'SELECT smarter_private.compact_horse_settlement_keys('+ids+');',label='facts-cash-original-key-transition');yes(missing,'SELECT smarter_private.compact_horse_cash_play_contents('+ids+')=0;','cash-missing-basis-cannot-erase-raw');yes(missing,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL FROM cash_hand_provenance_receipts;",'cash-missing-basis-raw-copies-remain');e.discard(missing)
 e.sql(cash,"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash,retained_at) SELECT hand_id,table_id,hand_number,'settled-native','9b300000-0000-4000-8000-000000000001',jsonb_build_object('p_stacks',accepted_request->'stacks','p_hand_row',accepted_request->'hand_row'),repeat('a',64),now()-interval '30 days' FROM cash_hand_provenance_receipts;",label='facts-cash-original-submission')
 wrong=e.database(cash)
 e.sql(wrong,old.AUTHORITY+"SELECT smarter_private.hand_submission_retention_disposal("+ids+",'Native original retention proof of fully settled horse hand');SELECT smarter_private.capture_horse_adaptive_disposals("+ids+");SELECT smarter_private.capture_horse_stats_basis("+ids+");ALTER TABLE smarter_private.horse_retained_stats_basis DISABLE TRIGGER USER;UPDATE smarter_private.horse_retained_stats_basis SET original_stats_sha256=repeat('0',64);ALTER TABLE smarter_private.horse_retained_stats_basis ENABLE TRIGGER USER;SELECT smarter_private.compact_horse_settlement_keys("+ids+");",label='facts-cash-isolated-wrong-capsule-digest')
 yes(wrong,'SELECT smarter_private.compact_horse_cash_play_contents('+ids+')=0;','cash-different-basis-digest-cannot-erase-raw');yes(wrong,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL AND atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NOT NULL FROM cash_hand_provenance_receipts;",'cash-different-basis-retains-both-original-copies');e.discard(wrong)
 naked=e.database(cash)
 e.sql(cash,old.AUTHORITY+'SELECT public.sp_prune_hand_history(250);',label='facts-cash-connected-original-owner')
 yes(cash,"SELECT accepted_request#>'{hand_row,actions}' IS NULL AND accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}' IS NULL AND atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=p.hand_id AND b.compact_stats->>'version'='2' AND b.compact_stats#>'{facts,0,hole_cards}' IS NULL) FROM cash_hand_provenance_receipts p;",'cash-exact-basis-captured-before-all-raw-copies-erased')
 final=read(cash,"SELECT jsonb_build_object('evidence',public.fn_pnl_cash_hand_evidence('"+cashtable+"',1000001),'money',(SELECT jsonb_agg(to_jsonb(l)) FROM chip_ledger l),'stack',smarter_private.horse_settlement_original_result(table_id,hand_id,result)) FROM settlement_idempotency_keys;",'cash-retained-derived-money-evidence');assert json.loads(original)==json.loads(final);passed.append('cash-connected-original-prune-money-evidence-stack-response-identical')
 certificate=read(cash,'SELECT to_jsonb(c) FROM smarter_private.horse_cash_payload_certificates c;','cash-real-erasure-certificate')
 e.sql(naked,'INSERT INTO smarter_private.horse_cash_payload_certificates SELECT (jsonb_populate_record(NULL::smarter_private.horse_cash_payload_certificates,'+lit(certificate)+'::jsonb)).*;',label='facts-cash-exact-certificate-but-no-basis')
 code,_,err=e.sql(naked,'UPDATE public.cash_hand_provenance_receipts SET accepted_request=smarter_private.horse_cash_compact_request(accepted_request),atomic_receipt=smarter_private.horse_cash_compact_atomic(atomic_receipt);',label='facts-direct-cash-owner-no-basis-refused',check=False);assert code and 'immutable' in err.lower();passed.append('direct-cash-owner-even-exact-erasure-certificate-requires-basis');yes(naked,"SELECT accepted_request#>'{hand_row,actions}' IS NOT NULL AND atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NOT NULL FROM cash_hand_provenance_receipts;",'direct-cash-owner-refusal-preserves-original-copies');e.discard(naked)
 call="SELECT public.fn_ca_settle_hand_stacks_absolute('"+cashtable+"',1000001,(SELECT result->'request'->'stacks' FROM key_test.original),0,0,'',0);"
 response=read(cash,call,'cash-exact-original-replay');assert json.loads(response)==dict(json.loads(original)['stack'],replay=True);passed.append('cash-exact-original-replay-after-basis-and-raw-retirement')
 code,_,err=e.sql(cash,call.replace("0,0,'',0","1,0,'',0"),label='facts-cash-changed-replay-refused',check=False);assert code and 'different payload' in err;passed.append('cash-different-payload-still-refused')
 e.discard(cash)
 _,catalog,_=e.sql(base,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'settings',p.proconfig)) FROM pg_proc p WHERE p.proname IN ('fn_prune_ca_hand_facts','compact_settled_horse_requests','compact_horse_cash_play_contents','hand_submission_immutable','fn_cash_provenance_immutable','horse_compact_stats_basis','horse_stats_basis_immutable','capture_horse_stats_basis','horse_stats_basis_matches','horse_fact_cards_disposable','horse_fact_card_disposal_immutable','horse_fact_retired_cards_stay_erased','compact_horse_fact_cards');",label='facts-qualified-source-function-postimages');e.report['fact_card_postimages']=json.loads(catalog)
 _,catalog,_=e.sql(base,"SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity)) FROM pg_class c WHERE c.oid=ANY(ARRAY['smarter_private.horse_retained_stats_basis'::regclass,'smarter_private.horse_fact_card_disposals'::regclass]);",label='facts-qualified-table-postimages');e.report['fact_card_tables']=json.loads(catalog)
 _,catalog,_=e.sql(base,"SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgname IN('horse_stats_basis_immutable','horse_stats_basis_no_truncate','horse_fact_card_disposal_immutable','horse_fact_card_disposal_no_truncate','zz_horse_fact_retired_cards_stay_erased');",label='facts-qualified-trigger-postimages');e.report['fact_card_triggers']=json.loads(catalog)
 assert e.report['fact_card_postimages']['smarter_private.hand_submission_immutable()']['acl']=='{postgres=X/postgres}'
 e.report['fact_cards_proven']=passed
 if keep_template:return base
 e.discard(base);return passed
