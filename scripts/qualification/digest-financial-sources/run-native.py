from pathlib import Path
import subprocess,tempfile,shutil,os,socket
base=Path(__file__).resolve().parent
repo=base.parents[2]
work=Path(os.environ.get('DIGEST_NATIVE_WORK', '/Volumes/SmarterWork/agent-work/digest-fixes-01a14f3d' if os.sys.platform=='darwin' else tempfile.gettempdir()))
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
scratch=Path(tempfile.mkdtemp(prefix='lightning-pg-',dir=work))
with socket.socket() as listener:
 listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
def run(tool,args,sql=None):
 p=subprocess.run([str(pg/tool),*args],input=sql,text=True,capture_output=True)
 if p.returncode: raise RuntimeError(p.stderr)
 return p.stdout.strip()
def sql(s):return run('psql',['-X','-h','127.0.0.1','-p',port,'-d','postgres','-At','-v','ON_ERROR_STOP=1'],s)
def uid(n):return f'00000000-0000-4000-8000-{n:012d}'
started=False
try:
 run('initdb',['-D',str(scratch/'data'),'-A','trust','--no-locale']);run('pg_ctl',['-D',str(scratch/'data'),'-l',str(scratch/'log'),'-o',f'-h 127.0.0.1 -k {scratch} -p {port}','-w','start']);started=True
 sql('''CREATE SCHEMA smarter_private;
 CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.engine',true) IS DISTINCT FROM 'false'$$;
 CREATE TABLE hand_history(id uuid,table_id uuid,started_at timestamptz);
 CREATE TABLE clubs(id uuid,is_union boolean,union_id uuid);
 CREATE TABLE table_seats(table_id uuid,user_id uuid,club_id uuid,joined_at timestamptz,left_at timestamptz);
 CREATE TABLE hand_atomic_commits(hand_id uuid,table_id uuid,hand_number bigint);
 CREATE TABLE smarter_private.retired_cash_hand_custody(submission_id uuid,table_id uuid,user_id uuid,state text,transaction_id bigint,request_hash text,accepted_time_bank jsonb,original_time_bank jsonb,settlement_id uuid,hand_number bigint,seat_id uuid,occupancy_id uuid,seat_joined_at timestamptz,stack_before numeric,stack_after numeric,funding_club_id uuid);
 CREATE TABLE smarter_private.retired_cash_hand_qualification(submission_id uuid,request_hash text,table_id uuid,hand_number bigint,expected jsonb);
 CREATE TABLE smarter_private.hand_submissions(submission_id uuid,request_hash text);
 CREATE TABLE smarter_private.hand_submission_handoffs(submission_id uuid,transaction_id bigint,request_hash text);
 CREATE TABLE lightning_hand(hand_id uuid,hand_history_id uuid,host_table_id uuid,formed_at timestamptz,cluster_id uuid,cluster_epoch integer);
 CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,pool_slot_id uuid,cluster_id uuid,cluster_epoch integer);
 CREATE TABLE lightning_pool_slot(id uuid,pool_session_id uuid,player_id uuid,cluster_id uuid,cluster_epoch integer,opened_at timestamptz,closed_at timestamptz);
 CREATE TABLE lightning_pool_session(id uuid,cash_player_session_id uuid,player_id uuid,cluster_id uuid,cluster_epoch integer,entered_at timestamptz,exited_at timestamptz);
 CREATE TABLE cash_player_session(id uuid,player_id uuid,club_id uuid,opened_at timestamptz,closed_at timestamptz);''')
 sql((base/'cash-earning-before.sql').read_text())
 sql(f'''INSERT INTO clubs VALUES ('{uid(1)}',false,null),('{uid(2)}',false,null);
 INSERT INTO hand_history VALUES ('{uid(10)}','{uid(11)}','2026-10-17 12:00Z');
 INSERT INTO lightning_hand VALUES ('{uid(12)}','{uid(10)}','{uid(11)}','2026-10-17 11:59Z','{uid(13)}',1);
 INSERT INTO lightning_hand_player VALUES ('{uid(12)}','{uid(14)}','{uid(15)}','{uid(13)}',1);
 INSERT INTO lightning_pool_slot VALUES ('{uid(15)}','{uid(16)}','{uid(14)}','{uid(13)}',1,'2026-10-17 11:00Z',null);
 INSERT INTO lightning_pool_session VALUES ('{uid(16)}','{uid(17)}','{uid(14)}','{uid(13)}',1,'2026-10-17 11:00Z',null);
 INSERT INTO cash_player_session VALUES ('{uid(17)}','{uid(14)}','{uid(2)}','2026-10-17 10:00Z',null);''')
 call=f"select public.fn_cash_earning_club('{uid(10)}','{uid(11)}','{uid(14)}','{uid(1)}',null)"
 assert sql(call)=='','before: no physical host chair reproduces missing attribution'
 sql((repo/'supabase/migrations/20261018135018_lightning_rake_uses_original_pool_funding.sql').read_text())
 assert sql(call)==uid(2),'original funding club must win over host club'
 sql("update lightning_hand set formed_at='2026-10-17 11:59:59.410Z';update lightning_pool_slot set opened_at='2026-10-17 11:59:59.418203Z';update lightning_pool_session set entered_at='2026-10-17 11:59:59.418203Z'")
 assert sql(call)==uid(2),'engine logical formation can precede persisted funding-slot timestamps by milliseconds, actual hand start is authoritative'
 sql("update lightning_pool_slot set opened_at='2026-10-17 12:00:01Z'")
 assert sql(call)=='','a slot opened after actual hand start is refused'
 sql("update lightning_pool_slot set opened_at='2026-10-17 11:59:59.418203Z'")

 sql("update cash_player_session set closed_at='2026-10-17 12:00:30Z'")
 assert sql(call)==uid(2),'completed session still proves original funding'
 sql('update lightning_pool_slot set cluster_epoch=2')
 assert sql(call)=='','wrong epoch must not invent club ownership'
 sql('update lightning_pool_slot set cluster_epoch=1')
 sql("update cash_player_session set opened_at='2026-10-17 12:01Z'")
 assert sql(call)=='','later session must not fund earlier hand'
 sql("update cash_player_session set opened_at='2026-10-17 10:00Z'")
 sql("update cash_player_session set club_id=null")
 assert sql(call)=='','missing funding club stays unknown'
 sql(f"update cash_player_session set club_id='{uid(2)}'")
 sql('delete from lightning_hand')
 sql(f"insert into table_seats values ('{uid(11)}','{uid(14)}','{uid(1)}','2026-10-17 11:00Z',null)")
 assert sql(call)==uid(1),'ordinary physical table custody preserved'
 sql("""CREATE TABLE tournaments(id uuid,buy_in_amount numeric,buy_in_fee numeric,bounty_amount numeric,is_bounty boolean,is_pko boolean,is_mystery_bounty boolean);
 CREATE TABLE wallet_transactions(related_entity_id uuid,type text,category text,amount numeric);
 CREATE TABLE chip_ledger(id uuid,tournament_id uuid,from_type text,to_type text,from_entity_id uuid,to_entity_id uuid,category text,amount numeric,metadata jsonb,description text,created_at timestamptz,idempotency_key text);
 CREATE TABLE rake_records(tournament_id uuid,is_tournament boolean,rake_amount numeric,source text,metadata jsonb,pot_size numeric);
 CREATE TABLE tournament_guarantee_overlays(tournament_id uuid,amount numeric);
 CREATE TABLE tournament_payouts(id uuid,tournament_id uuid,amount numeric,source text);
 CREATE TABLE tournament_satellite_awards(payout_id uuid,tournament_id uuid,delivery_kind text);
 CREATE TABLE tournament_rake_settlements(tournament_id uuid,amount numeric,settled_at timestamptz);
 CREATE TABLE tournament_refund_tranches(tournament_id uuid,amount_paid_now numeric,refund_prize numeric,refund_bounty numeric,refund_fee numeric);
 CREATE FUNCTION fn_ca_unit_floor_cents(bigint,integer) RETURNS bigint LANGUAGE sql AS 'SELECT $1';
 CREATE FUNCTION fn_ca_recovery_fee_cents(bigint,numeric,integer) RETURNS bigint LANGUAGE sql AS 'SELECT round($1*$2)::bigint';
 CREATE FUNCTION fn_ca_tournament_fee_ratio(numeric,numeric) RETURNS numeric LANGUAGE sql AS 'SELECT $2/NULLIF($1+$2,0)';
 CREATE FUNCTION fn_ca_tournament_unit_cents(uuid) RETURNS integer LANGUAGE sql AS 'SELECT 1';""")
 sql((base/'escrow-before.sql').read_text())
 sql(f"""INSERT INTO tournaments VALUES ('{uid(20)}',18,2,8,true,false,true);
 INSERT INTO wallet_transactions VALUES ('{uid(20)}','debit','tournament_buyin',20);
 INSERT INTO chip_ledger(id,tournament_id,from_type,to_type,to_entity_id,category,amount,metadata)
 VALUES ('{uid(21)}','{uid(20)}','player_wallet','prize_liability','{uid(20)}','tournament_buyin',20,'{{}}'),
 ('{uid(22)}','{uid(20)}','escrow','prize_liability','{uid(20)}','ticket_redeem',20,'{{"entry_prize":10,"entry_bounty":8,"entry_fee":2}}');
 INSERT INTO rake_records VALUES ('{uid(20)}',true,4,'entry','{{}}',null);""")
 shadow=f"SELECT prize_in||','||bounty_in||','||fee_in FROM fn_ca_tournament_escrow_chips('{uid(20)}')"
 assert sql(shadow)=='28.00,8.00,4.00','before: ticket bounty was misclassified as prize'
 sql((repo/'supabase/migrations/20261018135411_ticket_bounty_shadow_uses_recorded_entry_split.sql').read_text())
 assert sql(shadow)=='20.00,16.00,4.00','two entries each fund10 prize8 bounty2 fee'
 sql(f"""INSERT INTO wallet_transactions VALUES ('{uid(20)}','credit','prize',20),('{uid(20)}','credit','bounty',16);
 INSERT INTO tournament_rake_settlements VALUES ('{uid(20)}',4,now());""")
 assert sql(f"SELECT prize_balance||','||bounty_balance||','||fee_balance FROM fn_ca_tournament_escrow_chips('{uid(20)}')")=='0.00,0.00,0.00'
 print(sql("SELECT json_build_object('cash_earning_club',md5(pg_get_functiondef('fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure)),'ticket_shadow',md5(pg_get_functiondef('fn_ca_tournament_escrow_chips(uuid)'::regprocedure)))"))
 print('PASS: original Lightning funding and custody refusals; ticket bounty before28/8 after20/16, terminal escrow exact zero')
finally:
 if started:run('pg_ctl',['-D',str(scratch/'data'),'-m','immediate','-w','stop'])
 shutil.rmtree(scratch)
