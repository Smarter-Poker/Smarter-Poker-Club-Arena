"""Bounded actual lease and custody-owner races for the original paid entry."""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
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
}
def validate(code,out,err,names,case):
 waits=0 if case=='b_busy' else 1
 steps=Counter(names)
 if waits:steps[case]+=1
 notices=re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(CUSTODY_OWNER_[A-Z_]+)\s*$',out+'\n'+err,re.M)
 if code or err.strip() or re.search(r'\b(?:ERROR|FATAL|PANIC|WARNING):',out) or notices!=CASES[case][0] or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=steps or out.count('<waiting ...>')!=waits or out.count('<... completed>')!=waits or re.findall(r'^starting permutation: (.*)$',out,re.M)!=[' '.join(names)]:
  raise RuntimeError('actual custody owner race lacks exact evidence: '+case)

def owner_races(e,db,fix,native,changed,inventory):
 spec=(e.root/fix/'owner-races.spec').read_text();body=re.sub(r'^permutation .+$','',spec,flags=re.M)
 permutations=re.findall(r'^permutation .+$',spec,re.M)
 if len(permutations)!=5:raise ValueError('five actual owner race orders required')
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
  allowed=CASES[case][1]|(changed if case in ('b_claim','b_fresh') else set())
  if {k for k in before if before[k]!=after[k]}!=allowed:raise RuntimeError('owner race changed financial/custody vector: '+case)
  if case in ('b_claim','b_fresh'):inventory(e,child,case)
  e.discard(child);e.report.setdefault('owner_races',[]).append({'case':case,'observed_wait':case!='b_busy','exact_vector':True,'false_evidence_refused':5})

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

def validate_complete(r):
 try:
  assert r['original_refusal']['exact_original_body']=='16a587f7567336fe4379135f22e3fb41'
  assert r['original_refusal']['same_input_rejected'] is True and r['original_refusal']['whole_transaction_rollback'] is True
  assert len(r['refusals'])==len(set(r['refusals']))==21 and r['private_role_refusals']==6
  assert len(r['races'])==4 and {x['case'] for x in r['races']}=={'b_same_commit','b_same_rollback','b_other_commit','b_other_rollback'}
  assert all(x['actual_wait'] is True and x['exact_custody_delta'] is True and x['financial_rows_unchanged'] is True and x['false_evidence_refused']==6 for x in r['races'])
  assert {x['case'] for x in r['owner_races']}==set(CASES) and len(r['owner_races'])==5
  assert all(x['exact_vector'] is True and x['false_evidence_refused']==5 and x['observed_wait'] is (x['case']!='b_busy') for x in r['owner_races'])
  assert r['activation']=={'original_guard_refuses':True,'successor_all_pins_pass':True,'assignment_drift_refused':True,'only_abi_row_changed':True}
  assert r['installer_refusals']=={'body_acl_guard':3,'full_catalog_and_data_rollback':True}
  assert len(r['postimage']['functions'])==5 and len(r['postimage']['table']['triggers'])==3
  assert r['successful_transfer']['assertions']==7 and len(r['successful_transfer']['only_custody_rows_changed'])==8
  assert r['private_custody_unchanged'] is True
  assert r['paid_purchase_prevention']=={'installed_owner_definition_md5':'a6adf208eae8476128f197c16f83d6c5','public_caller_final_receipt_failure':True,'real_debit_seat_candidate_reached':True,'complete_business_rollback':True}
 except (KeyError,AssertionError,TypeError):raise RuntimeError('original paid custody qualification is incomplete')
 return True
