"""Union calendar and disjoint-period guards, isolated from payouts."""
from pathlib import Path
import re
U="'30000000-0000-4000-8000-000000000001'"
def verify_union_periods(run):
 here=Path(__file__).resolve().parent
 definitions={}
 for path in sorted((here.parents[3]/"supabase/migrations").glob("*.sql")):
  if path.name<"20260908044150":continue
  source=path.read_text()
  for name in ["fn_union_weekly_rakeback_close"]:
   for match in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",source,re.I):
    tail=source[match.start():];body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
    end=tail.find(body.group(1),body.end());definitions[name]=tail[:end+len(body.group(1))]+";"
 if len(definitions)!=1:raise RuntimeError("Union period declarations missing")
 ddl=here.joinpath("union-fixture.sql").read_text()+"\n"+"\n".join(definitions.values())
 setup=f"INSERT INTO unions VALUES({U}); INSERT INTO union_wallets(union_id,chip_balance,rake_wallet) VALUES({U},1000,1000);"
 for start,end,expected in [
 ("2026-08-10 00:00Z","2026-08-17 00:00Z","period_not_closed_union_weeks"),
 ("2026-08-10 07:00Z","2026-08-17 00:00Z","period_not_closed_union_weeks"),
 ("2099-01-05 08:00Z","2099-01-12 08:00Z","period_not_closed_union_weeks"),
 ("-infinity","2026-08-17 07:00Z","bad_params")]:
  run("BEGIN;"+ddl+setup+f"""
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'{start}','{end}');
 IF receipt->>'error' IS DISTINCT FROM '{expected}' OR EXISTS(SELECT 1 FROM union_rakeback_log)
 OR EXISTS(SELECT 1 FROM ca_settlements) THEN RAISE EXCEPTION 'Invalid period admitted: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # A different ID range must not consume part of an already closed interval.
 run("BEGIN;"+ddl+setup+f"""
 INSERT INTO union_rakeback_log VALUES({U},'2026-08-10 07:00Z','2026-08-17 07:00Z',0,now());
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'2026-08-03 07:00Z','2026-08-17 07:00Z');
 IF receipt->>'error' IS DISTINCT FROM 'overlapping_closed_period'
 OR (SELECT count(*) FROM union_rakeback_log)<>1 OR (SELECT rake_wallet FROM union_wallets)<>1000
 THEN RAISE EXCEPTION 'Overlapping close admitted: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # Adjacent complete periods remain admissible. Empty basis deliberately avoids
 # changing the separately audited distribution logic in this calendar fixture.
 run("BEGIN;"+ddl+setup+f"""
 INSERT INTO union_rakeback_log VALUES({U},'2026-08-03 07:00Z','2026-08-10 07:00Z',0,now());
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z');
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT count(*) FROM union_rakeback_log)<>2
 THEN RAISE EXCEPTION 'Adjacent close refused: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # The former close_all loop now delegates to the single accounting coordinator.
 # Its UTC-floor, closed-week, exact-scope and DST behavior runs against the
 # actual coordinator in scripts/dev/test-weekly-accounting-coordinator.sh.
 # This suite retains the real R1 money door's invalid/overlap/adjacent guards.
 print("TOTAL fixed union period money-door cases: 6 passing",flush=True)

 import os,subprocess,json
 if os.environ.get("PGNODE"):
  payload=dict(name="overlapping union closes",setup=ddl+setup,actor="SELECT 1",
   first=f"fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z')",
   second=f"fn_union_weekly_rakeback_close({U},'2026-08-03 07:00Z','2026-08-17 07:00Z')",
   receiptError="overlapping_closed_period",cleanup="SELECT 1",
   verify="""DO $check$ BEGIN
   IF (SELECT count(*) FROM union_rakeback_log)<>1 OR (SELECT rake_wallet FROM union_wallets)<>1000
   THEN RAISE EXCEPTION 'Concurrent union close accepted overlapping coverage'; END IF;
   END $check$;""")
  result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True)
  if result.returncode:raise RuntimeError(result.stderr)
  print(result.stdout.strip(),flush=True)
