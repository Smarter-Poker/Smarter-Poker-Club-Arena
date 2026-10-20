#!/usr/bin/env python3
"""Qualify club-scoped cash/promo journal keys with the original PG17 guards."""
import argparse,json,os,shutil,socket,subprocess,tempfile,time
from pathlib import Path

ap=argparse.ArgumentParser()
ap.add_argument('--pg-bin',type=Path,required=True)
ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2]
fixture=json.loads((root/'scripts/ci/fixtures/agent-wallet-club-journal/live-functions-20261020.json').read_text())
candidate=next((root/'supabase/migrations').glob('20261020151328_*')).read_text()
base=Path(tempfile.mkdtemp(prefix='agent-club-journal-',dir=a.scratch));started=False
with socket.socket()as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'LC_ALL':'C','TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x)for x in args],input=content,text=True,capture_output=True,env=env,timeout=40)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
psql=[a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',base/'s','-p',port,'-U','postgres','-d','postgres']
def sql(s,error=None):return run(psql,s,error)
user='10000000-0000-0000-0000-000000000001'
c1='20000000-0000-0000-0000-000000000001';c2='20000000-0000-0000-0000-000000000002'
union='30000000-0000-0000-0000-000000000001'
tx="BEGIN;SET LOCAL app.ledger_autoskip_agents='1';SET LOCAL app.ledger_autoskip_club_members='1';"
def opposite(table,column):
 return f"UPDATE {table} SET {column}={column}+CASE WHEN club_id='{c1}'THEN -10 ELSE 10 END;"
def balances(table,column):return sql(f"SELECT string_agg({column}::text,','ORDER BY club_id)FROM {table}")
def legs(kind,wrong=False):
 target=c1 if wrong else c2
 return f"INSERT INTO chip_ledger(from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id)VALUES('{kind}','{user}','clearing',NULL,10,'transfer','{c1}'),('clearing',NULL,'{kind}','{user}',10,'transfer','{target}');"
changed=[r for r in fixture['guards']if r['proname']in('fn_ca_tally_store_move','fn_ca_ledger_tally_key')]
def metadata():
 return sql("SELECT jsonb_agg(jsonb_build_array(proname,pg_get_userbyid(proowner),proacl,proconfig,prosecdef,provolatile)ORDER BY proname)FROM pg_proc WHERE oid IN('fn_ca_tally_store_move()'::regprocedure,'fn_ca_ledger_tally_key(text,uuid,uuid)'::regprocedure)")
try:
 (base/'s').mkdir()
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'pg.log','-o',f'-h "" -k {base}/s -p {port}','-w','start']);started=True
 sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;")
 sql("CREATE TABLE agents(id uuid,user_id uuid,club_id uuid,agent_wallet_balance numeric,promo_wallet_balance numeric);CREATE TABLE club_members(user_id uuid,club_id uuid,promo_balance numeric);CREATE TABLE clubs(id uuid,promo_balance numeric,insurance_balance numeric);CREATE TABLE unions(id uuid,promo_fund_balance numeric);CREATE TABLE union_wallets(id uuid,union_id uuid);CREATE TABLE club_wallets(id uuid,club_id uuid);")
 sql("CREATE TABLE ca_ledger_invariant_store_mode(store text,mode text);INSERT INTO ca_ledger_invariant_store_mode VALUES('agent_wallet','refuse'),('promo_wallet','refuse');CREATE TABLE ca_ledger_invariant_mode(mode text);INSERT INTO ca_ledger_invariant_mode VALUES('refuse');")
 # These uninvoked scope predicates are typed prerequisites of unchanged arms.
 sql("CREATE FUNCTION fn_ca_felt_counts_table(uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;CREATE FUNCTION fn_ca_tournament_counts(uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;")
 sql("CREATE TABLE chip_ledger(performed_by uuid,from_type text,from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,amount numeric,category text,club_id uuid,union_id uuid,description text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,metadata jsonb);")
 sql(f"INSERT INTO agents VALUES('00000000-0000-0000-0000-000000000001','{user}','{c1}',100,100),('00000000-0000-0000-0000-000000000002','{user}','{c2}',100,100);INSERT INTO club_members VALUES('{user}','{c1}',100),('{user}','{c2}',100);INSERT INTO clubs VALUES('{c1}',100,0),('{c2}',100,0);INSERT INTO unions VALUES('{union}',100);")
 for r in fixture['components']:
  sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['hash']
 for r in fixture['guards']:
  sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
  sql('REVOKE ALL ON FUNCTION '+r['signature']+' FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION '+r['signature']+' TO service_role;')
 sql("CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text,declared_ref text,declared_at timestamptz,updated_at timestamptz);CREATE TABLE ca_guard_def_history(proname text,def_hash text,def_text text,PRIMARY KEY(proname,def_hash));")
 for r in changed:
  sql("SELECT fn_ca_declare_guard_redefinition('"+r['proname']+"','retained original fixture definition')")
 before_meta=metadata()
 for table,args in [('agents',"'agent_wallet_balance=agent_wallet','promo_wallet_balance=promo_wallet'"),('club_members',"'promo_balance=promo_wallet'"),('clubs',"'promo_balance=promo_wallet'"),('unions',"'promo_fund_balance=promo_wallet'")]:
  sql(f"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger({args});CREATE TRIGGER zy_ca_tally_store_move AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_store_move();CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row AFTER INSERT OR UPDATE OR DELETE ON {table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();")
 sql("CREATE TRIGGER ledger_tally AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_ledger_leg();CREATE CONSTRAINT TRIGGER ledger_check AFTER INSERT ON chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();")
 cases=[('agents','agent_wallet_balance','agent_wallet'),('agents','promo_wallet_balance','promo_wallet'),('club_members','promo_balance','promo_wallet')]
 # Actual old components commit each mistaken cancellation with no journal.
 for table,column,kind in cases:
  n=sql('SELECT count(*)FROM chip_ledger')
  sql(tx+opposite(table,column)+'COMMIT;');assert balances(table,column)=='90,110'
  assert sql('SELECT count(*)FROM chip_ledger')==n
  sql(tx+f'UPDATE {table} SET {column}=100;COMMIT;')
  sql(tx+f"UPDATE {table} SET {column}=90 WHERE club_id='{c1}';COMMIT;",'REFUSED: balance_moved_without_its_ledger_row')
 # A later preimage failure rolls back the first definition and declaration.
 original_key=next(r for r in changed if r['proname']=='fn_ca_ledger_tally_key')
 sql(original_key['definition'].replace('DECLARE\n  v_union uuid;','DECLARE\n  /* isolated drift control */\n  v_union uuid;'))
 sql(candidate,'agent_club_journal_preimage_changed')
 assert sql("SELECT md5(pg_get_functiondef('fn_ca_tally_store_move()'::regprocedure))")==next(r['md5']for r in changed if r['proname']=='fn_ca_tally_store_move')
 assert sql('SELECT count(*)FROM ca_guard_def_history')=='2'
 sql(original_key['definition'])
 # Three independent in-flight writer cases. Installation must not mix keys.
 for statement in [f"UPDATE agents SET agent_wallet_balance=agent_wallet_balance+1 WHERE club_id='{c1}'",f"UPDATE club_members SET promo_balance=promo_balance+1 WHERE club_id='{c1}'","INSERT INTO chip_ledger(from_type,to_type,amount,category)VALUES('external','external',1,'transfer')"]:
  actor=subprocess.Popen([str(x)for x in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  actor.stdin.write("BEGIN;SET LOCAL app.ledger_counterparty='external';"+statement+';\n\\echo WRITER_READY\n');actor.stdin.flush()
  assert actor.stdout.readline().strip()=='WRITER_READY'
  sql(candidate,'could not obtain lock on relation')
  assert sql('SELECT count(*)FROM ca_guard_def_history')=='2'
  actor.stdin.write('COMMIT;\n');actor.stdin.close();assert actor.wait(timeout=10)==0,actor.stderr.read()
 # Restore ordinary journaled changes before the post-change controls.
 sql(f"BEGIN;SET LOCAL app.ledger_counterparty='external';UPDATE agents SET agent_wallet_balance=100 WHERE club_id='{c1}';UPDATE club_members SET promo_balance=100 WHERE club_id='{c1}';COMMIT;")
 began=time.monotonic();sql(candidate);install_seconds=time.monotonic()-began
 assert sql('SELECT '+candidate.splitlines()[0].split(': ',1)[1])=='t'
 assert metadata()==before_meta
 assert sql('SELECT count(*)FROM ca_guard_def_history')=='4'
 # Exact cash and both promo producers must agree with the ledger key reader.
 for table,column,kind in cases:
  sql(tx+opposite(table,column)+'COMMIT;','REFUSED: balance_moved_without_its_ledger_row')
  assert balances(table,column)=='100,100'
  sql(tx+opposite(table,column)+legs(kind,True)+'COMMIT;','REFUSED: balance_moved_without_its_ledger_row')
  assert balances(table,column)=='100,100'
  sql(tx+opposite(table,column)+legs(kind)+'COMMIT;');assert balances(table,column)=='90,110'
  # Duplicate/no-op state does not emit a second money leg.
  n=sql('SELECT count(*)FROM chip_ledger');sql(tx+f'UPDATE {table} SET {column}={column};COMMIT;');assert sql('SELECT count(*)FROM chip_ledger')==n
  # Ordinary autoledger remains compatible with the new exact club keys.
  sql(f"BEGIN;SET LOCAL app.ledger_counterparty='external';UPDATE {table} SET {column}=100;COMMIT;");assert balances(table,column)=='100,100'
 # Club/union promo banks retain their original global account identities.
 for entity in [c1,c2,union]:assert sql(f"SELECT fn_ca_ledger_tally_key('promo_wallet','{entity}','{c1}')")=='promo_wallet:'+entity
 for table,column in [('clubs','promo_balance'),('unions','promo_fund_balance')]:sql(f"BEGIN;SET LOCAL app.ledger_counterparty='external';UPDATE {table} SET {column}={column}+1;COMMIT;")
 # Missing or foreign club cannot satisfy a scoped user's balance change.
 sql(tx+opposite('agents','agent_wallet_balance')+legs('agent_wallet').replace("'transfer','"+c2+"'","'transfer',NULL")+'COMMIT;','REFUSED: balance_moved_without_its_ledger_row')
 for kind in ['club_treasury','bbj_pool','spin_reserve','opening_setup','leaderboard_round']:
  assert sql(f"SELECT fn_ca_ledger_tally_key('{kind}','{c1}','{c2}')")==kind+':'+c1
 assert sql("SELECT fn_ca_ledger_tally_key('table_stack',NULL,NULL)")=='table_stack'
 assert sql("SELECT fn_ca_ledger_tally_key('escrow',NULL,NULL)")=='ticket_escrow'
 assert sql("SELECT fn_ca_ledger_tally_key('uncovered',NULL,NULL)IS NULL")=='t'
 sql(candidate,'agent_club_journal_preimage_changed')
 assert metadata()==before_meta
 print(json.dumps({'qualification':'passed','actual_original_components':7,'old_cash_and_two_promo_cross_club_missing_journal_cases_reproduced':3,'same_club_missing_leg_refused_before':True,'new_missing_wrong_null_club_refusals':True,'correct_club_journal_and_autoledger':True,'duplicate_noop_no_extra_legs':True,'club_union_promo_banks_unchanged':True,'other_account_keys_unchanged':True,'inflight_writer_cases_refuse_installation_then_finish_unchanged':3,'late_preimage_failure_rolls_back_earlier_definition_and_guard_declaration':True,'metadata_and_guard_declarations_exact':True,'replay_refused':True,'actual_installation_lock_seconds':round(install_seconds,6),'no_production_mutation':True,'fixture_limit':'Actual original journal/store/checker/autoledger components; unrelated wallet RPC authorization is not exercised.'}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
