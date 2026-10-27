#!/usr/bin/env python3
"""Run actual reclaim and history bodies against isolated PostgreSQL wallets."""
import os, re, subprocess, tempfile, shutil, json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
if sys.platform=='darwin' and not Path('/Volumes/SmarterWork/agent-work').is_dir():
 raise RuntimeError('Mounted External Work SSD Is Required')
base=Path('/Volumes/SmarterWork/agent-work') if Path('/Volumes/SmarterWork').is_dir() else Path(tempfile.gettempdir())
cluster=Path(tempfile.mkdtemp(prefix='claim-pg-',dir=base)); socket=cluster/'s';socket.mkdir()
def run(cmd,text=None):
 p=subprocess.run(list(map(str,cmd)),input=text,text=True,capture_output=True,timeout=60)
 if p.returncode: raise RuntimeError(p.stderr+p.stdout)
 return p.stdout
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-U','postgres']
def q(s): return run(psql,s)
C='00000000-0000-0000-0000-000000000001'; O='00000000-0000-0000-0000-000000000002'; A='00000000-0000-0000-0000-000000000003'; P='00000000-0000-0000-0000-000000000005'
def call(source,dest,amount=10,op=None,actor=O,holder=A,original=None):
 import uuid
 op=op or str(uuid.uuid4()); amt='NULL' if amount is None else str(amount); tx=f"'{original}'" if original else 'NULL'
 sql=f"select set_config('request.jwt.claim.sub','{actor}',false); select fn_club_wallet_claim_back('{C}','{holder}',{amt},'{source}','{dest}','test','{op}',{tx});"
 return json.loads(q(sql).splitlines()[-1])
try:
 shared=Path(run([PG/'pg_config','--sharedir']).strip())
 if not (shared/'postgres.bki').exists(): shared=PG.parent/'share/postgresql'
 run([PG/'initdb','-L',shared,'-D',cluster/'data','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-h '' -k {socket}",'-w','start'])
 fixture=ROOT/'scripts/ci/fixtures/chip-wallet-choice'
 q((fixture/'setup.sql').read_text())
 q((fixture/'selected-setup.sql').read_text())
 # Use the production exact-intent owner and insertion guard, not the fixture adapter.
 authority=(ROOT/'supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql').read_text()
 q('DROP VIEW cashier_rpc_operation_intents; CREATE TABLE chip_requests(op_id uuid);')
 table=authority[authority.index('CREATE TABLE public.cashier_rpc_operation_intents ('):]
 q(table[:table.index(');')+2])
 for name in ['fn_cashier_exact_intent_begin','fn_cashier_exact_intent_finish']:
  function=authority[authority.index('CREATE FUNCTION public.'+name+'('):]
  function=function[:function.index('$function$;',function.index('AS $function$')+len('AS $function$'))+len('$function$;')]
  q(function.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
 q((fixture/'fn_cashier_operation_intent_guard.sql').read_text())
 q('CREATE TRIGGER cashier_operation_intent_guard BEFORE INSERT ON chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_cashier_operation_intent_guard();')

 sql=(ROOT/'supabase/migrations/20261027160320_cashier_claim_destination_and_movement_history.sql').read_text()
 # Qualification loads the maintained function body itself; source preimages and
 # full migration are separately exercised below by the history fixture.
 claim=sql[sql.index('CREATE OR REPLACE FUNCTION public.fn_club_wallet_claim_back'):]
 q(claim[:claim.index('-- Older open clients')])
 import uuid
 for source in ['agent_wallet','player_wallet','promo_wallet']:
  for dest in ['agent_wallet','player_wallet','promo_wallet','club_bank','club_promo_wallet']:
   q("select set_config('app.ledger_autoskip_club_members','1',false); select set_config('app.ledger_autoskip_agents','1',false); update club_members set chip_balance=1000; update agents set agent_wallet_balance=1000,promo_wallet_balance=1000;")
   before=q('select sum(v) from (select chip_balance v from club_members union all select agent_wallet_balance from agents union all select promo_wallet_balance from agents union all select chip_treasury from clubs union all select promo_balance from clubs)x;').strip()
   count=int(q('select count(*) from journal;'))
   result=call(source,dest)
   allowed=source!='promo_wallet' or dest in ['promo_wallet','club_promo_wallet']
   assert result['success']==allowed,(source,dest,result)
   assert int(q('select count(*) from journal;'))==count+int(allowed)
   assert q('select sum(v) from (select chip_balance v from club_members union all select agent_wallet_balance from agents union all select promo_wallet_balance from agents union all select chip_treasury from clubs union all select promo_balance from clubs)x;').strip()==before
 # Retry destination changes never move a second chip.
 op=str(uuid.uuid4()); assert call('agent_wallet','player_wallet',op=op)['success']; assert call('agent_wallet','player_wallet',op=op)['replayed']; assert not call('agent_wallet','promo_wallet',op=op)['success']
 assert not call('agent_wallet','agent_wallet',actor=A,holder=P)['success']
 # Simultaneous retries have one durable winner and one replay, with one debit.
 from concurrent.futures import ThreadPoolExecutor
 concurrent_op=str(uuid.uuid4()); count=int(q('select count(*) from journal;'))
 with ThreadPoolExecutor(max_workers=2) as pool:
  replies=list(pool.map(lambda _:call('agent_wallet','player_wallet',op=concurrent_op),range(2)))
 assert all(reply['success'] for reply in replies) and sum(bool(reply.get('replayed')) for reply in replies)==1,replies
 assert int(q('select count(*) from journal;'))==count+1

 # An agent remains bounded by the original send, its receiver, wallet and clock.
 tx=str(uuid.uuid4())
 q(f"insert into chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,reversible_until) values('{tx}','{C}','{A}','{P}',20,'agent_wallet_send','{{\"destination\":\"player_wallet\",\"credit_drawn\":4}}',now()+interval '10 minutes'); select set_config('app.ledger_autoskip_agents','1',false); update agents set credit_used=4 where user_id='{A}';")
 r=call('player_wallet','promo_wallet',None,actor=A,holder=P,original=tx)
 assert r['success'] and r['credit_repaid']==4 and r['returned_amount']==16,r
 assert not call('player_wallet','player_wallet',None,actor=A,holder=P,original=tx)['success']
 # A journal exception rolls back both balances and the original-send flags.
 q("create or replace function fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) returns boolean language plpgsql as $$ begin raise exception 'forced journal failure'; end $$;")
 before=q('select sum(agent_wallet_balance) from agents;')
 try: call('agent_wallet','club_bank')
 except RuntimeError as e: assert 'forced journal failure' in str(e)
 else: raise AssertionError('Expected rollback')
 assert q('select sum(agent_wallet_balance) from agents;')==before
 # Exercise the FULL migration against the captured maintained preimages.
 # No production database or real player is used by this qualification.
 q("ALTER TABLE chip_transactions ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN related_cashout_id uuid; CREATE TABLE profiles(id uuid,alias text,username text,display_name text,first_name text,last_name text,full_name text); CREATE TABLE cashout_requests(id uuid,status text,created_at timestamptz); CREATE TABLE settlement_invoices(id uuid,club_id uuid,invoice_number text); CREATE TABLE accounting_cashier_events(source_transaction_id uuid,invoice_id uuid); CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);")
 q("CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce($1,$2,$3,$6,'Member') $$; CREATE FUNCTION fn_club_active_cashier_edges(uuid) RETURNS TABLE(parent uuid,child uuid) LANGUAGE sql AS $$ SELECT agent_id,user_id FROM club_members WHERE club_id=$1 AND agent_id IS NOT NULL $$;")
 previous=(ROOT/'supabase/migrations/20261021182432_cashier_recovery_survives_unavailable_browser_storage.sql').read_text()
 recovery=re.search(r'CREATE (?:OR REPLACE )?FUNCTION public.fn_cashier_browser_recovery_valid\(.*?END \$fn\$;',previous,re.S|re.I)
 if not recovery:
  recovery=re.search(r'CREATE (?:OR REPLACE )?FUNCTION public.fn_cashier_browser_recovery_valid\(.*?END \$\$;',previous,re.S|re.I)
 assert recovery, 'Recovery preimage must be maintained'
 q(recovery.group(0))
 q((ROOT/'supabase/migrations/20261025025659_cashier_history_feed_search_cursor_person_and_club_totals.sql').read_text())
 core=(ROOT/'supabase/migrations/20261020210238_restrict_agent_banks_and_authorize_downline_reassignment.sql').read_text()
 core=core[core.index('CREATE OR REPLACE FUNCTION public.fn_club_bank_claim_core_20261004'):]
 core=core[:core.index('$function$',core.index('AS $function$')+len('AS $function$'))+len('$function$')]+';'
 q(core)
 # The selected-wallet migration carries the exact agent-claim preimage in its patch.
 selected=(ROOT/'supabase/migrations/20261016024912_cashier_sends_use_the_selected_source_and_destination_wallet.sql').read_text()
 agent=selected[selected.index('CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831'):]
 agent=agent[:agent.index('$definition$;')].strip()+';'
 q(agent)
 # Restore real registry guard and journal functions used by the maintained fixture.
 q("CREATE OR REPLACE FUNCTION fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO journal(category,from_type,from_id,to_type,to_id,amount,club_id,op) VALUES($1,$2,$3,$4,$5,$6,$7,$8); RETURN true; END $$;")
 q(sql)
 for proof in re.findall(r'^-- @live-proof: (.+)$',sql,re.M):
  assert q('SELECT '+proof+';').strip()=='t',proof
 # Readbacks prove that older clients cannot convert promo back to cash either.
 q(f"select set_config('request.jwt.claim.sub','{O}',false); select set_config('app.ledger_autoskip_agents','1',false); update agents set promo_wallet_balance=1000;")
 bank_before=q(f"select chip_treasury from clubs where id='{C}';")
 r=json.loads(q(f"select set_config('request.jwt.claim.sub','{O}',false); select fn_club_bank_claim_core_20261004('{C}','{A}',10,'promo_wallet',NULL,gen_random_uuid());").splitlines()[-1]); assert r['success'],r
 assert q(f"select chip_treasury from clubs where id='{C}';")==bank_before
 # The older agent entry point also credits promo, preserving its credit debt.
 legacy_tx=str(uuid.uuid4()); lower='00000000-0000-0000-0000-000000000004'
 q(f"insert into chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,reversible_until) values('{legacy_tx}','{C}','{A}','{lower}',10,'agent_wallet_send','{{\"destination\":\"promo_wallet\",\"credit_drawn\":5}}',now()+interval '10 minutes');")
 cash_before=q(f"select agent_wallet_balance from agents where user_id='{A}';")
 promo_before=float(q(f"select promo_wallet_balance from agents where user_id='{A}';"))
 legacy=json.loads(q(f"select set_config('request.jwt.claim.sub','{A}',false); select fn_agent_wallet_claim_back_phase2_core_20260831('{C}','{legacy_tx}',10,NULL,gen_random_uuid());").splitlines()[-1]); assert legacy['success'],legacy
 assert q(f"select agent_wallet_balance from agents where user_id='{A}';")==cash_before
 assert float(q(f"select promo_wallet_balance from agents where user_id='{A}';"))==promo_before+10
 assert float(q(f"select balance_after from chip_transactions where id='{legacy['transaction_id']}';"))==promo_before+10
 # Seed own/downline/unrelated and game rows, then query real server scopes and totals.
 q('TRUNCATE chip_transactions;')
 q(f"INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at) VALUES ('{C}','{A}','{P}',10,'agent_wallet_send',now()),('{C}','{P}',NULL,999,'buyin',now()),('{C}','{O}',NULL,888,'tournament_buyin',now()),('{C}','{O}','{O}',7,'peer_transfer',now());")
 def feed(actor,scope,kind='all'):
  return q(f"select set_config('request.jwt.claim.sub','{actor}',false); select count(*) from fn_cashier_history_feed('{C}','{scope}','{kind}',date_trunc('day',now()));").splitlines()[-1]
 assert feed(O,'club')=='2'
 assert feed(A,'club')=='1' # Agent cannot widen scope by requesting club.
 assert feed(A,'downline')=='1'
 assert feed(P,'club')=='1'
 assert feed(O,'club','game')=='0'
 summary=json.loads(q(f"select set_config('request.jwt.claim.sub','{O}',false); select fn_cashier_history_summary('{C}','club','all',date_trunc('day',now()));").splitlines()[-1])
 assert summary['entries']==2 and float(summary['volume'])==17,summary
 assert q("SELECT has_function_privilege('anon','fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)','EXECUTE');").strip()=='f'
 print('QUALIFIED_FUNCTION_HASHES',q("select json_object_agg(proname,md5(pg_get_functiondef(oid))) from pg_proc where pronamespace='public'::regnamespace and proname in ('fn_club_wallet_claim_back','fn_cashier_history_feed','fn_cashier_history_summary','fn_club_bank_claim_core_20261004','fn_agent_wallet_claim_back_phase2_core_20260831');").strip())
 print('PASS: full migration/preimage guards; legacy promo returns; real feed, downline authorization and totals exclude game/buy-in rows')
 print('PASS: 15 source/destination combinations, conservation, single journal, destination-bound replay, authority, credit repayment, duplicate claim, rollback')
finally:
 if (cluster/'data/postmaster.pid').exists():
  stop=subprocess.run([str(PG/'pg_ctl'),'-D',str(cluster/'data'),'-m','fast','-w','stop'],capture_output=True)
  if stop.returncode: raise RuntimeError(f'Cluster Stop Failed; Preserved {cluster}')
 shutil.rmtree(cluster)
