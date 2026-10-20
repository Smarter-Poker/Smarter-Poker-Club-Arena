#!/usr/bin/env python3
"""Execute original and atomic historical terms on an isolated PG17, never production."""
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
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
 CREATE TABLE profiles(id uuid PRIMARY KEY,status text);
 CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,chip_treasury numeric,created_at timestamptz);
 CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,chip_balance numeric,held_chips numeric DEFAULT 0,joined_at timestamptz,PRIMARY KEY(club_id,user_id));
 CREATE TABLE ca_chip_baseline(club_id uuid,user_id uuid,opening_balance numeric,taken_at timestamptz,PRIMARY KEY(club_id,user_id));
 CREATE TABLE ca_treasury_baseline(club_id uuid PRIMARY KEY,opening_balance numeric,taken_at timestamptz);
 CREATE TABLE agents(club_id uuid,agent_wallet_balance numeric,promo_wallet_balance numeric);
 CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid);
 CREATE TABLE table_seats(table_id uuid,stack numeric,left_at timestamptz);
 CREATE TABLE chip_ledger(club_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,created_at timestamptz,status text NOT NULL);
 CREATE TABLE ca_chip_wallet_day_seals(day date PRIMARY KEY,manifest_sha256 text NOT NULL);
 CREATE TABLE ca_ledger_day_manifests(day date PRIMARY KEY,sha256 text NOT NULL);
 CREATE TABLE ca_chip_wallet_day_totals(club_id uuid,day date,user_id uuid,net numeric);
 CREATE FUNCTION fn_cashier_member_is_active(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND status='active')$$;
 CREATE FUNCTION fn_club_bank_role(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=$2$$;
 """)
 C='10000000-0000-0000-0000-000000000001';D='10000000-0000-0000-0000-000000000002';E='10000000-0000-0000-0000-000000000003'
 U='20000000-0000-0000-0000-000000000001';V='20000000-0000-0000-0000-000000000002';W='20000000-0000-0000-0000-000000000003'
 sql(f"""INSERT INTO profiles VALUES('{U}',NULL),('{V}',NULL),('{W}',NULL);
 INSERT INTO clubs VALUES('{C}','chips',500,'2026-08-01'),('{D}','chips',400,'2026-08-31 12:00Z'),('{E}','chips',0,'2026-08-01');
 INSERT INTO ca_treasury_baseline VALUES('{C}',500,'2026-08-27 12:00Z'),('{D}',500,'2026-08-31 12:00Z'),('{E}',0,'2026-08-01');
 INSERT INTO club_members VALUES('{C}','{U}','owner','active',120,0,'2026-08-01'),('{D}','{V}','owner','active',50,0,'2026-08-31 12:01Z'),('{D}','{W}','player','active',50,0,'2026-08-31 12:02Z'),('{E}','{U}','owner','active',0,0,'2026-08-01');
 INSERT INTO ca_chip_baseline VALUES('{C}','{U}',100,'2026-08-27 12:00Z');
 INSERT INTO chip_ledger VALUES('{C}','issuance_reserve',NULL,'player_wallet','{U}',20,'2026-08-28','posted'),('{D}','club_treasury','{D}','player_wallet','{V}',100,'2026-08-31 13:00Z','posted'),('{D}','player_wallet','{V}','player_wallet','{W}',50,'2026-09-01 12:00Z','posted');
 INSERT INTO ca_chip_wallet_day_seals VALUES('2026-09-01','v1');INSERT INTO ca_ledger_day_manifests VALUES('2026-09-01','v1');
 INSERT INTO ca_chip_wallet_day_totals VALUES('{D}','2026-09-01','{V}',-50),('{D}','2026-09-01','{W}',50);""")
 pre=json.loads((root/'scripts/ci/fixtures/new-club-conservation-preimage.json').read_text());sql(pre['definition']);sql(pre['definition'].replace('public.fn_cashier_conservation_report(', 'public.conservation_before('))
 sig='fn_cashier_conservation_report(uuid)';assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==pre['md5']
 sql('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION '+sig+' TO authenticated,service_role;')
 def report(club,user,setup='',error=None):
  result=sql("BEGIN READ ONLY;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='"+user+"';SELECT fn_cashier_conservation_report('"+club+"');ROLLBACK;",error)
  return json.loads(result) if not error else None
 legacy=report(C,U);assert legacy['players']['status']=='verified'
 old=report(D,V);assert old['players']['status']=='incomplete' and old['players']['missing']==2
 meta="SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig) FROM pg_proc WHERE oid='"+sig+"'::regprocedure"
 metadata=sql(meta)
 migration=next((root/'supabase/migrations').glob('20261019185853_*')).read_text();sql(migration)
 new=report(D,V);assert new['players']['status']=='verified' and new['players']['checked']==2 and new['players']['missing']==0
 assert new['players']['actual']=='100' and new['players']['expected']=='100' and new['players']['absolute_drift']=='0'
 assert new['players']['basis']=='journal_from_club_creation' and new['bank']['status']=='verified'
 assert {k:v for k,v in report(C,U).items() if k!='as_of'}=={k:v for k,v in legacy.items() if k!='as_of'}
 assert report(E,U)['players']['status']=='incomplete'
 def legacy_equivalent(change):
  assert sql("BEGIN;"+change+";SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='"+U+"';SELECT (fn_cashier_conservation_report('"+C+"')-'as_of')=(conservation_before('"+C+"')-'as_of');ROLLBACK;")=='t'
 legacy_equivalent(f"INSERT INTO club_members VALUES('{C}','{V}','player','active',15,0,'2026-08-01');INSERT INTO ca_chip_baseline VALUES('{C}','{V}',10,'2026-08-28');INSERT INTO chip_ledger VALUES('{C}','issuance_reserve',NULL,'player_wallet','{V}',5,'2026-08-29','correction')")
 legacy_equivalent(f"INSERT INTO club_members VALUES('{C}','{W}','player','active',7,0,'2026-08-29');INSERT INTO chip_ledger VALUES('{C}','issuance_reserve',NULL,'player_wallet','{W}',7,'2026-08-29','reversal')")
 legacy_equivalent(f"INSERT INTO ca_chip_baseline VALUES('{C}','{V}',4,'2026-08-28')")
 legacy_equivalent(f"UPDATE ca_chip_baseline SET taken_at=NULL WHERE club_id='{C}'")
 legacy_equivalent(f"UPDATE ca_chip_baseline SET taken_at=now()+interval '1 day' WHERE club_id='{C}'")
 legacy_equivalent(f"DELETE FROM ca_chip_baseline WHERE club_id='{C}'")

 # Raw fallback when a seal is missing or its day manifest changes.
 sql("UPDATE ca_ledger_day_manifests SET sha256='v2'");assert report(D,V)['players']==new['players']
 sql('DELETE FROM ca_chip_wallet_day_seals');assert report(D,V)['players']==new['players']
 # A missing leg cannot become a fabricated opening amount.
 sql(f"UPDATE club_members SET chip_balance=51 WHERE club_id='{D}' AND user_id='{V}'")
 drift=report(D,V)['players'];assert drift['status']=='attention' and drift['mismatches']==1 and drift['absolute_drift']=='1'
 sql(f"UPDATE club_members SET chip_balance=50 WHERE club_id='{D}' AND user_id='{V}'")
 # Legacy explicit cutoffs retain precedence, including pre-cutoff member unknowns.
 sql(f"INSERT INTO ca_chip_baseline VALUES('{D}','{V}',50,'2026-09-02')")
 explicit=report(D,V)['players'];assert explicit['status']=='incomplete' and explicit['checked']==1 and explicit['missing']==1 and 'basis' not in explicit
 sql(f"DELETE FROM ca_chip_baseline WHERE club_id='{D}'")
 # Unknown, future or invalid club/member birth dates remain incomplete.
 sql(f"UPDATE clubs SET created_at=NULL WHERE id='{D}'");assert report(D,V)['players']['status']=='incomplete'
 sql(f"UPDATE clubs SET created_at=now()+interval '1 day' WHERE id='{D}'");assert report(D,V)['players']['status']=='incomplete'
 sql(f"UPDATE clubs SET created_at='2026-08-31 12:00Z' WHERE id='{D}';UPDATE club_members SET joined_at='2026-08-01' WHERE club_id='{D}' AND user_id='{W}'")
 assert report(D,V)['players']['missing']==1
 sql(f"UPDATE club_members SET joined_at='2026-08-31 12:02Z' WHERE club_id='{D}' AND user_id='{W}'")
 report(D,W,error='Active Club Finance Access Required')
 for role in ['owner','co_owner','admin']:
  sql(f"UPDATE club_members SET role='{role}' WHERE club_id='{D}' AND user_id='{V}'");assert report(D,V)['players']['status']=='verified'
 sql(f"UPDATE club_members SET status='suspended' WHERE club_id='{D}' AND user_id='{V}'");report(D,V,error='Active Club Finance Access Required')
 sql(f"UPDATE club_members SET status='active' WHERE club_id='{D}' AND user_id='{V}';UPDATE profiles SET status='deleted' WHERE id='{V}'");report(D,V,error='Active Club Finance Access Required')
 sql(f"SELECT fn_cashier_conservation_report('{D}')",'Authentication Required')
 sql(f"SET ROLE anon;SELECT fn_cashier_conservation_report('{D}')",'permission denied')
 assert sql(meta)==metadata
 post=sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")
 # Only the actual successor definition may be accepted by the live canary.
 assert post=='617a6a58c41f8a1f204e3438d6ea2a4c',post
 contract=(root/'scripts/verification-harness/cashier-release-contract.sql').read_text()
 entry=contract[contract.index("'signature', 'public.fn_cashier_conservation_report(uuid)'"):]
 entry=entry[:entry.index('    )')]
 hashes=re.findall(r"'hash',\s*'([0-9a-f]{32})'",entry)
 assert hashes==[post] and "'replacement_hash'" not in entry,(post,entry)
 assert "'20261019185853'" in contract and "'new_clubs_reconcile_player_wallets_from_their_journal_origin'" in contract
 sql(migration,'new_club_conservation_preimage_changed')
 print(json.dumps({'qualification':'passed','old_missing_new_covered':True,'exact_bank_and_player_balances':True,'legacy_report_unchanged':True,'legacy_full_report_equivalence_controls':6,'raw_and_sealed_day_equivalence':True,'missing_leg_stays_mismatch':True,'legacy_unknown_null_future_prebirth_member_stay_incomplete':True,'explicit_baseline_precedence':True,'read_only':True,'role_and_session_refusals_preserved':True,'metadata_preserved':True,'replay_refused':True,'postimage_md5':post,'production_money_write':False,'role_helpers_controlled_in_fixture':True}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
