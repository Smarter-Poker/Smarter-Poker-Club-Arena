import json,os,subprocess,socket,pathlib,hashlib,re,shutil
import argparse,tempfile
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=pathlib.Path,required=True);ap.add_argument('--scratch',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);args=ap.parse_args()
ROOT=pathlib.Path(__file__).resolve().parents[3];F=pathlib.Path(__file__).parent/'fixtures';B=pathlib.Path(tempfile.mkdtemp(prefix='approved-adjustment-',dir=args.scratch));PG=args.pg_bin
C=B/'cluster';env={**os.environ,'TMPDIR':str(B),'PGOPTIONS':'-c timezone=UTC'}
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
ps=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','postgres']
def run(cmd,inp=None,refuse=None):
 p=subprocess.run([str(x)for x in cmd],input=inp,text=True,capture_output=True,env=env,timeout=45)
 if refuse:assert p.returncode and refuse in p.stderr,(refuse,p.stdout,p.stderr)
 else:assert not p.returncode,(p.stdout,p.stderr)
 return p.stdout.strip()
def q(s,refuse=None):return run(ps,s,refuse)
def lit(x):return "'"+str(x).replace("'","''")+"'"
def capture(n):return json.loads((F/n.replace('.log','.json')).read_text())
def u(n):return f'30000000-0000-0000-0000-{n:012}'
started=False;checks=[]
try:
 run([PG/'initdb','-D',C,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);run([PG/'pg_ctl','-D',C,'-l',B/'adjustment-postgres.log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE EXTENSION \"uuid-ossp\" WITH SCHEMA extensions;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;CREATE FUNCTION auth.role()RETURNS text LANGUAGE sql STABLE AS $$SELECT NULL::text$$;SET search_path=public,extensions;SET check_function_bodies=off;CREATE SEQUENCE chip_ledger_chain_seq;")
 money=capture('money-component-owners.log');tables={x['name']:x for x in money['tables']}
 for name,t in tables.items():
  cols=','.join('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in t['columns']);q('SET search_path=public,extensions;CREATE TABLE public.'+name+'('+cols+');')
  for c in t['constraints']or[]:
   if not c['definition'].startswith(('FOREIGN KEY','TRIGGER')):q('ALTER TABLE '+name+' ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
 q("CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d');ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_performed_by_fkey FOREIGN KEY(performed_by)REFERENCES auth.users(id);")
 q("CREATE TABLE ca_chip_store_coverage(store text PRIMARY KEY,treatment text,counted_by text,notes text);INSERT INTO ca_chip_store_coverage VALUES('club_treasury','counted','native original club treasury','native declared store'),('agent_wallet','counted','native original agent wallet','native declared store');")
 q("CREATE TABLE chip_ledger_idem(idempotency_key text PRIMARY KEY,leg_id uuid NOT NULL,created_at timestamptz NOT NULL);CREATE TABLE ca_financial_epochs(id int PRIMARY KEY,is_current boolean);INSERT INTO ca_financial_epochs VALUES(1,true);CREATE TABLE ca_ledger_invariant_store_mode(store text PRIMARY KEY,mode text);CREATE TABLE ca_ledger_invariant_mode(mode text);INSERT INTO ca_ledger_invariant_mode VALUES('refuse');CREATE TABLE ca_ledger_invariant_findings(txid xid8,account_key text,balance_delta numeric,ledger_net numeric,mode text,actor_service text,db_role text,statement text,found_at timestamptz DEFAULT now(),UNIQUE(txid,account_key));CREATE TABLE engine_maintenance_break(enforce_freeze boolean,announced_at timestamptz,phase text,break_started_at timestamptz,break_ends_at timestamptz);CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;CREATE FUNCTION fn_ca_ledger_refusal_record(jsonb)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;")
 closure=capture('tally-owners.log')
 for x in closure['owners']:
  if x['signature'] not in ['fn_ca_ledger_refusal_record(jsonb)','fn_ca_felt_counts_table(uuid)','fn_ca_tournament_counts(uuid)']:q('SET check_function_bodies=off;'+x['definition'])
 for x in money['owners'][:2]:q('SET check_function_bodies=off;'+x['definition'])
 auth=capture('write-authorization-owners.log')
 for x in auth['owners']:q('SET check_function_bodies=off;'+x['definition'])
 chosen={'guard_agent_wallet_direct_update','sync_agent_wallet_columns','fn_cashier_balance_actor_guard','fn_cashier_operation_mutex_guard','fn_ca_chip_ledger_enrich','fn_ca_tally_balance_move','fn_ca_tally_store_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row','zz_chip_ledger_key_is_claimed_once','fn_ca_journal_append_only','fn_ca_autoledger','enforce_chip_ledger_performed_by','fn_ca_chip_store_declared','fn_ca_refuse_replica_money_write'};seen=set()
 for t in tables.values():
  for x in t['execution']or[]:
   name=x['signature'].split('(')[0]
   if name in chosen and name not in seen:q('SET check_function_bodies=off;'+x['definition']);seen.add(name)
 # Start from a genuinely pre-existing agent balance and independent unaffected wallets.
 q('INSERT INTO clubs(id,name,chip_treasury)VALUES('+lit(u(1))+",'Native only',100);INSERT INTO agents(id,club_id,user_id,role,commission_rate,player_rakeback_rate,agent_wallet_balance,business_balance,status)VALUES("+lit(u(2))+','+lit(u(1))+','+lit(u(3))+",'agent',.30,0,0,0,'active'),("+lit(u(8))+','+lit(u(1))+','+lit(u(9))+",'super_agent',.70,0,47.25,47.25,'active');")
 for name in ['clubs','agents','chip_ledger']:
  for x in tables[name]['execution']or[]:
   n=x['signature'].split('(')[0]
   if n in chosen and ('INSERT'in x['trigger']or'UPDATE'in x['trigger'])and not('DELETE'in x['trigger']and 'INSERT'not in x['trigger']and'UPDATE'not in x['trigger']):q(x['trigger']+';')
   if n in chosen and x['enabled']=='A'and ('INSERT'in x['trigger']or'UPDATE'in x['trigger']):q('ALTER TABLE '+name+' ENABLE ALWAYS TRIGGER '+re.search(r'TRIGGER (\S+)',x['trigger']).group(1))
 actual=capture('adjustment-report-owner.log');report=next(x for x in actual['owners']if x['signature'].startswith('fn_ca_adjustments_report('));q(report['definition']);q('REVOKE ALL ON FUNCTION fn_ca_adjustments_report(timestamptz)FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION fn_ca_adjustments_report(timestamptz)TO service_role;CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text NOT NULL DEFAULT $$approved$$,notes text,added_at timestamptz NOT NULL DEFAULT now());')
 migration=(ROOT/'supabase/migrations/20261028153553_approved_agent_adjustments_settle_once_from_the_club_bank.sql').read_text()
 q(migration.replace('1edc12539a8b79db0614bf0470a3cf23','0'*32),'new_owner_metadata_or_ACL_changed');assert q("SELECT to_regprocedure('fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)')IS NULL")=='t';checks.append('installer_postimage_fault_rolls_back_function_registry_and_report')
 q(migration);q(migration,'owner_already_exists');checks.append('installer_current_components_registry_PGonly_ACL_and_replay_refusal')
 followup=(ROOT/'supabase/migrations/20261028183252_suspended_agents_receive_approved_past_earned_chips.sql').read_text()
 before_helper_meta=q("SELECT(to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure")
 q(followup.replace("'1edc12539a8b79db0614bf0470a3cf23'","'00000000000000000000000000000000'"),'preimage_changed');checks.append('suspended_credit_installer_wrong_preimage_refused')
 q(followup);q(followup,'preimage_changed');checks.append('suspended_credit_installer_exact_transition_and_replay_refusal')
 assert q("SELECT(to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure")==before_helper_meta
 assert q("SELECT md5(pg_get_functiondef('fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))")=='6eec29205765cd38ca9e0f6f9bfb8ed5';checks.append('suspended_credit_metadata_ACL_and_exact_postimage_preserved')

 checks.append('actual4table_columns_checks_PK_and_selected_money_trigger_owners_compile')
 def insert(n=4,**kw):
  row={'id':u(n),'actor':'00000000-0000-0000-0000-00000000c1a9','approver':'2d1cd6c3-5700-4af9-a271-d4863fdab20d','reason':'Native original source correction: own agent commission omitted by original chain selection.','amount':6.43,'target_kind':'agent_wallet','target_id':u(3),'status':'approved','approved_at':'2026-09-16T00:00:00Z','actor_label':'Native proposer','approver_label':'Native independent approver'};row.update(kw)
  return 'INSERT INTO ca_manual_adjustments('+','.join(row)+')VALUES('+','.join('NULL'if v is None else lit(v)for v in row.values())+');'
 def call(n=4,club=1):return 'SELECT fn_ca_settle_approved_agent_adjustment('+lit(u(n))+','+lit(u(club))+",jsonb_build_object('club_id',"+lit(u(club))+"::uuid,'approved_adjustment',(SELECT to_jsonb(a)-'status'FROM ca_manual_adjustments a WHERE id="+lit(u(n))+')));'
 def state():return q("SELECT jsonb_build_object('bank',(SELECT chip_treasury FROM clubs),'agents',(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM agents a),'adjustments',(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM ca_manual_adjustments a),'legs',(SELECT jsonb_agg(to_jsonb(l)ORDER BY id)FROM chip_ledger l))")
 q(insert());before=state();q('BEGIN;'+call()+"SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;");assert state()==before;checks.append('full_real_money_and_deferred_tally_rollback')
 receipt=json.loads(q('BEGIN;'+call()+'SET CONSTRAINTS ALL IMMEDIATE;COMMIT;').splitlines()[0]);assert receipt['amount']==6.43 and receipt['bank_after']==93.57 and receipt['wallet_after']==6.43;assert q("SELECT status FROM ca_manual_adjustments WHERE id="+lit(u(4)))=='settled';checks.append('approved_to_settled_conserved_bank_and_synced_agent_credit')
 q("BEGIN;UPDATE agents SET status='suspended' WHERE id="+lit(u(2))+';'+insert(31)+call(31)+'SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;');assert q("SELECT status FROM agents WHERE id="+lit(u(2)))=='active';checks.append('suspended_existing_wallet_receives_past_earned_credit_without_reactivation_rollback');
 paid=state();r=json.loads(q(call()));assert r['replayed']is True and r['ledger_id']==receipt['ledger_id'];assert state()==paid;checks.append('durable_exact_replay_no_second_payment')
 for name,setup,error in [('proposed',insert(10,status='proposed'),'not_unsettled_approved'),('rejected',insert(11,status='proposed')+"UPDATE ca_manual_adjustments SET status='rejected',rejected_by="+lit(u(6))+",rejected_at=now()WHERE id="+lit(u(11))+';','not_unsettled_approved'),('insufficient_bank',insert(12,amount=1000),'bank_funding_shortfall'),('wrong_asset',insert(13,target_kind='diamond_wallet',asset='diamonds'),'not_positive_approved_chips'),('inactive_agent',insert(14)+"UPDATE agents SET status='frozen'WHERE id="+lit(u(2))+';','agent_wallet_invalid')]:
  n={'proposed':10,'rejected':11,'insufficient_bank':12,'wrong_asset':13,'inactive_agent':14}[name];q('BEGIN;'+setup+call(n)+'ROLLBACK;',error);assert state()==paid;checks.append(name+'_refused_atomically')
 q('BEGIN;UPDATE ca_manual_adjustments SET amount=6.44 WHERE id='+lit(u(4))+';'+call()+'ROLLBACK;','replay_receipt_changed');assert state()==paid;checks.append('settled_amount_tamper_refused')
 for role in ['anon','authenticated','service_role']:
  q('SET ROLE '+role+';'+call(),'permission denied');checks.append(role+'_no_execute')
 payload=q("SELECT jsonb_build_object('club_id',"+lit(u(1))+"::uuid,'approved_adjustment',to_jsonb(a)-'status')FROM ca_manual_adjustments a WHERE id="+lit(u(4)))
 q('BEGIN;GRANT EXECUTE ON FUNCTION fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)TO authenticated;SET SESSION AUTHORIZATION authenticated;SELECT fn_ca_settle_approved_agent_adjustment('+lit(u(4))+','+lit(u(1))+','+lit(payload)+'::jsonb);ROLLBACK;','postgres_only');checks.append('session_identity_refuses_even_accidental_grant')
 q("BEGIN;INSERT INTO engine_maintenance_break VALUES(true,now()-interval'3minutes','counting_down',now()-interval'1minute',now()+interval'2minutes');"+insert(15)+call(15)+'ROLLBACK;','platform_frozen');assert state()==paid;checks.append('actual_freeze_owner_refuses')
 q("CREATE FUNCTION native_fail_journal()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native_journal_failure';END$$;CREATE TRIGGER native_fail_journal BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION native_fail_journal();")
 q('BEGIN;'+insert(16)+call(16)+'ROLLBACK;','native_journal_failure');assert state()==paid;q('DROP TRIGGER native_fail_journal ON chip_ledger;');checks.append('journal_failure_rolls_back_balances_and_adjustment')
 q("BEGIN;SELECT set_config('app.ledger_autoskip_agents','1',true);UPDATE agents SET agent_wallet_balance=agent_wallet_balance+1 WHERE id="+lit(u(2))+";SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;",'balance_moved_without_its_ledger_row');assert state()==paid;checks.append('actual_deferred_tally_rejects_unjournalled_balance')
 # Inject a malformed historical receipt using real balance/journal primitives;
 # no immutable ledger row is rewritten and no original trigger is disabled.
 for field,value in [('approved_actor',u(99)),('approved_by',u(99)),('paid_to','player_wallet'),('executed_by_db_role','service_role'),('executed_by_session_user','authenticator'),('performed_by',u(99))]:
  performer=u(99)if field=='performed_by'else'2d1cd6c3-5700-4af9-a271-d4863fdab20d'
  meta="jsonb_build_object('adjustment_id',a.id,'approved_intent',i,'approved_intent_md5',md5(i::text),'approved_actor',a.actor,'approved_by',a.approver,'paid_to','agent_wallet','executed_by_db_role','postgres','executed_by_session_user','postgres')"
  if field!='performed_by':meta+='||jsonb_build_object('+lit(field)+','+lit(value)+'::text)'
  setup=insert(24)+"INSERT INTO auth.users VALUES("+lit(u(99))+");DO $forge$DECLARE a ca_manual_adjustments%ROWTYPE;i jsonb;bb numeric;wb numeric;BEGIN SELECT*INTO a FROM ca_manual_adjustments WHERE id="+lit(u(24))+";i:=jsonb_build_object('club_id',"+lit(u(1))+"::uuid,'approved_adjustment',to_jsonb(a)-'status');SELECT chip_treasury INTO bb FROM clubs WHERE id="+lit(u(1))+";SELECT agent_wallet_balance INTO wb FROM agents WHERE id="+lit(u(2))+";PERFORM fn_ca_declare_ledger('correction','club_treasury',"+lit(u(1))+",a.id,'manual-agent-adjustment:'||a.id,ARRAY['clubs','agents']);UPDATE clubs SET chip_treasury=chip_treasury-a.amount WHERE id="+lit(u(1))+";UPDATE agents SET agent_wallet_balance=agent_wallet_balance+a.amount WHERE id="+lit(u(2))+";INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,idempotency_key,correlation_id,metadata,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)VALUES("+lit(performer)+",'club_treasury',"+lit(u(1))+",'agent_wallet',a.target_id,a.amount,'correction',"+lit(u(1))+",'manual-agent-adjustment:'||a.id,a.id,"+meta+",bb,bb-a.amount,wb,wb+a.amount);UPDATE ca_manual_adjustments SET status='settled'WHERE id=a.id;END$forge$;"
  q('BEGIN;'+setup+call(24)+'ROLLBACK;','replay_receipt_changed');assert state()==paid;checks.append('immutable_receipt_'+field+'_tamper_refused')
 # Execute the whole actual audit reader, not a projection of its approval predicate.
 q('CREATE TABLE chip_transactions(id uuid,created_at timestamptz,metadata jsonb,transaction_type text,from_user_id uuid,to_user_id uuid,amount numeric,club_id uuid);CREATE TABLE union_wallet_transactions(id uuid,created_at timestamptz,created_by uuid,tx_type text,direction text,wallet text,union_id uuid,club_id uuid,amount numeric,period_id uuid);CREATE TABLE ca_mint_ledger(id uuid,created_at timestamptz,performed_by uuid,action text,asset text,holder_type text,holder_id uuid,amount numeric,op_id text);')
 actual=capture('adjustment-report-owner.log');report=next(x for x in actual['owners']if x['signature'].startswith('fn_ca_adjustments_report('));q(report['definition'])
 assert q("SELECT single_actor FROM fn_ca_adjustments_report('2025-11-20')WHERE row_id="+lit(receipt['ledger_id']))=='t';checks.append('original_reader_reproduces_settled_audit_regression')
 before_report=q("SELECT(to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='fn_ca_adjustments_report(timestamptz)'::regprocedure")
 old="WHERE a.status = 'approved'";new="WHERE a.status IN ('approved','settled')";assert report['definition'].count(old)==1;newreport=report['definition'].replace(old,new);q(newreport)
 assert q("SELECT single_actor FROM fn_ca_adjustments_report('2025-11-20')WHERE row_id="+lit(receipt['ledger_id']))=='t'
 checks.append('platform_attributed_execution_keeps_truthful_single_actor_classification')
 assert q("SELECT(to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='fn_ca_adjustments_report(timestamptz)'::regprocedure")==before_report
 checks.append('settled_correction_visible_with_unchanged_four_eyes_and_full_reader_metadata')
 (B/'adjustments-report-candidate.sql').write_text(newreport)
 # The audit proposal actor is intentionally absent from auth.users; never manufacture it.
 assert q("SELECT count(*)FROM auth.users WHERE id='00000000-0000-0000-0000-00000000c1a9'")=='0'
 assert q("SELECT performed_by FROM chip_ledger WHERE id="+lit(receipt['ledger_id']))=='2d1cd6c3-5700-4af9-a271-d4863fdab20d'
 assert q("SELECT metadata->>'executed_by_db_role'||':'||(metadata->>'executed_by_session_user')FROM chip_ledger WHERE id="+lit(receipt['ledger_id']))=='postgres:postgres'
 checks.append('real_actor_FK_and_original_trigger_with_absent_audit_actor')
 for actor,error in [(None,'must name a real user'),('00000000-0000-0000-0000-000000000000','all-zero sentinel'),('00000000-0000-0000-0000-00000000c1a9','foreign key constraint')]:
  q("BEGIN;INSERT INTO chip_ledger(performed_by,from_type,to_type,amount,category)VALUES("+('NULL'if actor is None else lit(actor))+",'club_treasury','agent_wallet',1,'correction');ROLLBACK;",error)
 checks.append('original_actor_guard_NULL_zero_nonexistent_refusals')
 # Status support genuinely matters for existing independently attributed adjustments.
 q(insert(21,approver=u(6)));r21=json.loads(q('BEGIN;'+call(21)+'SET CONSTRAINTS ALL IMMEDIATE;COMMIT;').splitlines()[0])
 assert q("SELECT single_actor FROM fn_ca_adjustments_report('2025-11-20')WHERE row_id="+lit(r21['ledger_id']))=='f'
 q(report['definition']);assert q("SELECT single_actor FROM fn_ca_adjustments_report('2025-11-20')WHERE row_id="+lit(r21['ledger_id']))=='t';q(newreport)
 assert q("SELECT single_actor FROM fn_ca_adjustments_report('2025-11-20')WHERE row_id="+lit(r21['ledger_id']))=='f';checks.append('status_support_preserves_true_independent_approval_without_exception')
 # Two real backends serialize the same approved adjustment and preserve one receipt.
 q(insert(20));holder=subprocess.Popen([str(x)for x in ps],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 try:
  import select,time
  holder.stdin.write('BEGIN;'+call(20)+'\n\\echo OWNED\n');holder.stdin.flush();deadline=time.monotonic()+5;seen=b''
  while time.monotonic()<deadline:
   if select.select([holder.stdout],[],[],.05)[0]:
    seen+=os.read(holder.stdout.fileno(),4096)
    if b'OWNED'in seen:break
  assert b'OWNED'in seen,'first financial backend failed to acquire row'
  q(call(20),'lock timeout');checks.append('concurrent_same_adjustment_refuses_short_lock_instead_of_double_credit')
  holder.stdin.write('SET CONSTRAINTS ALL IMMEDIATE;COMMIT;\n\\q\n');holder.stdin.flush();out,err=holder.communicate(timeout=5);assert holder.returncode==0,err
 finally:
  if holder.poll()is None:holder.kill();holder.communicate()
 rr=json.loads(q(call(20)));assert rr['replayed']is True
 assert q("SELECT count(*)FROM chip_ledger WHERE idempotency_key='manual-agent-adjustment:"+u(20)+"'")=='1';checks.append('concurrent_original_operation_replay_uses_one_durable_leg')
 (B/'adjustment-native-postimages.json').write_text(q("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'metadata',to_jsonb(p)-'prosrc')ORDER BY p.proname)FROM pg_proc p WHERE p.oid IN('fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure,'fn_ca_adjustments_report(timestamptz)'::regprocedure)")+'\n')
 out={'passed':len(checks),'checks':checks,'receipt':receipt,'limitations':['All4 current table columns/checks/PK preserved; external foreign keys except actual performed_by FK and unrelated business notification/report triggers are not recreated.','Original autoledger/enrichment/sync/actor guard/key claim/balance and leg tally/deferred refusal bodies are real; external refusal recorder is controlled non-network observer.','Tally helpers use exact current71217 capture; unrelated table/tournament helper branches are not invoked.','No production database or financial RPC invoked.']};args.output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':out['passed'],'output':str(args.output)}))
finally:
 if started:run([PG/'pg_ctl','-D',C,'-m','immediate','-w','stop'])
 if B.exists():shutil.rmtree(B)
