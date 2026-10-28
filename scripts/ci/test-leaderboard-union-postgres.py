#!/usr/bin/env python3
"""Install exact owners and exercise their real entry/advance paths on PG17."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args();root=Path(__file__).resolve().parents[2]
a.scratch.mkdir(parents=True,exist_ok=True);base=Path(tempfile.mkdtemp(prefix='lu-',dir=a.scratch));started=False
S='public.fn_process_weekly_accounting_scope(uuid,uuid)';W='public.fn_accounting_close_windows_advance_due()'
def run(args,s=None,error=None):
 r=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,timeout=90,env={**os.environ,'TMPDIR':str(base),'PGOPTIONS':'-c timezone=UTC'})
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',base,'-U','postgres','-d','postgres'],s,error)
try:
 assert ' 17.' in run([a.pg_bin/'postgres','--version'])
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f"-h '' -k {base}",'-w','start']);started=True
 fixture=root/'scripts/ci/fixtures/leaderboard-union'
 q((fixture/'schema.sql').read_text())
 for name in ['fn_refuse_leaderboard_basis_mutation','fn_leaderboard_program_commitment','fn_enforce_leaderboard_program_funding','fn_get_leaderboard_reward_plan','fn_leaderboard_complete_round_basis','fn_club_leaderboard_by_dates','fn_payout_leaderboard','fn_get_leaderboard_settlement_status']:
  q((fixture/(name+'.sql')).read_text())
 q("CREATE TRIGGER funding BEFORE INSERT ON leaderboard_reward_program_versions FOR EACH ROW EXECUTE FUNCTION fn_enforce_leaderboard_program_funding()")
 club='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
 basis_call=f"fn_leaderboard_complete_round_basis('{club}','weekly','2026-10-18','2026-10-25')"
 standalone_before=q("SELECT fn_leaderboard_complete_round_basis(md5('standalone')::uuid,'weekly','2026-10-18','2026-10-25')")
 original_basis=q('SELECT '+basis_call)
 original_hash=q('SELECT md5(('+basis_call+')::text)')
 q("INSERT INTO leaderboard_round_basis_receipts SELECT '"+club+"','weekly','2026-10-18','2026-10-25','cf1e2a57-83f8-4241-977f-5d7b5fd870d6',1,'6cccd5b70afc93983c8419ec15c2f707','hands_played','complete_capture_v2',b,md5(b::text),'[]',md5('[]'),'[]',md5('[]'),now() FROM (SELECT "+basis_call+" b)x")
 assert q(f"SELECT count(*) FROM fn_club_leaderboard_by_dates('{club}','hands_played','2026-10-18','2026-10-25',100,0)")=='0'
 original_meta=q("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,provolatile,proconfig)ORDER BY proname) FROM pg_proc WHERE proname IN('fn_leaderboard_complete_round_basis','fn_payout_leaderboard','fn_get_leaderboard_settlement_status')")
 migration=(root/'supabase/migrations/20261028163625_leaderboard_union_complete_basis_and_awards.sql').read_text()
 # Only rebind the three production-data hash assertions to explicit fixture
 # inputs. The installed functions, transactions, credit keys and money body
 # are the exact maintained candidate. Production hashes were separately
 # checked by a self-aborting real-wallet probe; no production DDL was probed.
 query=migration[migration.index('WITH membership AS MATERIALIZED'):migration.index(' INTO v_union_basis;')]
 query=query.replace('v_union',"'fade0000-0000-0000-0000-000000000001'::uuid").replace('p_club_id',"'"+club+"'::uuid").replace('p_start',"date '2026-10-18'").replace('p_end',"date '2026-10-25'")
 payload=json.loads(q(query));rows_hash=q("SELECT md5('"+json.dumps(payload['rows'])+"'::jsonb::text)");roster_hash=q("SELECT md5('"+json.dumps(payload['attribution_roster'])+"'::jsonb::text)")
 for live,local in [('fa19da096e2fb86cf1edbf78832057e3',original_hash),('a8fac2d3d785bd50a57f020e750476b9',rows_hash),('479b1709aa68e35d315dd0425c40849d',roster_hash)]:
  assert migration.count(live)==1; migration=migration.replace(live,local)
 # Fail after the first credit: the entire migration, version publication,
 # funding debit, receipt, function patch and earlier credit must roll back.
 q("UPDATE fixture_control SET fail_user='d33a878b-e189-4bd4-aeb8-d9d4acf6cb34'")
 q(migration,'fixture_credit_failure')
 assert q("SELECT promo_wallet FROM union_wallets")=='1500'
 assert q('SELECT count(*) FROM wallet_credit_idempotency')=='0'
 assert q("SELECT to_regclass('leaderboard_payout_corrections') IS NULL")=='t'
 assert q('SELECT count(*) FROM leaderboard_reward_program_versions')=='1'
 assert q('SELECT '+basis_call)==original_basis
 q('UPDATE fixture_control SET fail_user=NULL')
 q(migration)
 assert q("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,provolatile,proconfig)ORDER BY proname) FROM pg_proc WHERE proname IN('fn_leaderboard_complete_round_basis','fn_payout_leaderboard','fn_get_leaderboard_settlement_status')")==original_meta
 assert float(q('SELECT promo_wallet FROM union_wallets'))==1000
 assert q("SELECT fn_leaderboard_complete_round_basis(md5('standalone')::uuid,'weekly','2026-10-18','2026-10-25')")==standalone_before
 mid=json.loads(q(f"SELECT fn_leaderboard_complete_round_basis('{club}','weekly','2026-10-11','2026-10-18')"))
 assert mid['attribution_contract']=='union_home_join_order_v1'
 assert all(r['hands_played']==0 for r in mid['rows'])
 q("UPDATE club_members SET joined_at=NULL WHERE user_id='d712fcf0-3741-461d-9617-8cb68fb1c54c'")
 q(f"SELECT fn_leaderboard_complete_round_basis('{club}','weekly','2026-10-11','2026-10-18')",'LEADERBOARD_UNION_MEMBERSHIP_DATE_UNAVAILABLE')
 q("UPDATE club_members SET joined_at='2026-09-01' WHERE user_id='d712fcf0-3741-461d-9617-8cb68fb1c54c'")

 assert float(q('SELECT sum(chip_balance) FROM club_members'))==500
 assert q('SELECT count(*) FROM wallet_credit_idempotency')=='3'
 assert float(q('SELECT total_paid FROM leaderboard_payout_batches'))==0
 assert q('SELECT basis::text FROM leaderboard_round_basis_receipts')==original_basis
 assert float(q('SELECT total_paid FROM leaderboard_payout_corrections'))==500
 q('UPDATE leaderboard_payout_corrections SET reason=reason','LEADERBOARD_BASIS_IMMUTABLE')
 q('TRUNCATE leaderboard_payout_corrections','LEADERBOARD_BASIS_IMMUTABLE')
 q('SET ROLE authenticated;SELECT * FROM leaderboard_payout_corrections','permission denied')
 q(f"SELECT fn_get_leaderboard_settlement_status('{club}','weekly','2026-10-18')",'Authentication Required')
 status=json.loads(q("SET request.jwt.claim.sub='d712fcf0-3741-461d-9617-8cb68fb1c54c';SELECT fn_get_leaderboard_settlement_status('"+club+"','weekly','2026-10-18')"))
 assert status['batch']['total_paid']==500 and status['batch']['winner_count']==3 and len(status['receipts'])==3,status
 assert status['batch']['correction']['total_paid']==500
 assert status['batch']['funding_owner_type']=='union' and status['batch']['funding_union_id']=='fade0000-0000-0000-0000-000000000001'
 replay=json.loads(q(f"SELECT fn_payout_leaderboard('{club}','weekly','hands_played','2026-10-18 00:00Z','2026-10-25 00:00Z')"))
 assert replay['already_settled'] and replay['total_paid']==500
 assert float(q('SELECT promo_wallet FROM union_wallets'))==1000
 # The appended witness also fixes the closed public ranking reader.
 ranked=json.loads(q(f"SELECT jsonb_agg(x) FROM (SELECT user_id,hands_played,rank FROM fn_club_leaderboard_by_dates('{club}','hands_played','2026-10-18','2026-10-25',3,0))x"))
 assert [r['hands_played'] for r in ranked]==[24786,22889,22647],ranked
 # Actual prospective payout owner, with its real selection, pool allocation,
 # funding and receipt logic. Only clock is moved in disposable definitions.
 for name in ['fn_leaderboard_complete_round_basis','fn_club_leaderboard_by_dates','fn_payout_leaderboard']:
  definition=q("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='"+name+"'")
  q(definition.replace('CURRENT_TIMESTAMP',"timestamptz '2026-11-02 08:00Z'"))
 q("UPDATE union_wallets SET promo_wallet=499")
 q(f"SELECT fn_payout_leaderboard('{club}','weekly','hands_played','2026-10-25 00:00Z','2026-11-01 00:00Z')",'LEADERBOARD_PROMO_UNDERFUNDED')
 assert q('SELECT count(*) FROM leaderboard_payout_batches')=='1'
 assert q('SELECT count(*) FROM wallet_credit_idempotency')=='3'
 assert float(q('SELECT promo_wallet FROM union_wallets'))==499
 q("UPDATE union_wallets SET promo_wallet=1000")
 prospective=json.loads(q(f"SELECT fn_payout_leaderboard('{club}','weekly','hands_played','2026-10-25 00:00Z','2026-11-01 00:00Z')"))
 assert prospective['total_paid']==500,prospective
 assert float(q('SELECT promo_wallet FROM union_wallets'))==500
 assert float(q('SELECT sum(chip_balance) FROM club_members'))==1000
 assert q('SELECT count(*) FROM leaderboard_round_basis_receipts')=='2'
 again=json.loads(q(f"SELECT fn_payout_leaderboard('{club}','weekly','hands_played','2026-10-25 00:00Z','2026-11-01 00:00Z')"))
 assert again['already_settled'] and float(q('SELECT promo_wallet FROM union_wallets'))==500
 # Later membership edits cannot rewrite the frozen paid ranking.
 frozen=q(f"SELECT fn_leaderboard_complete_round_basis('{club}','weekly','2026-10-25','2026-11-01')")
 q("UPDATE club_members SET joined_at='2026-12-01' WHERE user_id='d712fcf0-3741-461d-9617-8cb68fb1c54c'")
 assert q(f"SELECT fn_leaderboard_complete_round_basis('{club}','weekly','2026-10-25','2026-11-01')")==frozen
 print(json.dumps({'qualification':'passed','original_zero_winners_reproduced':True,'original_records_preserved':True,'append_only_correction':True,'partial_credit_rollback':True,'real_ranking_and_payout_owners':True,'corrected_and_prospective_500_chips':True,'replay_no_duplicate':True,'frozen_paid_roster':True,'acl_and_metadata_preserved':True,'production_money':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
