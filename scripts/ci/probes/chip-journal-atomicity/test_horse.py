
"""Horse funding receipts bind the actor scope, amount and original operation."""
import json, os, subprocess
from pathlib import Path
def verify_horse(run):
 C="70000000-0000-4000-8000-000000000001";T="70000000-0000-4000-8000-000000000002"
 U="70000000-0000-4000-8000-000000000003";O="70000000-0000-4000-8000-000000000004"
 X="70000000-0000-4000-8000-000000000005"
 seed=f"INSERT INTO clubs(id) VALUES('{C}'); INSERT INTO tables(id,club_id) VALUES('{T}','{C}'),('{X}','{C}'); INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES('{T}','{U}',1,0);"
 def call(table=T,user=U,amount=5,op=O):return f"fn_horse_fund_from_treasury('{table}','{user}',{amount},'{op}')"
 # The public maintenance door owns an immutable response receipt in addition
 # to the money core's chip-ledger receipt.  Keep it in both state snapshots
 # and teardown: otherwise one committed concurrency case leaks a completed
 # receipt into the next case and turns the intended contention into an
 # immediate replay/conflict.
 names=["clubs","table_seats","chip_transactions","chip_ledger","cash_baselines","entry_purchase_idempotency_receipts"]
 state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in names)+")"
 count=0
 run("BEGIN;"+seed+f"""
 DO $t$ DECLARE r jsonb;s jsonb;BEGIN
 PERFORM set_config('app.ledger_autoskip_clubs','caller-context',true);
 r:={call()};
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'op_id' IS DISTINCT FROM '{O}'
  OR (r->>'new_stack')::numeric<>5 OR (SELECT chip_treasury FROM clubs WHERE id='{C}')<>95
  OR current_setting('app.ledger_autoskip_clubs')<>'caller-context' THEN RAISE EXCEPTION 'Funding receipt or context mismatch';END IF;
 SELECT {state} INTO s;
 r:={call()};
 IF r->>'replayed' IS DISTINCT FROM 'true' OR (r->>'new_stack')::numeric<>5 OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Funding replay changed state';END IF;
 END $t$;ROLLBACK;""");count+=2
 for changed in [call(table=X),call(user=X),call(amount=6)]:
  run("BEGIN;"+seed+f"""
   DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN
    PERFORM {call()};SELECT {state} INTO s;
    BEGIN PERFORM {changed};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
    IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Changed funding replay admitted';END IF;
   END $t$;ROLLBACK;""");count+=1
 for amount in ["'NaN'::numeric","'Infinity'::numeric","'-Infinity'::numeric","0","-1","0.001"]:
  run("BEGIN;"+seed+f"""
   DO $t$ DECLARE s jsonb;r jsonb;BEGIN SELECT {state} INTO s;r:={call(amount=amount)};
    IF r->>'success' IS DISTINCT FROM 'false' OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Invalid amount funded';END IF;
   END $t$;ROLLBACK;""");count+=1
 run("BEGIN;"+seed+f"SELECT {call()};"+"""
  CREATE OR REPLACE FUNCTION fn_actor_can_manage_club_treasury(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
 """+f"""DO $t$ DECLARE r jsonb;BEGIN r:={call()};IF r->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unauthorized replay accepted';END IF;END $t$;ROLLBACK;""");count+=1
 if os.environ.get("PGNODE"):
  here=Path(__file__).resolve().parent
  for conflict in [False,True]:
   params=dict(name="horse funding "+("conflict" if conflict else "replay"),setup=seed,actor="SELECT 1",
    first=call(),second=call(amount=6 if conflict else 5),conflict=conflict,fundingReceipt=True,
    verify=f"""DO $t$ BEGIN
     IF (SELECT stack FROM table_seats WHERE table_id='{T}' AND user_id='{U}')<>5
      OR (SELECT chip_treasury FROM clubs WHERE id='{C}')<>95
      OR (SELECT count(*) FROM chip_ledger WHERE idempotency_key='horse_fund:{O}')<>1
     THEN RAISE EXCEPTION 'Concurrent funding applied more than once';END IF;END $t$;""",
    cleanup="TRUNCATE "+",".join(names+["tables"])+" CASCADE")
   result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(params),text=True,capture_output=True)
   if result.returncode:raise RuntimeError(result.stderr)
   print(result.stdout.strip(),flush=True);count+=1
 print(f"TOTAL horse funding receipts: {count} passing cases",flush=True)
