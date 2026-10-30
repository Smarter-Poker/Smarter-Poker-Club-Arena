"""One incident's exact migration on a private local PG17, never production."""
import argparse, hashlib, json, os, pathlib, re, select, shutil, socket, subprocess, tempfile, time
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=pathlib.Path,required=True);ap.add_argument('--scratch',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);a=ap.parse_args()
ROOT=pathlib.Path(__file__).resolve().parents[3];HERE=pathlib.Path(__file__).parent;F=HERE/'fixtures';PG=a.pg_bin
B=pathlib.Path(tempfile.mkdtemp(prefix='lightning-incident-',dir=a.scratch));C=B/'cluster'
with socket.socket() as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={**os.environ,'TMPDIR':str(B),'PGOPTIONS':'-c timezone=UTC'};ps=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x)for x in cmd],input=sql,text=True,capture_output=True,env=env,timeout=45)
 if error:assert r.returncode and error in r.stderr,(error,r.stdout,r.stderr)
 else:assert r.returncode==0,(r.stdout,r.stderr)
 return r.stdout.strip()
def q(sql,error=None):return run(ps,sql,error)
def lit(x):return "'"+str(x).replace("'","''")+"'"
def packet(name):return json.loads((F/name).read_text())
MIG=ROOT/'supabase/migrations/20261030161608_house_covers_kingfish_lightning_missing_card_losses.sql';migration=MIG.read_text();body=re.search(r'DO \$settle\$.*?END \$settle\$;',migration,re.S).group()
U='47965354-0e56-43ef-931c-ddaab82af765';CL='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';UN='fade0000-0000-0000-0000-000000000001';SE='bdacfcbf-af5d-441b-a76d-4a52dfa33688';CG='563279fc-c09a-48a6-b487-c4f34f289095';SL='7cdf4d74-fe69-4196-baf5-264102f4b2db';AN='71cb19cb-24bc-4653-8e99-159cb844aa21';ACT='2d1cd6c3-5700-4af9-a271-d4863fdab20d';KEY='lightning-card-incident:'+SE
started=False;checks=[];installed=[]
try:
 run([PG/'initdb','-D',C,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);run([PG/'pg_ctl','-D',C,'-l',B/'postgres.log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE EXTENSION \"uuid-ossp\" WITH SCHEMA extensions;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;CREATE FUNCTION auth.role()RETURNS text LANGUAGE sql STABLE AS $$SELECT NULL::text$$;SET check_function_bodies=off;CREATE SEQUENCE chip_ledger_chain_seq;CREATE SCHEMA smarter_private;CREATE SEQUENCE smarter_private.f06_lifecycle_seq;CREATE OR REPLACE FUNCTION smarter_private.f06_new_lifecycle() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$ SELECT nextval('smarter_private.f06_lifecycle_seq') $function$;")
 assert int(q("SHOW server_version_num"))//10000==17
 generated={(g['relation'],g['attname']) for g in packet('generated-columns.json')}
 intent=packet('intent-owner.json');q('CREATE TABLE ca_correction_request_intents_v1('+','.join(c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in intent['columns'])+');');
 for n,c in enumerate(intent['constraints']):q('ALTER TABLE ca_correction_request_intents_v1 ADD CONSTRAINT native_intent_'+str(n)+' '+c+';')
 for z in intent['triggers']:q(z['definition']+';'+z['trigger']+';')
 current=packet('current-owners.json');tables={t['name']:t for t in current['tables']}
 for seq in set(re.findall(r"nextval\('([^']+)'::regclass\)",json.dumps(current))):q('CREATE SEQUENCE IF NOT EXISTS '+seq+';')
 for t in tables.values():
  q('SET search_path=public,extensions;CREATE TABLE '+t['name']+'('+','.join('"'+c['name']+'" '+c['type']+((' GENERATED ALWAYS AS ('+c['default']+') STORED')if(t['name'],c['name'])in generated else(' DEFAULT '+c['default']if c['default']else''))+(' NOT NULL'if c['notnull']else'')for c in t['columns'])+');')
 for f in current['owners']+packet('check-owners.json'):
  assert hashlib.md5(f['definition'].encode()).hexdigest()==f['md5'];q('SET check_function_bodies=off;'+f['definition'])
  q('REVOKE ALL ON FUNCTION '+f['signature']+' FROM PUBLIC,anon,authenticated;')
 for t in tables.values():
  for c in t['constraints']:
   if c['definition'].startswith(('PRIMARY KEY','UNIQUE','CHECK')):q('ALTER TABLE '+t['name']+' ADD CONSTRAINT "'+c['name']+'" '+c['definition']+';')
 q("CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES("+lit(ACT)+");ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_performed_by_fkey FOREIGN KEY(performed_by)REFERENCES auth.users(id);CREATE TABLE ca_chip_store_coverage(store text PRIMARY KEY,treatment text,counted_by text,notes text);INSERT INTO ca_chip_store_coverage VALUES('union_bank','counted','native','original'),('player_wallet','counted','native','original'),('table_stack','counted','native','original');CREATE TABLE chip_ledger_idem(idempotency_key text PRIMARY KEY,leg_id uuid NOT NULL,created_at timestamptz NOT NULL);CREATE TABLE ca_financial_epochs(id int PRIMARY KEY,is_current boolean);INSERT INTO ca_financial_epochs VALUES(1,true);CREATE TABLE ca_ledger_invariant_store_mode(store text PRIMARY KEY,mode text);CREATE TABLE ca_ledger_invariant_mode(mode text);INSERT INTO ca_ledger_invariant_mode VALUES('refuse');CREATE TABLE ca_ledger_invariant_findings(txid xid8,account_key text,balance_delta numeric,ledger_net numeric,mode text,actor_service text,db_role text,statement text,found_at timestamptz DEFAULT now(),UNIQUE(txid,account_key));CREATE TABLE engine_maintenance_break(enforce_freeze boolean,announced_at timestamptz,phase text,break_started_at timestamptz,break_ends_at timestamptz);CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;CREATE FUNCTION fn_ca_ledger_refusal_record(jsonb)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;")
 other=ROOT/'scripts/qualification/approved-agent-adjustment/fixtures'
 for f in json.loads((other/'tally-owners.json').read_text())['owners']:
  if f['signature'] not in ['fn_ca_ledger_refusal_record(jsonb)','fn_ca_felt_counts_table(uuid)','fn_ca_tournament_counts(uuid)']:q('SET check_function_bodies=off;'+f['definition'])
 for f in packet('freeze-owner.json')+packet('freeze-closure.json')+json.loads((other/'write-authorization-owners.json').read_text())['owners']:q('SET check_function_bodies=off;'+f['definition'])
 cap=packet('freeze-capability.json');q('CREATE TABLE smarter_private.weekly_payout_owned_transactions('+','.join(c['name']+' '+c['type']for c in cap['columns'])+');');q('SET check_function_bodies=off;'+cap['function']['definition'])
 chosen={'fn_club_members_ledger_writer','fn_cashier_balance_actor_guard','fn_cashier_operation_mutex_guard','fn_ca_chip_ledger_enrich','fn_ca_tally_balance_move','fn_ca_tally_store_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row','zz_chip_ledger_key_is_claimed_once','fn_ca_journal_append_only','fn_ca_autoledger','enforce_chip_ledger_performed_by','fn_ca_chip_store_declared','fn_ca_refuse_replica_money_write','fn_refuse_while_frozen','fn_block_browser_balance_writes','fn_ca_block_browser_money_table','fn_ca_adjustment_status_guard'}
 seen=set()
 for t in tables.values():
  for z in t['triggers']:
   if z['function']in chosen and z['function']not in seen:q('SET check_function_bodies=off;'+z['body']);seen.add(z['function'])
 # Seed only synthetic fixture data before enabling original money triggers.
 q("INSERT INTO union_wallets(union_id,chip_balance)VALUES("+lit(UN)+",1000);INSERT INTO club_members(club_id,user_id,role,status,chip_balance)VALUES("+lit(CL)+','+lit(U)+",'owner','active',100),('a0000000-0000-0000-0000-000000000001',"+lit(U)+",'player','active',700);")
 q("INSERT INTO cash_games(id,club_id,union_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot)VALUES("+lit(CG)+','+lit(UN)+','+lit(UN)+",'Native incident','action','nlh',1,2,6,'{}');INSERT INTO tables(id,name,club_id,union_id,cluster_id,game_type)VALUES("+lit(AN)+",'Native anchor',"+lit(UN)+','+lit(UN)+','+lit(CG)+",'cash');")
 q("INSERT INTO lightning_pool_session(id,cluster_id,cluster_epoch,player_id,cash_player_session_id,anchor_seat_id,state,exit_reason,starting_stack,ending_stack,net_result,hands,normal_folds,entered_at,exited_at)VALUES("+lit(SE)+','+lit(CG)+',1,'+lit(U)+",'aea116a6-2470-485b-8229-4627006ca195','9aa03fdf-a765-4dbb-8306-22f658375513','closed','stop_playing',400,375,-25,14,13,'2026-10-30T13:59:35.613142Z','2026-10-30T14:10:23.790315Z');INSERT INTO lightning_pool_slot(id,pool_session_id,cluster_id,cluster_epoch,player_id,slot,opened_at,idle_since)VALUES("+lit(SL)+','+lit(SE)+','+lit(CG)+',1,'+lit(U)+",1,'2026-10-30T13:59:35Z','2026-10-30T13:59:35Z');")
 stack=400
 for i,d in enumerate([1,0,-1,-4,-1,-4,0,-4,0,-4,0,-4,0,-4]):
  hand='eca1f5cf-d533-4e47-a534-c84ed612633c'if i==0 else f'40000000-0000-0000-0000-{i:012}'
  q("INSERT INTO lightning_instance(cluster_id,cluster_epoch,state,hand_id,target_size,max_size)VALUES("+lit(CG)+",1,'complete',"+lit(hand)+",6,6);INSERT INTO lightning_hand_player(hand_id,player_id,pool_slot_id,seat,cluster_id,cluster_epoch,stack_before,stack_after,net_result,fold_type)VALUES("+lit(hand)+','+lit(U)+','+lit(SL)+',1,'+lit(CG)+f",1,{stack},{stack+d},{d},"+lit('none'if i==0 else'normal')+');');stack+=d
 q("INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,club_id,table_id,amount,category)VALUES('1dc69fe7-65d8-440b-8fc8-9fe0e6be8594',"+lit(ACT)+",'player_wallet',"+lit(U)+",'table_stack',"+lit(AN)+','+lit(CL)+','+lit(AN)+",400,'buyin');")
 for t in tables.values():
  if t['name']not in ['club_members','union_wallets','chip_ledger','chip_transactions','union_wallet_transactions','ca_manual_adjustments']:continue
  for z in t['triggers']:
   if z['function']in chosen:
    q(z['definition']+';');installed.append(t['name']+'.'+z['name'])
    if z['enabled']=='A':q('ALTER TABLE '+t['name']+' ENABLE ALWAYS TRIGGER "'+z['name']+'";')
 checks.append('captured_columns_constraints_original_money_owners_and_trigger_wiring')
 def state():return q("SELECT jsonb_build_object('banks',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM union_wallets x),'wallets',(SELECT jsonb_agg(to_jsonb(x)ORDER BY club_id,user_id)FROM club_members x),'ledger',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM chip_ledger x),'credits',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM chip_transactions x),'debits',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM union_wallet_transactions x),'intents',(SELECT jsonb_agg(to_jsonb(x)ORDER BY linkage_key)FROM ca_correction_request_intents_v1 x),'claims',(SELECT jsonb_agg(to_jsonb(x)ORDER BY op_id)FROM ca_op_claims x),'adjustments',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM ca_manual_adjustments x),'alerts',(SELECT jsonb_agg(to_jsonb(x)ORDER BY id)FROM financial_alerts x))")
 before=state();q('BEGIN;'+body+'SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;');assert state()==before;checks.append('whole_original_transaction_and_deferred_invariant_rollback')
 q("BEGIN;SET LOCAL ca.lightning_card_incident_probe='on';"+body+'COMMIT;','LIGHTNING_INCIDENT_PROBE_OK');assert state()==before;checks.append('single_call_self_aborting_probe_has_zero_committed_effects')
 for setup,error in [("UPDATE lightning_pool_session SET state='active'WHERE id="+lit(SE)+';','admission_or_funding_changed'),("UPDATE chip_ledger SET club_id='a0000000-0000-0000-0000-000000000001'WHERE id='1dc69fe7-65d8-440b-8fc8-9fe0e6be8594';",'admission_or_funding_changed'),("UPDATE lightning_hand_player SET net_result=net_result-1 WHERE hand_id='eca1f5cf-d533-4e47-a534-c84ed612633c';",'completed_hands_changed'),("INSERT INTO ca_op_claims(op_id,fn_name)VALUES("+lit(KEY+':bank')+",'fn_union_debit_wallet');",'partial_or_other_compensation'),("INSERT INTO engine_maintenance_break VALUES(true,now()-interval'3minutes','counting_down',now()-interval'1minute',now()+interval'2minutes');",'platform_frozen')]:
  q('BEGIN;'+setup+body+'ROLLBACK;',error);assert state()==before;checks.append(error+'_refuses_atomically')
 q("BEGIN;SELECT set_config('app.ledger_autoskip_union_wallets','1',true);UPDATE union_wallets SET chip_balance=25 WHERE union_id="+lit(UN)+';'+body+'ROLLBACK;','bank_or_original_wallet_unavailable');assert state()==before;checks.append('insufficient_union_bank_refuses_whole_transaction')
 q("BEGIN;UPDATE club_members SET status='suspended'WHERE club_id="+lit(CL)+'AND user_id='+lit(U)+';'+body+'ROLLBACK;','bank_or_original_wallet_unavailable');assert state()==before;checks.append('unavailable_original_destination_refuses_without_home_fallback')
 q('BEGIN;ALTER TABLE ca_correction_request_intents_v1 DISABLE TRIGGER ca_correction_intent_immutable_v1;'+body+'ROLLBACK;','original_money_owner_changed');assert state()==before;checks.append('missing_original_immutable_intent_guard_refuses')
 # Inject a late receipt failure after original bank, wallet and journal writes.
 q("CREATE FUNCTION native_late_failure()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native_credit_transaction_failure';END$$;CREATE TRIGGER native_late_failure BEFORE INSERT ON chip_transactions FOR EACH ROW EXECUTE FUNCTION native_late_failure();")
 q('BEGIN;'+body+'COMMIT;','native_credit_transaction_failure');assert state()==before
 q('DROP TRIGGER native_late_failure ON chip_transactions;');checks.append('late_original_receipt_failure_rolls_back_bank_wallet_journal_approval_and_claim')
 # Two real backends contend for the original operation lock; neither invents a retry identity.
 holder=subprocess.Popen([str(x)for x in ps],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 try:
  holder.stdin.write('BEGIN;'+body+'\n\\echo OWNED\n');holder.stdin.flush();deadline=time.monotonic()+10;seen=b''
  while time.monotonic()<deadline:
   if select.select([holder.stdout],[],[],.05)[0]:
    seen+=os.read(holder.stdout.fileno(),4096)
    if b'OWNED'in seen:break
  assert b'OWNED'in seen,'first incident transaction failed to acquire original operation'
  q('BEGIN;'+body+'COMMIT;','operation_owned');checks.append('concurrent_same_operation_refuses_without_second_credit')
  holder.stdin.write('SET CONSTRAINTS ALL IMMEDIATE;COMMIT;\n\\q\n');holder.stdin.flush();out,err=holder.communicate(timeout=10);assert holder.returncode==0,err
 finally:
  if holder.poll()is None:holder.kill();holder.communicate()
 checks.append('original_operation_commit_survives_waiter_refusal')
 # Existing wrong-club home balance remains unchanged; this credit never calls its resolver.
 q(migration);paid=state();assert q('SELECT chip_balance FROM union_wallets WHERE union_id='+lit(UN))=='974.00';assert q('SELECT chip_balance FROM club_members WHERE club_id='+lit(CL)+'AND user_id='+lit(U))=='126.00';assert q("SELECT chip_balance FROM club_members WHERE club_id='a0000000-0000-0000-0000-000000000001'")=='700.00';checks.append('explicit_original_KINGS_credit26_union_debit26_other_home_untouched')
 q(migration);assert state()==paid;checks.append('exact_original_operation_replay_has_no_second_payment_or_receipt')
 for role in ['anon','authenticated','service_role']:q('SET SESSION AUTHORIZATION '+role+';'+body,'postgres_only');checks.append(role+'_cannot_execute_incident')
 q("BEGIN;UPDATE ca_correction_request_intents_v1 SET request_intent='{}';ROLLBACK;",'correction_intent_is_immutable');assert state()==paid;checks.append('original_request_intent_is_immutable')
 q("BEGIN;UPDATE chip_transactions SET metadata=jsonb_set(metadata,'{intent}','{}');"+body+'ROLLBACK;','exact_receipt_changed');assert state()==paid;checks.append('mutable_display_metadata_cannot_replace_original_intent')
 # A fresh isolated database state for failure/concurrency; retain original money guards.
 q('BEGIN;'+body+'ROLLBACK;');assert state()==paid
 a.output.write_text(json.dumps({'passed':len(checks),'checks':checks,'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'original_triggers':installed,'limitations':['Local synthetic data only; production rollback/readback remains required.','Captured columns and PK/unique/check constraints retained; external foreign keys except actual performed_by FK and unrelated business notification triggers not recreated.','Original primitive, autoledger, identity, key, freeze and deferred accounting owner bodies execute. External refusal recorder is controlled non-network observer.','No production connection or payment.']},indent=2)+'\n');print(json.dumps({'passed':len(checks),'output':str(a.output)}))
finally:
 if started:run([PG/'pg_ctl','-D',C,'-m','immediate','-w','stop'])
 shutil.rmtree(B)
