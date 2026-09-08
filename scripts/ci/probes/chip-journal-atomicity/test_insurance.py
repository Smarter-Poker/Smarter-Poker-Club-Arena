"""Insurance bank routing, canonical cents, replay and journal atomicity."""
from pathlib import Path
import re,os,subprocess,json
C="'50000000-0000-4000-8000-000000000001'"
T="'50000000-0000-4000-8000-000000000002'"
U="'50000000-0000-4000-8000-000000000003'"
P="'50000000-0000-4000-8000-000000000004'"
def verify_insurance(run):
 here=Path(__file__).resolve().parent
 definitions=[]
 for p in sorted((here.parents[3]/"supabase/migrations").glob("*.sql")):
  if p.name<"20260908052322":continue
  source=p.read_text()
  for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\.record_insurance_transaction\s*\(",source,re.I):
   tail=source[m.start():];body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
   end=tail.find(body.group(1),body.end());definitions.append(tail[:end+len(body.group(1))]+";")
 if not definitions:raise RuntimeError("Missing insurance definition")
 ddl=here.joinpath("insurance-fixture.sql").read_text()+definitions[-1]
 def call(premium="5",payout="2",kind="'insurance'",insured="10",equity="50"):
  return f"record_insurance_transaction({T},{C},1,{P},{equity},{premium},{insured},{payout},false,{kind})"
 def seed(private,union):
  return f"INSERT INTO clubs(id,union_id) VALUES({C},{U if union else 'NULL'}); INSERT INTO tables(id,club_id,is_private,union_id) VALUES({T},{C},{str(private).lower()},{U if union else 'NULL'});"
 state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in ["club_wallets","union_wallets","insurance_transactions","chip_ledger"])+")"
 count=0
 for private,union in [(True,True),(False,True),(False,False)]:
  setup=seed(private,union)
  bank="union" if union and not private else "club"
  run("BEGIN;"+ddl+setup+f"""
  DO $check$ DECLARE prior jsonb; BEGIN
   PERFORM set_config('app.ledger_category','outer',true);
   PERFORM set_config('app.ledger_counterparty','outer',true);
   PERFORM {call()};
   IF NOT EXISTS(SELECT 1 FROM insurance_transactions WHERE bank_type='{bank}' AND payout-premium=net_result)
    OR NOT EXISTS(SELECT 1 FROM chip_ledger WHERE category='insurance' AND from_type='table_stack'
      AND from_entity_id={T} AND amount=3)
    OR current_setting('app.ledger_category')<>'outer' OR current_setting('app.ledger_counterparty')<>'outer'
   THEN RAISE EXCEPTION 'Wrong insurance bank, journal or context'; END IF;
   SELECT {state} INTO prior; PERFORM {call()};
   IF prior IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Insurance replay changed accounting'; END IF;
  END $check$;ROLLBACK;""");count+=1
  for fault in ["55P03","40P01","23514","23505","XX001"]:
   run("BEGIN;"+ddl+setup+f"""
   DO $check$ DECLARE prior jsonb;caught boolean:=false;BEGIN
    SELECT {state} INTO prior;
    PERFORM set_config('test.journal_sqlstate','{fault}',true);
    BEGIN PERFORM {call()};EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true;END;
    IF NOT caught OR prior IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Partial insurance bank commit';END IF;
   END $check$;ROLLBACK;""");count+=1
  for second in [call(premium="6"),call(payout="3"),call(kind="'ev_cashout'"),call(insured="11"),call(equity="51")]:
   run("BEGIN;"+ddl+setup+f"""
   DO $check$ DECLARE prior jsonb;caught boolean:=false;BEGIN
    PERFORM {call()}; SELECT {state} INTO prior;
    BEGIN PERFORM {second};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
    IF NOT caught OR prior IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Changed insurance payment admitted';END IF;
   END $check$;ROLLBACK;""");count+=1
 setup=seed(True,True)
 for premium,payout,delta in [("0.105","0.104","0.01"),("2","5","-3")]:
  run("BEGIN;"+ddl+setup+f"""
  SELECT {call(premium=premium,payout=payout)};
  DO $check$ BEGIN
   IF (SELECT insurance_balance FROM club_wallets WHERE club_id={C})<>{delta}
    OR NOT EXISTS(SELECT 1 FROM insurance_transactions WHERE premium-payout={delta} AND net_result=-({delta}))
    OR NOT EXISTS(SELECT 1 FROM chip_ledger WHERE category='insurance' AND amount=abs({delta}))
   THEN RAISE EXCEPTION 'Insurance bank and receipt cents diverged'; END IF;
  END $check$;ROLLBACK;""");count+=1
 for invalid in ["NULL","-1","'NaN'::numeric","'Infinity'::numeric"]:
  run("BEGIN;"+ddl+setup+f"""
  DO $check$ DECLARE caught boolean:=false;BEGIN
   BEGIN PERFORM {call(premium=invalid)};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
   IF NOT caught OR EXISTS(SELECT 1 FROM insurance_transactions) THEN RAISE EXCEPTION 'Invalid insurance amount admitted';END IF;
  END $check$;ROLLBACK;""");count+=1
 if os.environ.get("PGNODE"):
  for conflict in [False,True]:
   payload=dict(name="insurance "+("conflict" if conflict else "replay"),setup=ddl+setup,actor="SELECT 1",
    first="to_jsonb("+call()+")",second="to_jsonb("+call(premium="6" if conflict else "5")+")",
    compositeReceipt=True,conflict=conflict,
    verify=f"""DO $check$ BEGIN
    IF (SELECT count(*) FROM insurance_transactions)<>1 OR (SELECT insurance_balance FROM club_wallets WHERE club_id={C})<>3
     OR (SELECT sum(amount) FROM chip_ledger)<>3 THEN RAISE EXCEPTION 'Concurrent insurance changed payment';END IF;
    END $check$;""",
    cleanup=f"DROP TRIGGER insurance_club_journal ON club_wallets; DROP TRIGGER insurance_union_journal ON union_wallets; DELETE FROM club_wallets WHERE club_id={C}; DELETE FROM union_wallets WHERE union_id={U}; DELETE FROM clubs WHERE id={C}; DELETE FROM tables WHERE id={T}; DELETE FROM chip_ledger; DROP FUNCTION record_insurance_transaction(uuid,uuid,integer,uuid,numeric,numeric,numeric,numeric,boolean,character varying); DROP TABLE insurance_transactions; ALTER TABLE club_wallets DROP COLUMN insurance_balance; ALTER TABLE union_wallets DROP COLUMN insurance_wallet;")
   result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True)
   if result.returncode:raise RuntimeError(result.stderr)
   print(result.stdout.strip(),flush=True);count+=1
 print(f"TOTAL fixed insurance: {count} passing cases",flush=True)
