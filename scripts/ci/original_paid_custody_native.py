"""Bounded actual lease and custody-owner races for the original paid entry."""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from satellite_qualifier_fixture import table_sql, exact_table_sql, lit
BASE='supabase/migrations/'
ABORT=BASE+'20260918053310_interrupted_sng_hands_keep_stacks_and_fence_their_original_writers.sql'
SUCCESSOR=BASE+'20260918061004_interrupted_original_hands_fence_their_successor_lease.sql'
GENERATION=BASE+'20260918064213_interrupted_tournament_generation_disposition.sql'
MIXED=BASE+'20260918065923_mixed_generation_disposition_preserves_committed_stacks.sql'

def lease_foundation(e,db,fix):
 # Exact maintained receipt schemas queried by the current lease owner. No
 # abort authority is invoked or fabricated; every receipt table starts empty.
 texts={p:(e.root/p).read_text() for p in (ABORT,SUCCESSOR,GENERATION,MIXED)}
 for p in texts:e.report['source_sha256'][p]=hashlib.sha256((e.root/p).read_bytes()).hexdigest()
 a=texts[ABORT]
 sql=a[a.index('CREATE TABLE smarter_private.f06_unsettled_hand_aborts'):a.index('ALTER TABLE smarter_private.f06_operations ADD COLUMN')]
 sql+=a[a.index('CREATE FUNCTION smarter_private.f06_generation_aborted'):a.index('CREATE FUNCTION smarter_private.f06_aborted_hand_guard')]
 s=texts[SUCCESSOR];sql+=s[s.index('ALTER TABLE smarter_private.f06_unsettled_hand_aborts'):s.index('CREATE OR REPLACE FUNCTION smarter_private.f06_generation_aborted')]
 g=texts[GENERATION];sql+=g[g.index('CREATE TABLE smarter_private.f06_generation_aborts'):g.index('CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_hand_guard')]
 m=texts[MIXED];sql+=m[m.index('CREATE TABLE smarter_private.f06_mixed_aborts'):m.index('CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_hand_guard')]
 rows=json.loads((e.root/fix/'lease-dependencies.json').read_text())+json.loads((e.root/fix/'lease-claim.json').read_text())
 for row in rows:
  if hashlib.md5(row['definition'].encode()).hexdigest()!=row['definition_md5']:raise ValueError('captured lease source changed')
  sig=row['signature'] if '.' in row['signature'].split('(')[0] else 'public.'+row['signature']
  sql+=row['definition']+';\nREVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;\n'
  if 'service_role=X/postgres' in row['acl']:sql+='GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;\n'
 e.sql(db,'BEGIN;\n'+sql+'COMMIT;',label='actual-current-lease-and-receipt-authorities')

CASES={
 'b_busy':(['CUSTODY_OWNER_REFUSAL_PROVEN','CUSTODY_OWNER_ORDER_PROVEN'],set()),
 'b_claim':(['CUSTODY_OWNER_RESULT_PROVEN','CUSTODY_OWNER_HEARTBEAT_PROVEN','CUSTODY_OWNER_WAIT_PROVEN','CUSTODY_OWNER_CLAIM_PROVEN'],{'public.engine_tournament_leases'}),
 'b_changed':(['CUSTODY_OWNER_WAIT_PROVEN','CUSTODY_OWNER_REFUSAL_PROVEN'],{'public.tournament_knockout_candidates'}),
 'b_fresh':(['CUSTODY_OWNER_WAIT_PROVEN','CUSTODY_OWNER_RESULT_PROVEN'],set()),
 'b_frozen':(['CUSTODY_OWNER_WAIT_PROVEN','CUSTODY_OWNER_REFUSAL_PROVEN'],{'public.engine_maintenance_break'}),
 'b_ack_busy':(['CUSTODY_OWNER_REFUSAL_PROVEN','CUSTODY_OWNER_ORDER_PROVEN'],set()),
 'b_ack_wait':(['CUSTODY_OWNER_RESULT_PROVEN','CUSTODY_OWNER_WAIT_PROVEN','CUSTODY_OWNER_ACK_PROVEN'],set()),
}
def validate(code,out,err,names,case):
 waits=0 if case in ('b_busy','b_ack_busy') else 1
 steps=Counter(names)
 if waits:steps[case]+=1
 notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(CUSTODY_OWNER_[A-Z_]+)\s*$',out+'\n'+err,re.M)
 if code or err.strip() or re.search(r'\b(?:ERROR|FATAL|PANIC|WARNING):',out) or notices!=CASES[case][0] or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=steps or out.count('<waiting ...>')!=waits or out.count('<... completed>')!=waits or re.findall(r'^starting permutation: (.*)$',out,re.M)!=[' '.join(names)]:
  raise RuntimeError('actual custody owner race lacks exact evidence: '+case)

def owner_races(e,db,fix,native,changed,inventory):
 spec=(e.root/fix/'owner-races.spec').read_text();body=re.sub(r'^permutation .+$','',spec,flags=re.M)
 permutations=re.findall(r'^permutation .+$',spec,re.M)
 if len(permutations)!=7:raise ValueError('seven actual owner race orders required')
 binary=native.stock_isolationtester(e.pg)
 allsteps=set(re.findall(r'^step "([a-z_]+)"',body,re.M))
 for permutation in permutations:
  names=re.findall(r'"([a-z_]+)"',permutation)
  case=next(n for n in names if n in CASES)
  child=e.database(db)
  e.sql(child,"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp();",label=case+'-fresh-lease')
  before=e.snapshot(child,case+'-owner-before')
  private_before=private_rows(e,child,case+'-private-before')
  rendered=re.sub(r'^step "(?:'+'|'.join(allsteps-set(names))+r')" .*\n','',body,flags=re.M)
  rendered=re.sub(r'session "[^"]+"\n(?:setup [^\n]*\n)?\s*(?=session |$)','',rendered)
  code,out,err=e.run(case+'-owner',[binary,f'host={e.socket} port={e.port} dbname={child} user=postgres'],text=rendered+'\n'+permutation+'\n',check=False,seconds=40)
  validate(code,out,err,names,case)
  for c,o,r in [(1,out,err),(0,'',err),(0,out,'transport failed'),(0,out.replace('PROVEN','MISSING',1),err),(0,out+'\nERROR: false pass',err)]:
   try:validate(c,o,r,names,case)
   except RuntimeError:pass
   else:raise RuntimeError('false owner race accepted')
  after=e.snapshot(child,case+'-owner-after')
  if private_rows(e,child,case+'-private-after')!=private_before:raise RuntimeError('owner race changed private custody')
  allowed=CASES[case][1]|(changed if case in ('b_claim','b_fresh','b_ack_wait') else set())
  if {k for k in before if before[k]!=after[k]}!=allowed:raise RuntimeError('owner race changed financial/custody vector: '+case)
  if case in ('b_claim','b_fresh','b_ack_wait'):inventory(e,child,case)
  e.discard(child);e.report.setdefault('owner_races',[]).append({'case':case,'observed_wait':case not in ('b_busy','b_ack_busy'),'exact_vector':True,'false_evidence_refused':5})

def installer_refusals(e,db,migration,refusal):
 for label,change in (
  ('seat-root',"ALTER FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) SET statement_timeout='1s';"),
  ('assignment-acl',"GRANT EXECUTE ON FUNCTION public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer) TO authenticated;"),
  ('activation-guard',"ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() SET statement_timeout='1s';")):
  refusal(e,db,'original-paid-install-'+label,change,(e.root/migration).read_text(),'ORIGINAL_PAID_AUTHORITY_PREIMAGE_CHANGED')
 e.report['installer_refusals']={'body_acl_guard':3,'full_catalog_and_data_rollback':True}

def postimage(e,db,fix,source):
 _,raw,_=e.sql(db,"""SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'body_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef,'volatility',p.provolatile,'language',l.lanname) ORDER BY p.proname) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.proname IN ('fn_ca_guard_original_paid_stack_receipt','fn_ca_original_paid_stack_must_complete','fn_ca_resume_original_paid_tournament_entry','fn_ca_assign_tournament_player_seat_locked','fn_ca_guard_mtt_admission_contract');""",label='custody-authority-postimage')
 rows=json.loads(raw)
 if len(rows)!=5:raise RuntimeError('five exact custody authorities required')
 original=json.loads((e.root/fix/'activation-guard.json').read_text())[0]
 assignment=next(r for r in rows if r['signature'].startswith('fn_ca_assign_'))
 guard=original['definition'].replace('49383fc3339fb0d380bfad9ab8ecb0c8',assignment['definition_md5'])
 expected={n:hashlib.md5(body.encode()).hexdigest() for n,body in re.findall(r'CREATE FUNCTION public\.(\w+)\([^;]*?AS \$function\$(.*?)\$function\$;',source,re.S)}
 if set(expected)!={'fn_ca_guard_original_paid_stack_receipt','fn_ca_original_paid_stack_must_complete','fn_ca_resume_original_paid_tournament_entry'}:raise ValueError('three bounded source functions required')
 expected['fn_ca_guard_mtt_admission_contract']=hashlib.md5(guard.split('$function$')[1].encode()).hexdigest()
 expected['fn_ca_assign_tournament_player_seat_locked']='f947a153728b6713470695c8b8f68154'
 for r in rows:
  name=r['signature'].split('(')[0]
  config=['search_path=public, pg_temp','statement_timeout=30s'] if name=='fn_ca_assign_tournament_player_seat_locked' else ['search_path=pg_catalog, public'+(', smarter_private' if name=='fn_ca_resume_original_paid_tournament_entry' else '')]
  if r['body_md5']!=expected[name] or r['owner']!='postgres' or r['acl']!='{postgres=X/postgres}' or r['config']!=config or not r['security_definer'] or r['volatility']!='v' or r['language']!='plpgsql':raise RuntimeError('custody postimage differs '+name)
 _,raw,_=e.sql(db,"""SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'policies',(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid),'fks',(SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='f'),'columns',(SELECT jsonb_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'qual',t.tgqual,'args',encode(t.tgargs,'hex'),'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) FROM pg_class c WHERE c.oid='public.tournament_paid_stack_custody_receipts'::regclass;""",label='custody-schema-and-attachments-postimage')
 table=json.loads(raw)
 cols='id transaction_id tournament_id user_id candidate_id entitlement_id source_ledger_id source_wallet_id destination_table_id destination_seat_number grant_chips live_chips_before funded_supply scoring_excess expected state assignment created_at completed_at'.split()
 triggers=[{'name':n,'type':t,'enabled':'O','deferrable':d,'deferred':d,'qual':None,'args':'','function':f+'()'} for n,t,d,f in [('original_paid_custody_completed',21,True,'fn_ca_original_paid_stack_must_complete'),('original_paid_custody_immutable',31,False,'fn_ca_guard_original_paid_stack_receipt'),('original_paid_custody_no_truncate',34,False,'fn_ca_guard_original_paid_stack_receipt')]]
 if table!={'owner':'postgres','acl':'{postgres=arwdDxtm/postgres}','rls':True,'forced':False,'policies':0,'fks':0,'columns':cols,'triggers':triggers}:raise RuntimeError('private receipt schema/trigger attachment differs')
 e.report['postimage']={'functions':rows,'table':table}

def paid_purchase_prevention(e,db,fix):
 capture=json.loads((e.root/fix/'paid-purchase-authority.json').read_text())[0]
 _,actual,_=e.sql(db,"SELECT md5(pg_get_functiondef('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure));",label='actual-paid-purchase-body')
 if actual.strip()!=capture['definition_md5']:raise RuntimeError('qualification purchase owner differs from captured installed owner')
 case=e.database(db)
 e.sql(case,"""BEGIN; SET LOCAL session_replication_role=replica;
 UPDATE public.tournaments SET is_bounty=false,is_pko=false,is_mystery_bounty=false,bounty_amount=0,rebuy_cost=1,buy_in_amount=1,buy_in_fee=0,format_contract='mtt-v1' WHERE id='b7200000-0000-4000-8000-000000000004';
 UPDATE public.table_seats SET left_at=clock_timestamp(),status='left',active_game_scope=NULL,active_parent_key=NULL WHERE id='b7400000-0000-4000-8000-000000000007';
 UPDATE public.tournament_players SET table_id=NULL,seat_number=NULL WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000007';
 UPDATE public.tables SET current_players=1 WHERE id='b7300000-0000-4000-8000-000000000004';
 SET LOCAL session_replication_role=origin; COMMIT;""",label='regular-seatless-purchase-fixture')
 before=e.snapshot(case,'current-purchase-before')
 code,out,err=e.sql(case,file=e.root/fix/'purchase-prevention.sql',label='current-purchase-final-failure',check=False)
 if code!=3 or err.count('NATIVE_PAID_PURCHASE_FINAL_FAILURE_PROVEN')!=1:raise RuntimeError('public purchase late failure not reached: '+err)
 if e.snapshot(case,'current-purchase-rollback')!=before:raise RuntimeError('current public purchase left a debit or custody effect after late failure')
 e.discard(case);e.report['paid_purchase_prevention']={'installed_owner_definition_md5':capture['definition_md5'],'public_caller_final_receipt_failure':True,'real_debit_seat_candidate_reached':True,'complete_business_rollback':True}

def private_rows(e,db,label):
 _,raw,_=e.sql(db,"""CREATE FUNCTION pg_temp.custody_private_rows() RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE r record;v jsonb;data jsonb:='{}'; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='smarter_private'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM smarter_private.%I t',r.relname) INTO v;
 data:=data||jsonb_build_object(r.relname,v); END LOOP; RETURN data; END $$; SELECT pg_temp.custody_private_rows();""",label=label)
 return json.loads(raw)

def acknowledged_install(e,db,fix,migration,refusal):
 capture=json.loads((e.root/fix/'acknowledged-supply-catalog.json').read_text())
 _,raw,_=e.sql(db,"SELECT jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid),'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig) FROM pg_proc WHERE oid='public.fn_ca_tournament_chip_supply(uuid)'::regprocedure;",label='captured-acknowledged-supply-owner')
 if json.loads(raw)!=capture['function']:raise RuntimeError('actual acknowledged supply owner differs')
 _,raw,_=e.sql(db,"""SELECT to_jsonb(q) FROM (SELECT c.oid::regclass::text relation,pg_get_userbyid(c.relowner) owner,c.relacl::text acl,c.relrowsecurity rls,c.relforcerowsecurity force_rls,
 (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
 (SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated)) FROM pg_constraint WHERE conrelid=c.oid) constraints,
 (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(indexrelid),'valid',indisvalid,'ready',indisready)) FROM pg_index WHERE indrelid=c.oid) indexes,
 (SELECT jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(t.oid),'enabled',tgenabled,'function',pg_get_functiondef(tgfoid),'function_md5',md5(pg_get_functiondef(tgfoid)))) FROM pg_trigger t WHERE tgrelid=c.oid AND NOT tgisinternal) triggers,
 (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policy p WHERE polrelid=c.oid) policies
 FROM pg_class c WHERE c.oid='public.tournament_felt_supply_acknowledgements'::regclass) q;""",label='captured-acknowledged-supply-catalog')
 actual=json.loads(raw);expected=capture['table']
 for value in (actual,expected):value['constraints'].sort(key=lambda x:x['name'])
 if actual!=expected:raise RuntimeError('actual acknowledgement catalog differs')
 before=e.snapshot(db,'acknowledged-predecessor-before')
 oldcall="SELECT public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',(SELECT (expected-ARRAY['acknowledged_supply','supply_acknowledgement'])||jsonb_build_object('funded_supply',320000,'scoring_excess',2500) FROM original_paid_fixture.input));"
 code,out,err=e.sql(db,oldcall,label='installed-predecessor-acknowledged-refusal',check=False)
 if code!=3 or 'ORIGINAL_PAID_ASSIGNMENT_REFUSED:' not in err or 'tournament_chip_conservation' not in err:raise RuntimeError('installed acknowledged predecessor refusal not reproduced: '+err)
 if e.snapshot(db,'acknowledged-predecessor-rollback')!=before:raise RuntimeError('acknowledged refusal changed rows')
 for name,mutation in [('body',"ALTER FUNCTION public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb) SET statement_timeout='1s';"),('acl',"GRANT EXECUTE ON FUNCTION public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb) TO service_role;"),('supply-owner',"ALTER FUNCTION public.fn_ca_tournament_chip_supply(uuid) SET statement_timeout='1s';"),('felt-owner',"ALTER FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() SET statement_timeout='1s';"),('felt-attachment',"ALTER TABLE public.table_seats DISABLE TRIGGER zzzzzz_tournament_felt_may_not_exceed_supply;")]:
  refusal(e,db,'acknowledged-install-'+name,mutation,(e.root/migration).read_text(),'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED')
 catalog_before=e.catalog_snapshot(db,'acknowledged-catalog-before')
 e.sql(db,file=e.root/migration,label='acknowledged-corrected-install')
 if e.snapshot(db,'acknowledged-install-after')!=before:raise RuntimeError('acknowledged installation changed original rows')
 catalog_after=e.catalog_snapshot(db,'acknowledged-catalog-after')
 for catalog in (catalog_before,catalog_after):
  catalog['functions']=[r for r in catalog['functions'] if r[1] not in ('fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)','fn_ca_tournament_felt_may_not_exceed_supply()')]
 if catalog_before!=catalog_after:raise RuntimeError('acknowledged successor changed unrelated catalog')
 felt=json.loads((e.root/fix/'felt-guard.json').read_text())['function']
 sql=(e.root/migration).read_text()
 final=re.search(r'(CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_felt_may_not_exceed_supply\(.*?\$function\$\n);',sql,re.S)[1]
 _,raw,_=e.sql(db,"SELECT jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid),'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig) FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure;",label='deferred-custody-guard-postimage')
 want=dict(felt,definition=final,definition_md5=hashlib.md5(final.encode()).hexdigest(),body_md5=hashlib.md5(final.split('$function$')[1].encode()).hexdigest())
 if json.loads(raw)!=want:raise RuntimeError('deferred custody guard postimage differs')
 e.report['deferred_guard_postimage']=want
 call="SELECT public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',(SELECT expected FROM original_paid_fixture.input));"
 case=e.database(db);e.sql(case,felt['definition']+';',label='original-deferred-guard')
 before_case=e.snapshot(case,'original-deferred-before')
 code,out,err=e.sql(case,'BEGIN;'+call+'SET CONSTRAINTS ALL IMMEDIATE;COMMIT;',label='original-deferred-refusal',check=False)
 if code!=3 or 'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY' not in err:raise RuntimeError('original deferred guard did not refuse actual acknowledgement')
 if e.snapshot(case,'original-deferred-rollback')!=before_case:raise RuntimeError('original deferred refusal changed rows')
 e.discard(case)
 for label,change in [('transaction',"transaction_id='1'::xid8"),('occupancy',"assignment=jsonb_set(assignment,'{occupancy_id}',to_jsonb(gen_random_uuid()))"),('grant',"grant_chips=2501,scoring_excess=5001"),('completion',"state='reserved',assignment=NULL,completed_at=NULL"),('expected',"expected=jsonb_set(expected,'{acknowledged_supply}','320001')")]:
  before_case=e.snapshot(db,'deferred-'+label+'-before')
  query='BEGIN;'+call+'SET LOCAL session_replication_role=replica;UPDATE public.tournament_paid_stack_custody_receipts SET '+change+" WHERE id='b7c00000-0000-4000-8000-000000000001';SET LOCAL session_replication_role=origin;SET CONSTRAINTS zzzzzz_tournament_felt_may_not_exceed_supply IMMEDIATE;COMMIT;"
  code,out,err=e.sql(db,query,label='deferred-'+label+'-refusal',check=False)
  if code!=3 or 'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY' not in err:raise RuntimeError('invalid deferred capability accepted '+label+': '+err)
  if e.snapshot(db,'deferred-'+label+'-rollback')!=before_case:raise RuntimeError('deferred refusal changed rows '+label)
 e.report['acknowledged_supply']={'original_installed_refusal':True,'whole_transaction_rollback':True,'current_getter_and_catalog_exact':True,'installer_refusals':5,'funded':317500,'acknowledged':320000,'original_acknowledgement':2500,'recorded_excess':5000,'installation_rows_unchanged':True,'deferred_guard_original_refused':True,'deferred_capability_refusals':5,'unrelated_catalog_unchanged':True}

def validate_complete(r):
 try:
  assert r['original_refusal']['exact_original_body']=='16a587f7567336fe4379135f22e3fb41'
  assert r['original_refusal']['same_input_rejected'] is True and r['original_refusal']['whole_transaction_rollback'] is True
  assert len(r['refusals'])==len(set(r['refusals']))==24 and r['private_role_refusals']==6
  assert len(r['races'])==4 and {x['case'] for x in r['races']}=={'b_same_commit','b_same_rollback','b_other_commit','b_other_rollback'}
  assert all(x['actual_wait'] is True and x['exact_custody_delta'] is True and x['financial_rows_unchanged'] is True and x['false_evidence_refused']==6 for x in r['races'])
  assert {x['case'] for x in r['owner_races']}==set(CASES) and len(r['owner_races'])==7
  assert all(x['exact_vector'] is True and x['false_evidence_refused']==5 and x['observed_wait'] is (x['case'] not in ('b_busy','b_ack_busy')) for x in r['owner_races'])
  assert r['activation']=={'original_guard_refuses':True,'successor_all_pins_pass':True,'assignment_drift_refused':True,'only_abi_row_changed':True}
  assert r['installer_refusals']=={'body_acl_guard':3,'full_catalog_and_data_rollback':True}
  assert len(r['postimage']['functions'])==5 and len(r['postimage']['table']['triggers'])==3
  assert r['successful_transfer']['assertions']==7 and len(r['successful_transfer']['only_custody_rows_changed'])==8
  assert r['private_custody_unchanged'] is True
  assert r['acknowledged_supply']=={'original_installed_refusal':True,'whole_transaction_rollback':True,'current_getter_and_catalog_exact':True,'installer_refusals':5,'funded':317500,'acknowledged':320000,'original_acknowledgement':2500,'recorded_excess':5000,'installation_rows_unchanged':True,'deferred_guard_original_refused':True,'deferred_capability_refusals':5,'unrelated_catalog_unchanged':True}
  assert r['paid_purchase_prevention']=={'installed_owner_definition_md5':'a6adf208eae8476128f197c16f83d6c5','public_caller_final_receipt_failure':True,'real_debit_seat_candidate_reached':True,'complete_business_rollback':True}
  assert r['conserved_hands']['original_public_commit_refused'] is True
  assert r['conserved_hands']['actual_public_commit_and_outbox_completed'] is True
  assert r['conserved_hands']['money_ack_custody_unchanged'] is True
  assert r['conserved_hands']['exact_replay_unchanged'] is True
  assert r['conserved_hands']['zero_stack_vacated_atomically'] is True
  assert r['conserved_hands']['postimage']['definition_md5']=='81fda5e596905c96a07bebfcff7f32b3'
  assert r['conserved_hands']['refusals']==['net-growth','missing-capture','identity','null-identity','cross-table','scope-change','null-stack','public-inflow']
  assert r['conserved_hands']['installer_refusals']==5
 except (KeyError,AssertionError,TypeError):raise RuntimeError('original paid custody qualification is incomplete')
 return True

def conserved_hands(e,db,fix,migration,refusal):
 """The final installed public hand chain, through real deferred COMMIT and outbox."""
 case=e.database(db)
 rows=json.loads((e.root/fix/'hand-authorities.json').read_text())
 deps=json.loads((e.root/fix/'hand-dependencies.json').read_text())
 post=json.loads((e.root/fix/'hand-postcommit.json').read_text())
 tables=json.loads((e.root/fix/'hand-relations.json').read_text())
 tables+=json.loads((e.root/fix/'hand-postcommit-tables.json').read_text())['capture']['tables']
 for row in tables:
  for index in row['indexes'] or []:
   if index.pop('valid',True) is not True or index.pop('ready',True) is not True:raise ValueError('invalid captured hand index')
   if 'name' not in index:index['name']=re.search(r'CREATE (?:UNIQUE )?INDEX ([^ ]+) ON ',index['definition'])[1]
 sql="BEGIN; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_sequence WHERE seqrelid='public.ca_seat_stack_rebases_id_seq'::regclass AND seqtypid='bigint'::regtype AND seqstart=1 AND seqincrement=1 AND seqmin=1 AND seqmax=9223372036854775807 AND seqcache=1 AND NOT seqcycle) THEN RAISE EXCEPTION 'actual rebase sequence differs'; END IF; END $$;\n"
 for row in tables:
  capture=dict(row);schema=capture.pop('schema','public')
  deferred=[c for c in capture['constraints'] or [] if not c['validated']]
  if any(c['type']!='c' or not c['definition'].endswith(' NOT VALID') for c in deferred):raise ValueError('unsupported unvalidated hand constraint')
  capture['constraints']=[c for c in capture['constraints'] or [] if c['validated']]
  sql+=table_sql(capture).replace('public."'+row['name']+'"',schema+'."'+row['name']+'"')+'\n'
  for c in deferred:sql+='ALTER TABLE '+schema+'.'+row['name']+' ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
 functions={r['signature']:r for r in rows+deps['functions']+post['functions']}
 for row in tables:
  for t in row['triggers'] or []:
   if t.get('signature') and t['signature'] not in functions:
    functions[t['signature']]={'signature':t['signature'],'definition':t['function'],'definition_md5':hashlib.md5(t['function'].encode()).hexdigest(),'owner':'postgres','acl':'{postgres=X/postgres}'}
 for r in functions.values():
  if hashlib.md5(r['definition'].encode()).hexdigest()!=r['definition_md5']:raise ValueError('captured hand definition changed')
  sig=r['signature'] if '.' in r['signature'].split('(')[0] else 'public.'+r['signature']
  sql+=r['definition']+';\nREVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;\n'
  for a in r['acl'].strip('{}').split(','):
   role,access=a.split('=')
   if access!='X/postgres':raise ValueError('unexpected captured hand grant')
   sql+='GRANT EXECUTE ON FUNCTION '+sig+' TO '+(role or 'PUBLIC')+';\n'
  sql+="DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+lit(sig)+"::regprocedure AND md5(pg_get_functiondef(oid))="+lit(r['definition_md5'])+" AND proowner='postgres'::regrole AND proacl::text="+lit(r['acl'])+") THEN RAISE EXCEPTION 'actual hand authority differs'; END IF; END $$;\n"
 for row in tables:
  schema=row.get('schema','public')
  for c in row['constraints'] or []:
   if c['type']=='f':sql+='ALTER TABLE '+schema+'.'+row['name']+' ADD CONSTRAINT '+c['name']+' '+c['definition']+';\n'
  for t in row['triggers'] or []:sql+=t['definition']+';\n'
  capture=dict(row);capture.pop('schema',None)
  capture['triggers']=[{k:v for k,v in t.items() if k!='signature'}|{'function':t.get('signature',t['function'])} for t in row['triggers'] or []] or None
  sql+=exact_table_sql(capture).replace('public.'+row['name'],schema+'.'+row['name'])
 e.sql(case,sql+'COMMIT;',label='actual-installed-public-hand-chain')
 # The previous normal recovery already committed in db. Capture every original
 # monetary row, acknowledgement and receipt before exercising its next hand.
 e.sql(case,"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp();",label='conserved-current-lease')
 before=e.snapshot(case,'conserved-hand-before')
 private_before=private_rows(e,case,'conserved-hand-private-before')
 # File transport lets psql stop at the expected COMMIT error without a
 # stdin writer competing with its verbose error output on bounded pipes.
 hand_path=e.root/fix/'conserved-hand.sql'
 hand=hand_path.read_text()
 code,out,err=e.sql(case,file=hand_path,label='original-conserved-public-hand-refusal',check=False)
 if code!=3 or 'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY' not in err or 'HAND_PUBLIC_ACCEPTED_BEFORE_COMMIT' not in err:raise RuntimeError('original real hand refusal not reproduced: '+err)
 if e.snapshot(case,'original-conserved-hand-rollback')!=before or private_rows(e,case,'original-conserved-hand-private-rollback')!=private_before:raise RuntimeError('original conserved hand left effects')
 for name,mutation in [('observer-body',"ALTER FUNCTION public.fn_union_pnl_inventory_observe() SET statement_timeout='1s';"),('observer-acl',"GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_observe() TO authenticated;"),('seat-attachment',"ALTER TABLE public.table_seats DISABLE TRIGGER union_pnl_original_inventory;"),('scope-attachment',"ALTER TABLE public.tables DISABLE TRIGGER union_pnl_original_inventory;"),('inventory-access',"GRANT INSERT ON public.union_pnl_inventory_events TO service_role;")]:
  refusal(e,case,'conserved-install-'+name,mutation,(e.root/migration).read_text(),'CONSERVED_HAND_PREIMAGE_CHANGED')
 catalog_before=e.catalog_snapshot(case,'conserved-catalog-before')
 e.sql(case,file=e.root/migration,label='conserved-guard-install')
 catalog_after=e.catalog_snapshot(case,'conserved-catalog-after')
 for c in (catalog_before,catalog_after):c['functions']=[r for r in c['functions'] if r[1]!='fn_ca_tournament_felt_may_not_exceed_supply()']
 if catalog_before!=catalog_after or e.snapshot(case,'conserved-install-data')!=before:raise RuntimeError('conserved installation changed unrelated state')
 # Isolate each refusal from the exact restored pre-hand table. Corrupt-capture
 # cases alter only disposable fixture data after real capture, never an owner.
 _,s1,_=e.sql(case,"SELECT id FROM table_seats WHERE table_id='b7300000-0000-4000-8000-000000000001' AND user_id='b7100000-0000-4000-8000-000000000001' AND left_at IS NULL;",label='conserved-restored-chair')
 s1=lit(s1.strip());s2="'b7400000-0000-4000-8000-000000000002'"
 gain='UPDATE public.table_seats SET stack=stack+2500 WHERE id='+s1+';'
 lose='UPDATE public.table_seats SET stack=stack-2500 WHERE id='+s2+';'
 corrupt="SET LOCAL session_replication_role=replica; UPDATE public.union_pnl_inventory_events SET "
 end=" WHERE transaction_id=pg_current_xact_id() AND source_name='table_seats' AND row_id="+s2+";SET LOCAL session_replication_role=origin;"
 cases=[('net-growth',gain.replace('+2500','+3000')+lose.replace('-2500','-2999')),
 ('missing-capture',gain+lose+"SET LOCAL session_replication_role=replica;DELETE FROM public.union_pnl_inventory_events WHERE transaction_id=pg_current_xact_id() AND row_id="+s1+";SET LOCAL session_replication_role=origin;"),
 ('identity',gain+lose+corrupt+"after_row=jsonb_set(after_row,'{occupancy_id}',to_jsonb(gen_random_uuid()))"+end),
 ('null-identity',gain+lose+corrupt+"after_row=after_row-'occupancy_id',before_row=before_row-'occupancy_id'"+end),
 ('cross-table',gain+lose+corrupt+"before_row=jsonb_set(before_row,'{table_id}',to_jsonb('b7300000-0000-4000-8000-000000000002'::text)),after_row=jsonb_set(after_row,'{table_id}',to_jsonb('b7300000-0000-4000-8000-000000000002'::text))"+end),
 ('scope-change',gain+lose+"UPDATE public.tables SET is_private=NOT COALESCE(is_private,false) WHERE id='b7300000-0000-4000-8000-000000000001';SET LOCAL session_replication_role=replica;UPDATE public.union_pnl_inventory_events SET after_row=jsonb_set(after_row,'{tournament_id}',to_jsonb('b7200000-0000-4000-8000-000000000002'::text)) WHERE transaction_id=pg_current_xact_id() AND source_name='tables' AND row_id='b7300000-0000-4000-8000-000000000001';SET LOCAL session_replication_role=origin;"),
 ('null-stack',"SET LOCAL session_replication_role=replica;INSERT INTO public.profiles(id,username,display_name) VALUES('b7100000-0000-4000-8000-000000000009','custody_nullable_seat','Custody Nullable Seat');INSERT INTO public.table_seats SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(s)||jsonb_build_object('id','b7400000-0000-4000-8000-000000000099','user_id','b7100000-0000-4000-8000-000000000009','seat_number',3,'occupancy_id',gen_random_uuid(),'stack',NULL))).* FROM public.table_seats s WHERE s.id="+s2+";SET LOCAL session_replication_role=origin;"+gain.replace('+2500','+3000')+lose.replace('-2500','-3000')+"UPDATE public.table_seats SET stack=1 WHERE id='b7400000-0000-4000-8000-000000000099';")]
 for name,query in cases:
  code,out,err=e.sql(case,'BEGIN;'+query+'SET CONSTRAINTS zzzzzz_tournament_felt_may_not_exceed_supply IMMEDIATE;COMMIT;',label='conserved-'+name+'-refusal',check=False)
  if code!=3 or 'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY' not in err:raise RuntimeError('conserved negative not proven '+name+': '+err)
  if e.snapshot(case,'conserved-'+name+'-rollback')!=before:raise RuntimeError('conserved refusal leaked effects '+name)
 inflow_path=e.output/'conserved-public-inflow.sql'
 inflow_path.write_text(hand.replace("THEN 5000 ELSE 317500 END","THEN 5001 ELSE 317500 END"))
 code,out,err=e.sql(case,file=inflow_path,label='conserved-public-inflow-refusal',check=False)
 if code!=3 or 'conservation violation' not in err:raise RuntimeError('real hand creation was not refused: '+err)
 if e.snapshot(case,'conserved-inflow-rollback')!=before:raise RuntimeError('invalid hand leaked effects')
 zero=e.database(case)
 zero_hand=hand[:hand.index('DO $proof$')].replace('THEN 5000 ELSE 317500 END','THEN 0 ELSE 322500 END').replace("'winners',jsonb_build_array(jsonb_build_object('user_id','b7100000-0000-4000-8000-000000000001'","'winners',jsonb_build_array(jsonb_build_object('user_id','b7100000-0000-4000-8000-000000000002'")
 zero_path=e.output/'conserved-real-zero-stack.sql'
 zero_path.write_text(zero_hand)
 code,out,err=e.sql(zero,file=zero_path,label='conserved-real-zero-stack-hand',check=False)
 if code or err.count('HAND_PUBLIC_ACCEPTED_BEFORE_COMMIT')!=1:raise RuntimeError('actual zero-stack hand failed '+err)
 _,raw,_=e.sql(zero,"""SELECT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.hand_number=9720100 AND c.post_commit_completed_at IS NOT NULL AND c.stack_result->>'tournament_zero_stack_seat_count'='1')
 AND EXISTS(SELECT 1 FROM table_seats s JOIN tournament_players p ON p.user_id=s.user_id AND p.tournament_id='b7200000-0000-4000-8000-000000000001' WHERE s.table_id='b7300000-0000-4000-8000-000000000001' AND s.user_id='b7100000-0000-4000-8000-000000000001' AND s.stack=0 AND s.left_at IS NOT NULL AND p.chips=0)
 AND (SELECT sum(stack) FROM table_seats WHERE table_id='b7300000-0000-4000-8000-000000000001' AND left_at IS NULL)=322500
 AND EXISTS(SELECT 1 FROM tournament_knockout_candidates WHERE table_id='b7300000-0000-4000-8000-000000000001' AND hand_number=9720100 AND state='pending');""",label='conserved-zero-stack-completion')
 if raw.strip()!='t':raise RuntimeError('zero-stack hand lacks atomic completion')
 zero_after=e.snapshot(zero,'conserved-zero-stack-after')
 zero_changed={k for k in before if before[k]!=zero_after[k]}
 hand_changed={'public.table_seats','public.tournament_players','public.hand_history','public.hand_atomic_commits','public.ca_settlements','public.settlement_idempotency_keys','public.union_pnl_inventory_events','public.union_pnl_transaction_frames'}
 if zero_changed!=hand_changed|{'public.tables','public.tournament_knockout_candidates'} or private_rows(e,zero,'conserved-zero-stack-private-after')!=private_before:raise RuntimeError('zero hand changed unexpected money/custody '+str(zero_changed))
 e.discard(zero)
 code,out,err=e.sql(case,file=hand_path,label='conserved-real-public-hand',check=False)
 if code or err.count('HAND_PUBLIC_ACCEPTED_BEFORE_COMMIT')!=1 or err.count('HAND_PUBLIC_COMPLETED_PROVEN')!=1:raise RuntimeError('actual conserved public hand failed: '+err)
 after=e.snapshot(case,'conserved-hand-after')
 changed={k for k in before if before[k]!=after[k]}
 allowed={'public.table_seats','public.tournament_players','public.hand_history','public.hand_atomic_commits','public.ca_settlements','public.settlement_idempotency_keys','public.union_pnl_inventory_events','public.union_pnl_transaction_frames'}
 if changed!=allowed or private_rows(e,case,'conserved-hand-private-after')!=private_before:raise RuntimeError('conserved hand changed unexpected custody or money '+str(changed))
 code,out,err=e.sql(case,file=hand_path,label='conserved-public-hand-replay',check=False)
 if code or err.count('HAND_PUBLIC_COMPLETED_PROVEN')!=1:raise RuntimeError('conserved replay failed '+err)
 if e.snapshot(case,'conserved-replay-after')!=after:raise RuntimeError('hand replay changed effects')
 _,raw,_=e.sql(case,"SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'definition_md5',md5(pg_get_functiondef(oid)),'body_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig) FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure;",label='conserved-guard-postimage')
 e.report['conserved_hands']={'original_public_commit_refused':True,'actual_public_commit_and_outbox_completed':True,'money_ack_custody_unchanged':True,'exact_replay_unchanged':True,'zero_stack_vacated_atomically':True,'refusals':[n for n,_ in cases]+['public-inflow'],'installer_refusals':5,'postimage':json.loads(raw),'changed':sorted(changed)}
 e.discard(case)
