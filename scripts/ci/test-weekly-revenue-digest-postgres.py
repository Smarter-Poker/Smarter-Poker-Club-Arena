#!/usr/bin/env python3
"""Execute original and changed digest on an isolated PG17, never production."""
import argparse,json,os,re,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2]
base=Path(tempfile.mkdtemp(prefix='rd-',dir=a.scratch));data=base/'d';started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
try:
 run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',data,'-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql('''CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE chip_ledger(amount numeric,category text,from_type text,to_type text,from_entity_id uuid,to_entity_id uuid,created_at timestamptz,status text);
 CREATE TABLE diamond_transactions(amount numeric,created_at timestamptz);
 CREATE TABLE ca_supply_snapshots(taken_at timestamptz,unexplained numeric,basis_version text);
 CREATE TABLE ca_incident_recipients(user_id uuid,active boolean);
 CREATE TABLE notifications(user_id uuid,type text,title text,message text,data jsonb);
 CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT $1='00000000-0000-0000-0000-000000000099'::uuid$$;
 INSERT INTO ca_incident_recipients VALUES('00000000-0000-0000-0000-000000000001',true),('00000000-0000-0000-0000-000000000002',false);
 INSERT INTO chip_ledger(amount,category,from_type,to_type,created_at,status) SELECT a,c,f,t,now()-interval '1 hour','posted' FROM(VALUES
 (10,'rake','table_stack','union_wallet'),(20,'rake','prize_liability','union_wallet'),
 (90,'rakeback','union_wallet','club_treasury'),(30,'rakeback','player_wallet','player_wallet'),(20,'rakeback','club_treasury','agent_wallet'),
 (100,'club_opening_allocation','club_treasury','opening_setup'),(50,'club_opening_allocation','opening_setup','bbj_pool'),(50,'club_opening_allocation','opening_setup','spin_reserve'),
 (25,'promo','bbj_pool','union_wallet'),(5,'promo','union_wallet','player_wallet'),(3,'leaderboard_payout','club_treasury','player_wallet'),(2,'promo_send','promo_wallet','promo_wallet'),
 (7,'bbj_contribution','table_stack','bbj_pool'),(1000,'mint','issuance_reserve','club_treasury'),(100,'burn','club_treasury','chip_retirement'))x(a,c,f,t);
 INSERT INTO chip_ledger VALUES(99,'rake','table_stack','union_wallet',null,null,now()-interval '1 hour','void');
 INSERT INTO chip_ledger VALUES(888,'rakeback','union_wallet','club_treasury',null,null,now()-interval '8 days','posted');
 INSERT INTO chip_ledger VALUES(777,'rakeback','union_wallet','club_treasury',null,null,now()+interval '1 day','posted');
 INSERT INTO diamond_transactions VALUES(-2,now()-interval '1 hour');
 INSERT INTO ca_supply_snapshots VALUES(now()-interval '2 hours',-5,'v6'),(now()-interval '1 hour',5,'v6');''')
 old=(root/'supabase/migrations/20260901001508_ca_phase6_weekly_revenue_digest.sql').read_text()
 old=re.search(r'CREATE OR REPLACE FUNCTION public.fn_ca_weekly_revenue_digest.*?END \$function\$;',old,re.S)[0]
 sql(old)
 before=json.loads(sql('SELECT fn_ca_weekly_revenue_digest(7)'))
 assert before['rakeback_paid_to_clubs']!=90 and before['promo_and_leaderboard_spend']!=8
 assert before['supply_unexplained_net']==0
 candidate=next((root/'supabase/migrations').glob('20261019182405_*')).read_text()
 sql(candidate)
 v=json.loads(sql('SELECT fn_ca_weekly_revenue_digest(7)'))
 expected={'cash_rake':10,'tournament_and_spin_rake':20,'rakeback_paid_to_clubs':90,'rakeback_paid_to_players':30,'rakeback_transfer_volume':140,'other_rakeback_transfers':20,'promo_and_leaderboard_spend':8,'promo_funding_transfers':27,'opening_setup_transfers':100,'opening_reserve_allocations':100,'bbj_contributions':7,'minted':1000,'burned':100,'diamond_net':-2,'supply_unexplained_net':0,'supply_absolute_unexplained':10,'supply_nonzero_count':2,'supply_snapshot_count':2,'supply_comparable_count':2}
 for k,n in expected.items():assert v[k]==n,(k,v[k],n)
 assert v['supply_status']=='nonzero_observations'
 assert sql("SELECT count(*) FROM notifications WHERE user_id='00000000-0000-0000-0000-000000000002'")=='0'
 assert sql("SELECT data->'digest'->>'digest_version' FROM notifications ORDER BY ctid DESC LIMIT 1")=='2'
 assert sql("SELECT bool_and(length(message)<=500) FROM notifications")=='t'
 assert sql("SELECT has_function_privilege('authenticated','fn_ca_weekly_revenue_digest(integer)','EXECUTE')")=='f'
 sql(candidate,'weekly_revenue_digest_preimage_changed')
 sql("INSERT INTO ca_supply_snapshots VALUES(now(),NULL,'v7')")
 assert json.loads(sql('SELECT fn_ca_weekly_revenue_digest(7)'))['supply_status']=='basis_transition_or_incomplete'
 sql('DELETE FROM ca_supply_snapshots')
 empty=json.loads(sql('SELECT fn_ca_weekly_revenue_digest(7)'))
 assert empty['supply_status']=='no_observations' and empty['supply_unexplained_net'] is None
 sql("INSERT INTO ca_supply_snapshots VALUES(now(),0,'v7')")
 assert json.loads(sql('SELECT fn_ca_weekly_revenue_digest(7)'))['supply_status']=='zero_observations_not_account_certification'
 print(json.dumps({'qualification':'passed','before_regression_reproduced':True,'exact_amount_assertions':len(expected),'posted_only':True,'past_and_future_excluded':True,'separate_club_player_and_other_rakeback':True,'opening_transfers_not_double_counted_as_spend':True,'net_zero_nonzero_and_missing_observations_distinguished':True,'inactive_recipient_not_notified':True,'private_acl':True,'migration_replay_refused':True,'production_payment':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
