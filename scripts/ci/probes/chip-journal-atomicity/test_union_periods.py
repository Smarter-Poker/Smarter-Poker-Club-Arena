"""Union calendar and disjoint-period guards, isolated from payouts."""
from pathlib import Path
import re,functools,uuid,json,hashlib
U="'30000000-0000-4000-8000-000000000001'"
def verify_union_periods(run):
 parent_run=run
 database="union_period_"+uuid.uuid4().hex
 parent_run('CREATE DATABASE "'+database+'";')
 try:
  _verify_union_periods(functools.partial(parent_run,database=database),database)
 finally:
  parent_run('DROP DATABASE "'+database+'" WITH (FORCE);')

def _verify_union_periods(run,database):
 here=Path(__file__).resolve().parent
 definitions={}
 views={}
 admission_tables={}
 for path in sorted((here.parents[3]/"supabase/migrations").glob("*.sql")):
  if path.name<"20260908044150":continue
  source=path.read_text()
  for name in ['accounting_effective_cash_rake_sources','accounting_payable_earning_sources']:
   for match in re.finditer(r"CREATE(?: OR REPLACE)? VIEW public\."+name+r"\b.*?;",source,re.I|re.S):views[name]=match.group(0)
  for table_name in ["accounting_cash_atomic_contract_admissions","accounting_cash_funding_contract_admissions"]:
   for match in re.finditer(r"CREATE TABLE public\."+table_name+r"\s*\(.*?\n\);",source,re.I|re.S):admission_tables[table_name]=match.group(0)
  for name in ["fn_union_weekly_rakeback_close","fn_caller_is_engine","fn_accounting_union_earned_plan","fn_ca_launch_accounting_cutoff","fn_ca_launch_accounting_start","fn_ca_launch_accounting_accepts","fn_ca_launch_accounting_waived","fn_ca_launch_accounting_club_cutoffs"]:
   for match in re.finditer(r"CREATE(?: OR REPLACE)? FUNCTION public\."+name+r"\s*\(",source,re.I):
    tail=source[match.start():];body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
    end=tail.find(body.group(1),body.end());definitions[name]=tail[:end+len(body.group(1))]+";"
 if "fn_union_weekly_rakeback_close" not in definitions:raise RuntimeError("Union period declarations missing")
 bootstrap=here.parents[1]/"fixtures/launch-reset/original-bootstrap.sql"
 ddl=bootstrap.read_text()
 expected=json.loads(bootstrap.with_name("fixture-hashes.json").read_text())[bootstrap.name]
 if hashlib.sha256(ddl.encode()).hexdigest()!=expected:raise RuntimeError("Original union dependency fixture fingerprint changed")
 # Roles are cluster-wide: earlier core cases already created the three browser
 # roles, while this fixture uses a fresh DATABASE in that same isolated cluster.
 # Keep the qualified bytes checked above; normalize only bare role declarations
 # for fixture setup, refusing unexpected existing attributes without altering them.
 for role in ('anon','authenticated','service_role','ca_ledger_refusal_recorder','supabase_admin'):
  declaration='CREATE ROLE '+role+';'
  if ddl.count(declaration)!=1:raise RuntimeError('Original fixture role declaration changed: '+role)
  guard="""DO $fixture_role$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='FIXTURE_ROLE_NAME') THEN CREATE ROLE FIXTURE_ROLE_NAME; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='FIXTURE_ROLE_NAME' AND
    (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolinherit))
  THEN RAISE EXCEPTION 'Unexpected isolated fixture role attributes: FIXTURE_ROLE_NAME'; END IF;
 END $fixture_role$;""".replace('FIXTURE_ROLE_NAME',role)
  ddl=ddl.replace(declaration,guard,1)
 if "fn_ca_launch_accounting_cutoff" in definitions:
  candidate=next(path for path in sorted((here.parents[3]/"supabase/migrations").glob("*.sql"),reverse=True) if "CREATE TABLE public.ca_launch_accounting_boundaries" in path.read_text())
  table=re.search(r"CREATE TABLE public\.ca_launch_accounting_boundaries\s*\(.*?\n\);",candidate.read_text(),re.S)
  if table is None:raise RuntimeError("Original launch boundary table declaration missing")
  ddl+="\n"+table.group(0)
 # The latest payable view now admits immutable atomic-history resolutions.
 # Load its actual static relation dependencies before that same actual view;
 # an older view or an EXECUTE string is not its financial source contract.
 if 'accounting_effective_cash_rake_sources' in views.get('accounting_payable_earning_sources',''):
  if 'accounting_effective_cash_rake_sources'not in views:raise RuntimeError('Effective earning view missing')
  effective=views['accounting_effective_cash_rake_sources']
  for table_name in ['accounting_cash_atomic_contract_admissions','accounting_cash_funding_contract_admissions']:
   if table_name in effective:
    if table_name not in admission_tables:raise RuntimeError('Effective earning view dependency missing: '+table_name)
    ddl+='\n'+admission_tables[table_name]
  ddl+='\n'+effective
 ddl+="\n"+"\n".join(definitions.values())+"\n"+views['accounting_payable_earning_sources']
 # This isolated empty journal begins before the fixture calendar. No historical
 # week is falsely certified, and the real earned-source owner proves the empty basis.
 setup=f"INSERT INTO unions(id,name,slug,owner_id) VALUES({U},'Calendar Fixture','calendar-fixture','30000000-0000-4000-8000-000000000002'); INSERT INTO union_wallets(union_id,chip_balance,rake_wallet) VALUES({U},1000,1000); INSERT INTO accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-08-01 00:00Z');"
 for start,end,expected in [
 ("2026-08-10 00:00Z","2026-08-17 00:00Z","period_not_closed_union_weeks"),
 ("2026-08-10 07:00Z","2026-08-17 00:00Z","period_not_closed_union_weeks"),
 ("2099-01-05 08:00Z","2099-01-12 08:00Z","period_not_closed_union_weeks"),
 ("-infinity","2026-08-17 07:00Z","bad_params"),
 ("2026-08-03 07:00Z","2026-08-17 07:00Z","period_not_closed_union_weeks")]:
  run("BEGIN;"+ddl+setup+f"""
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'{start}','{end}');
 IF receipt->>'error' IS DISTINCT FROM '{expected}' OR EXISTS(SELECT 1 FROM union_rakeback_log)
 OR EXISTS(SELECT 1 FROM ca_settlements) THEN RAISE EXCEPTION 'Invalid period admitted: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # A legacy partial close must not consume any part of a valid complete week.
 # A two-week request is tested above as invalid before it reaches this guard.
 run("BEGIN;"+ddl+setup+f"""
 INSERT INTO union_rakeback_log(union_id,period_start,period_end,total_rakeback,executed_at) VALUES({U},'2026-08-10 07:00Z','2026-08-16 07:00Z',0,now());
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z');
 IF receipt->>'error' IS DISTINCT FROM 'overlapping_closed_period'
 OR (SELECT count(*) FROM union_rakeback_log)<>1 OR (SELECT rake_wallet FROM union_wallets)<>1000
 THEN RAISE EXCEPTION 'Overlapping close admitted: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # Adjacent complete periods remain admissible. Empty basis deliberately avoids
 # changing the separately audited distribution logic in this calendar fixture.
 run("BEGIN;"+ddl+setup+f"""
 INSERT INTO union_rakeback_log(union_id,period_start,period_end,total_rakeback,executed_at) VALUES({U},'2026-08-03 07:00Z','2026-08-10 07:00Z',0,now());
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z');
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT count(*) FROM union_rakeback_log)<>2
 THEN RAISE EXCEPTION 'Adjacent close refused: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 # The former close_all loop now delegates to the single accounting coordinator.
 # Its UTC-floor, closed-week, exact-scope and DST behavior runs against the
 # actual coordinator in scripts/dev/test-weekly-accounting-coordinator.sh.
 # This suite retains the real R1 money door's invalid/overlap/adjacent guards.
 # Current source dependencies must remain authoritative, not engine/cutoff stubs.
 run("BEGIN;"+ddl+setup+f"""
 SET LOCAL request.jwt.claim.role='authenticated';
 DO $check$ BEGIN
 BEGIN PERFORM fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z');
 RAISE EXCEPTION 'Non-engine caller admitted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END $check$; ROLLBACK;""")
 run("BEGIN;"+ddl+setup+f"""
 INSERT INTO ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at)
 VALUES('union',{U},gen_random_uuid(),'2026-08-17 07:00Z');
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:=fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z');
 IF receipt->>'waived' IS DISTINCT FROM 'true' OR receipt->>'paid' IS DISTINCT FROM 'false'
 OR EXISTS(SELECT 1 FROM union_rakeback_log) OR EXISTS(SELECT 1 FROM ca_settlements)
 OR (SELECT rake_wallet FROM union_wallets)<>1000 THEN RAISE EXCEPTION 'Launch waiver paid or booked old debt: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 print("TOTAL fixed union period money-door cases: 9 passing",flush=True)

 import os,subprocess
 if os.environ.get("PGNODE"):
  payload=dict(name="identical union closes",setup=ddl+setup,actor="SELECT 1",
   first=f"fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z')",
   second=f"fn_union_weekly_rakeback_close({U},'2026-08-10 07:00Z','2026-08-17 07:00Z')",
   receiptError="already_executed",cleanup="SELECT 1",
   verify="""DO $check$ BEGIN
   IF (SELECT count(*) FROM union_rakeback_log)<>1 OR (SELECT rake_wallet FROM union_wallets)<>1000
   THEN RAISE EXCEPTION 'Concurrent union close accepted duplicate coverage'; END IF;
   END $check$;""")
  result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True,env=dict(os.environ,PGDATABASE=database))
  if result.returncode:raise RuntimeError(result.stderr)
  print(result.stdout.strip(),flush=True)
