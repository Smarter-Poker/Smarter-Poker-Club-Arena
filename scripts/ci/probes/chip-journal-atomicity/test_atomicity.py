#!/usr/bin/env python3
"""Execute real PostgreSQL bodies against isolated fixtures; never production."""
import os, subprocess, sys, re
from pathlib import Path
pg=os.environ.get("PSQL", "/opt/homebrew/opt/postgresql@17/bin/psql")
if os.environ.get("PGNODE"):
 args=[os.environ["PGNODE"],str(Path(__file__).resolve().parent/"postgres-runtime/query.mjs")]
elif os.environ.get("PGCONTAINER"):
 args=["docker","exec","-i",os.environ["PGCONTAINER"],"psql","-X","-q","-U","postgres","-d","journal_atomicity","-v","ON_ERROR_STOP=1"]
else:
 args=[pg,"-X","-q","-h",os.environ["PGHOST"],"-p",os.environ["PGPORT"],"-U",os.environ.get("PGUSER","smarter.poker"),"-d",os.environ.get("PGDATABASE","postgres"),"-v","ON_ERROR_STOP=1"]
def run(sql):
 r=subprocess.run(args,input=sql,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
if "--bootstrap" in sys.argv:
 here=Path(__file__).resolve().parent
 root=here.parents[3]
 names={"fn_award_satellite_seat","atomic_distribute_rake","credit_club_rake_to_treasury","fn_ca_autoledger","fn_ca_autoledger_delete","fn_ca_post_leg","fn_club_members_ledger_writer","fn_horse_fund_from_treasury","fn_horse_seat_from_treasury"}
 definitions={}
 baseline="20260908024909"
 for path in sorted((root/"supabase/migrations").glob("*.sql")):
  if path.name < baseline: continue
  text=path.read_text()
  for name in names:
   pattern=r"CREATE OR REPLACE FUNCTION public\."+re.escape(name)+r"\s*\("
   for match in re.finditer(pattern,text,re.I):
    tail=text[match.start():]
    body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
    if not body: raise RuntimeError("Missing dollar-quoted body: "+name)
    end=tail.find(body.group(1),body.end())
    if end<0: raise RuntimeError("Unterminated function: "+name)
    definitions[name]=tail[:end+len(body.group(1))]+";"
 if definitions.keys()!=names: raise RuntimeError("Missing authoritative function declarations")
 run(here.joinpath("fixture.sql").read_text()+"\n"+"\n".join(definitions.values()))
a="'00000000-0000-4000-8000-000000000001'"
b="'00000000-0000-4000-8000-000000000002'"
c="'00000000-0000-4000-8000-000000000003'"
u="'00000000-0000-4000-8000-000000000004'"
op="'00000000-0000-4000-8000-000000000005'"
setup=f"""
INSERT INTO clubs(id) VALUES({a});
INSERT INTO bbj_pools(id,club_id) VALUES({b},{a});
INSERT INTO club_members(id,user_id,club_id) VALUES({c},{u},{a});
INSERT INTO tables(id,club_id) VALUES({b},{a});
INSERT INTO table_seats VALUES({b},{u},1,10,false,NULL);
CREATE TRIGGER auto AFTER INSERT OR UPDATE ON bbj_pools FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');
CREATE TRIGGER autodel BEFORE DELETE ON bbj_pools FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');
CREATE TRIGGER player AFTER UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
"""
cases={
 "bbj_update":f"UPDATE bbj_pools SET main_balance=main_balance+0.25 WHERE id={b}",
 "bbj_insert":f"INSERT INTO bbj_pools(id,club_id) VALUES({c},{a})",
 "bbj_delete":f"DELETE FROM bbj_pools WHERE id={b}",
 "player_wallet":f"UPDATE club_members SET chip_balance=chip_balance-5 WHERE id={c}",
 "post_leg":f"DO $op$ BEGIN UPDATE clubs SET chip_treasury=chip_treasury+5; PERFORM fn_ca_post_leg('rake','table_stack',{b},'club_treasury',{a},5,{a},'probe:leg','test'); END $op$",
 "treasury_credit":f"SELECT credit_club_rake_to_treasury({a},5)",
 "rake_distribution":f"SELECT * FROM atomic_distribute_rake({b},{a},NULL,1,5,0,50,2,NULL,NULL,NULL,'WEIGHTED_CONTRIBUTED')",
 "seat_funding":f"SELECT fn_horse_seat_from_treasury({b},{c},2,5,{op})",
 "reload_funding":f"SELECT fn_horse_fund_from_treasury({b},{u},5,{op})",
}
state_tables=["clubs","bbj_pools","club_members","table_seats","chip_ledger","chip_transactions","cash_baselines","rake_records","rake_distribution_legs","club_wallets","club_wallet_transactions"]
state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in state_tables)+")"
faults=["55P03","40P01","23514","23505","XX001"]
mode=sys.argv[1]
if mode not in ("fixed","original"): raise ValueError("Expected fixed or original mode")
passed=0
for name,operation in cases.items():
 for fault in faults:
  expected="true" if mode=="fixed" else "false"
  check=f"""
DO $check$
DECLARE before_state jsonb; after_state jsonb; caught boolean:=false; st text;
BEGIN
 SELECT {state} INTO before_state;
 PERFORM set_config('test.journal_sqlstate','{fault}',true);
 BEGIN EXECUTE $statement$ {operation} $statement$;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
  IF st <> '{fault}' THEN RAISE EXCEPTION 'Unexpected SQLSTATE %: %',st,SQLERRM; END IF;
  caught:=true;
 END;
 SELECT {state} INTO after_state;
 IF caught <> {expected} THEN RAISE EXCEPTION 'Incorrect error propagation'; END IF;
 IF {expected} AND before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Partial balance/journal commit'; END IF;
 IF NOT {expected} AND before_state IS NOT DISTINCT FROM after_state THEN RAISE EXCEPTION 'Original defect not reproduced'; END IF;
END $check$;
"""
  run("BEGIN;"+setup+check+"ROLLBACK;")
  passed+=1
 print(f"{mode}: {name}: {len(faults)} fault cases passed",flush=True)
if mode=="fixed":
 expected_counts={"bbj_update":1,"bbj_insert":3,"bbj_delete":3,"player_wallet":1,"post_leg":1,"treasury_credit":1,"rake_distribution":1,"seat_funding":1,"reload_funding":1}
 success_checks={
  "bbj_update":"(SELECT main_balance FROM bbj_pools)=100.25",
  "bbj_insert":"(SELECT sum(main_balance) FROM bbj_pools)=200",
  "bbj_delete":"NOT EXISTS(SELECT 1 FROM bbj_pools)",
  "player_wallet":"(SELECT chip_balance FROM club_members)=95",
  "post_leg":"(SELECT chip_treasury FROM clubs)=105",
  "treasury_credit":"(SELECT chip_treasury FROM clubs)=105",
  "rake_distribution":"(SELECT chip_treasury FROM clubs)=105 AND (SELECT period_rake_collected FROM club_wallets)=5",
  "seat_funding":"(SELECT chip_treasury FROM clubs)=95 AND (SELECT sum(stack) FROM table_seats)=15",
  "reload_funding":"(SELECT chip_treasury FROM clubs)=95 AND (SELECT sum(stack) FROM table_seats)=15",
 }
 for name,operation in cases.items():
  run("BEGIN;"+setup+operation+";"+f"""
DO $verify$ BEGIN
 IF NOT ({success_checks[name]}) THEN RAISE EXCEPTION 'Wrong successful balances'; END IF;
 IF (SELECT count(*) FROM chip_ledger)<>{expected_counts[name]} THEN RAISE EXCEPTION 'Wrong successful journal count'; END IF;
END $verify$;ROLLBACK;""")
  passed+=1
 for name in ["rake_distribution","seat_funding","reload_funding"]:
  operation=cases[name]
  run("BEGIN;"+setup+operation+";"+f"""
DO $verify$
DECLARE first_state jsonb; replay_state jsonb;
BEGIN
 SELECT {state} INTO first_state;
 EXECUTE $operation$ {operation} $operation$;
 SELECT {state} INTO replay_state;
 IF first_state IS DISTINCT FROM replay_state THEN RAISE EXCEPTION 'Replay changed balance or journal'; END IF;
END $verify$;ROLLBACK;""")
  passed+=1
print(f"TOTAL {mode}: {passed} passing cases",flush=True)

if mode=="fixed":
 from test_satellite import verify_satellite
 verify_satellite(run)

if mode=="fixed":
 from test_cashout import verify_cashout
 verify_cashout(run)

if mode=="fixed":
 from test_hand import verify_hand
 if os.environ.get("HAND_ORIGINAL_PROOF"):
  verify_hand(run, os.environ["HAND_ORIGINAL_PROOF"])
 verify_hand(run)

if mode=="fixed":
 from test_union_periods import verify_union_periods
 verify_union_periods(run)

if mode=="fixed":
 from test_bbj import verify_bbj
 verify_bbj(run)

if mode=="fixed":
 from test_insurance import verify_insurance
 verify_insurance(run)
