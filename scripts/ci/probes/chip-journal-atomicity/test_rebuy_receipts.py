"""Rebuy receipts bind scope and survive temporary key expiry."""
import os,re,json,subprocess
from pathlib import Path
def verify_rebuy_receipts(run):
 here=Path(__file__).resolve().parent;root=here.parents[3]
 def latest(name):
  result=None
  for p in sorted((root/"supabase/migrations").glob("*.sql")):
   if p.name<"20260908024909":continue
   s=p.read_text()
   for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",s,re.I):
    t=s[m.start():];b=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",t,re.I);e=t.find(b.group(1),b.end());result=t[:e+len(b.group(1))]+";"
  if not result:raise RuntimeError("No function: "+name)
  return result
 original=os.environ.get("PGDATABASE","postgres")
 run("CREATE DATABASE rebuy_receipt_probe");os.environ["PGDATABASE"]="rebuy_receipt_probe"
 try:
  schema=latest("atomic_table_rebuy_before_maintenance_announcement_gate")
  run((here/"fixture.sql").read_text()+latest("fn_club_members_ledger_writer")+(here/"rebuy-receipt-fixture.sql").read_text()+schema+latest("atomic_table_rebuy"))
  C="a0000000-0000-4000-8000-000000000001";I="a0000000-0000-4000-8000-000000000002";T="a0000000-0000-4000-8000-000000000003";U="a0000000-0000-4000-8000-000000000004";K="a0000000-0000-4000-8000-000000000005";J="a0000000-0000-4000-8000-000000000006"
  seed=f"INSERT INTO clubs(id) VALUES('{C}');INSERT INTO club_members(id,user_id,club_id) VALUES('{I}','{I}','{C}');INSERT INTO tables(id,club_id) VALUES('{T}','{C}'),('{U}','{C}');INSERT INTO table_seats(table_id,user_id,club_id,seat_number,stack) VALUES('{T}','{I}','{C}',1,0),('{U}','{I}','{C}',1,0);SELECT set_config('test.actor','{I}',true);"
  call=lambda table=T,amount="5",key=K:f"atomic_table_rebuy('{I}','{table}',{amount},{'NULL' if key is None else chr(39)+key+chr(39)})"
  names=["club_members","table_seats","transaction_idempotency_keys","table_pending_addons","wallet_transactions","chip_ledger","entry_purchase_idempotency_receipts"]
  state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {n} t)" for n in names)+")"
  context=f"SELECT set_config('app.money_path','outer',true),set_config('app.ledger_category','outer',true),set_config('app.ledger_counterparty','outer',true),set_config('app.ledger_counterparty_entity','{U}',true),set_config('app.ledger_tournament','{U}',true);"
  correct=f"current_setting('app.money_path')='outer' AND current_setting('app.ledger_category')='outer' AND current_setting('app.ledger_counterparty')='outer' AND current_setting('app.ledger_counterparty_entity')='{U}' AND current_setting('app.ledger_tournament')='{U}'"
  if os.environ.get("REBUY_ORIGINAL_PROOF"):
   run(Path(os.environ["REBUY_ORIGINAL_PROOF"]).read_text())
   run("BEGIN;"+seed+f"""DO $t$ DECLARE a numeric;b numeric;BEGIN a:={call()};b:={call(U)};
    IF a<>95 OR b<>95 OR (SELECT count(*) FROM table_pending_addons)<>1 THEN RAISE EXCEPTION 'Original scope bug not reproduced';END IF;
    END $t$;ROLLBACK;""")
   print("original: another table accepted the same rebuy key without a purchase",flush=True)
   run(latest("atomic_table_rebuy"))
  count=0
  run("BEGIN;"+seed+context+f"""DO $t$ DECLARE r numeric;s jsonb;BEGIN r:={call()};
   IF r<>95 OR (SELECT count(*) FROM chip_ledger)<>1 OR (SELECT count(*) FROM table_pending_addons)<>1
    OR (SELECT sum(stack) FROM table_seats)<>0 OR NOT ({correct}) OR EXISTS(SELECT 1 FROM chip_ledger WHERE tournament_id IS NOT NULL)
    THEN RAISE EXCEPTION 'Incorrect rebuy transaction or context';END IF;
   SELECT {state} INTO s;r:={call()};
   IF r<>95 OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Rebuy replay changed state';END IF;
   END $t$;ROLLBACK;""");count+=2
  for request in [call(U),call(amount="6")]:
   run("BEGIN;"+seed+f"SELECT {call()};"+f"""DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
    BEGIN PERFORM {request};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
    IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Wrong purchase admitted';END IF;
    END $t$;ROLLBACK;""");count+=1
  for amount in ["NULL","0","-1","5.001","'NaN'::numeric","'Infinity'::numeric","'-Infinity'::numeric"]:
   run("BEGIN;"+seed+f"""DO $t$ DECLARE caught boolean:=false;s jsonb;BEGIN SELECT {state} INTO s;
    BEGIN PERFORM {call(amount=amount)};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
    IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Invalid rebuy admitted';END IF;
    END $t$;ROLLBACK;""");count+=1
  for prefix,request,code in [(seed,call(key=None),"22023"),(seed+f"INSERT INTO transaction_idempotency_keys VALUES('{K}','{I}','atomic_table_rebuy',5,now());",call(),"55000")]:
   run("BEGIN;"+prefix+f"""DO $t$ DECLARE caught boolean:=false;s jsonb;BEGIN SELECT {state} INTO s;
    BEGIN PERFORM {request};EXCEPTION WHEN SQLSTATE '{code}' THEN caught:=true;END;
    IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Unproven purchase admitted';END IF;END $t$;ROLLBACK;""");count+=1
  for mutation in [f"DELETE FROM transaction_idempotency_keys WHERE key='{K}';",f"UPDATE table_seats SET left_at=now() WHERE table_id='{T}';",f"UPDATE club_members SET chip_balance=90 WHERE user_id='{I}';"]:
   run("BEGIN;"+seed+f"SELECT {call()};"+mutation+f"""DO $t$ DECLARE r numeric;s jsonb;BEGIN SELECT {state} INTO s;r:={call()};
    IF r<>95 OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Receipt was replaced by current state';END IF;END $t$;ROLLBACK;""");count+=1
  for table in ["club_members","chip_ledger","table_pending_addons","wallet_transactions","entry_purchase_idempotency_receipts"]:
   for fault in ["55P03","40P01","23514","23505","XX001"]:
    run("BEGIN;"+seed+context+f"""CREATE FUNCTION rebuy_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN {'IF TG_OP=\'INSERT\' THEN RETURN NEW;END IF;' if table=='entry_purchase_idempotency_receipts' else ''} RAISE EXCEPTION 'injected failure' USING ERRCODE='{fault}';END $f$;
     CREATE TRIGGER rebuy_fault BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION rebuy_fault();
     DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
      BEGIN PERFORM {call()};EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true;END;
      IF NOT caught OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Partial rebuy';END IF;
     END $t$;ROLLBACK;""");count+=1
  for mutation in ["UPDATE entry_purchase_idempotency_receipts SET request=request||jsonb_build_object('amount',6)","DELETE FROM entry_purchase_idempotency_receipts","UPDATE entry_purchase_idempotency_receipts SET completed_at=now()"]:
   run("BEGIN;"+seed+f"SELECT {call()};"+f"""DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
    BEGIN {mutation};EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true;END;
    IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Mutable receipt';END IF;END $t$;ROLLBACK;""");count+=1
  # Rollback cleans all fixture state, including immutable receipt rows.
  for conflict in [False,True]:
   params=dict(name="rebuy purchase "+("scope conflict" if conflict else "replay"),setup=seed,actor=f"SELECT set_config('test.actor','{I}',true);",first=call(),second=call(U) if conflict else call(),numericReceipt=True,
    verify="DO $t$ BEGIN IF (SELECT chip_balance FROM club_members)<>95 OR (SELECT count(*) FROM entry_purchase_idempotency_receipts)<>1 OR (SELECT count(*) FROM table_pending_addons)<>1 THEN RAISE EXCEPTION 'Concurrent rebuy changed state';END IF;END $t$;",
    cleanup="DROP SCHEMA public CASCADE;CREATE SCHEMA public;")
   if conflict:params["conflict"]=True
   # Each committed concurrency case uses a fresh database fixture.
   if conflict:
    run((here/"fixture.sql").read_text().replace("CREATE SCHEMA auth;","").replace("CREATE FUNCTION auth.uid()","CREATE OR REPLACE FUNCTION auth.uid()")+latest("fn_club_members_ledger_writer")+(here/"rebuy-receipt-fixture.sql").read_text()+schema+latest("atomic_table_rebuy"))
   r=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(params),text=True,capture_output=True)
   if r.returncode:raise RuntimeError(r.stderr)
   print(r.stdout.strip(),flush=True);count+=1
  print(f"TOTAL rebuy purchase receipts: {count} passing cases",flush=True)
 finally:
  os.environ["PGDATABASE"]=original;run("DROP DATABASE rebuy_receipt_probe")
