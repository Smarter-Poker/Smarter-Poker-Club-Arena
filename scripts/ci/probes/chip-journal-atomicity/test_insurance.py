"""Insurance bank routing, canonical cents, replay and journal atomicity."""
from pathlib import Path
import re,os,subprocess,json,hashlib
C="'50000000-0000-4000-8000-000000000001'"
T="'50000000-0000-4000-8000-000000000002'"
U="'50000000-0000-4000-8000-000000000003'"
P="'50000000-0000-4000-8000-000000000004'"
def verify_insurance(run):
 verify_private_projection(run)
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

def verify_private_projection(run):
 """Pure JSON cases only, inside the existing disposable query transaction."""
 root=Path(__file__).resolve().parents[4]
 source=root/'tests/sql/fixtures/g8-inert-accounting'
 pins={
  'predecessor0141/definition.sql':'88d036432ddf5e4471752fb2dffc28e5ee51c5a95da494357b3786e7c58efe96',
  'insurance0145/definition.sql':'d02b9708435e2fa754c98ae890bd33e992c633397432e08dd4d5910251f370d5',
  'insurance0145/cases.sql':'2afb465749df18ebc40a7f185cc26c2c5011697060bb3235d1391a99975f993e',
  'insurance0145/predecessor-regression.sql':'ddef2577a576a82f9df15ffbfced24e55b11cf0e4a348fcd3d2f12002ecc0bea',
 }
 texts={}
 for name,pin in pins.items():
  raw=(source/name).read_bytes()
  if hashlib.sha256(raw).hexdigest()!=pin: raise RuntimeError('Projection source drift: '+name)
  texts[name]=raw.decode('utf8')
 # Preserve the sealed rejected predecessor; PostgreSQL requires its CASE
 # expression to be parenthesized inside this PL/pgSQL IF comparison.
 predecessor='predecessor0141/definition.sql'
 original="IS DISTINCT FROM CASE WHEN r->>'kind'='ordinary' THEN 'insurance' ELSE r->>'kind' END THEN"
 corrected="IS DISTINCT FROM (CASE WHEN r->>'kind'='ordinary' THEN 'insurance' ELSE r->>'kind' END) THEN"
 if texts[predecessor].count(original)!=1: raise RuntimeError('Projection predecessor CASE boundary drift')
 texts[predecessor]=texts[predecessor].replace(original,corrected,1)
 bodies=[texts[name].split('$function$')[1] for name in ('predecessor0141/definition.sql','insurance0145/definition.sql')]
 # These are source literals for catalogue readback, never executable SQL from a caller.
 expected=json.dumps(dict(zip(('insurance_projection_0141','insurance_projection_0144'),bodies)))
 if '$ip_expected$' in expected: raise RuntimeError('Projection source delimiter collision')
 guard=(source/'projection-install-guard.sql').read_text()
 readback=(source/'projection-readback.sql').read_text().replace('__EXPECTED_BODIES__','$ip_expected$'+expected+'$ip_expected$::jsonb')
 finish=(source/'projection-rollback.sql').read_text()
 verify_projection_refusals(run,guard,readback,finish,texts)
 run(guard+'\n'+texts['predecessor0141/definition.sql']+'\n'+texts['insurance0145/definition.sql']+'\n'+readback+
     '\nSET LOCAL ROLE postgres;\n'+texts['insurance0145/cases.sql']+'\n'+texts['insurance0145/predecessor-regression.sql']+
     '\nRESET ROLE;\n'+finish)
 print('Pure insurance projection: 49 structural cases, predecessor refusal and isolated ACL/rollback checks passed; financial authority unqualified',flush=True)

def verify_projection_refusals(run,guard,readback,finish,texts):
 """Nine exact refusals through the original error/connection-close path."""
 if not os.environ.get('PGNODE'):
  raise RuntimeError('Projection refusal controls require the existing PGNODE query path')
 definitions=texts['predecessor0141/definition.sql']+'\n'+texts['insurance0145/definition.sql']
 snapshot="""SELECT
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_roles r) roles,
 (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_auth_members m) memberships,
 (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY oid),'[]'::jsonb) FROM pg_default_acl d) defaults"""
 # A fresh query must compare the original complete preimage, not a fabricated
 # expected catalogue. The test-owned baseline is never a financial baseline.
 boundary='CREATE TEMP TABLE ip_fixture_preimage ON COMMIT DROP AS'
 if guard.count(boundary)!=1: raise RuntimeError('Projection preflight boundary drift')
 # Reuse the exact validation-only prefix, including BEGIN and timeouts.
 # No baseline DDL may precede connection/role/default-ACL qualification.
 preflight=guard.split(boundary,1)[0]
 baseline_sql=preflight+"""DO $baseline$ BEGIN
 IF to_regclass('public.ip_projection_control_baseline') IS NOT NULL THEN
  RAISE EXCEPTION 'IP_CONTROL_BASELINE_EXISTS';
 END IF;
 END $baseline$;
 CREATE TABLE public.ip_projection_control_baseline AS """+snapshot+'; COMMIT;'
 def expect_refusal(name,sql,marker):
  try:
   run(sql)
  except RuntimeError as error:
   # Match the actual query.mjs code/message, not arbitrary SQL failure.
   if str(error).strip()!='P0001 '+marker:
    raise RuntimeError('Projection control '+name+' failed at an unexpected stage: '+str(error)) from error
  else:
   raise RuntimeError('Projection control '+name+' did not refuse')
 baseline_absent=preflight+"""DO $absent$ BEGIN
 IF to_regclass('public.ip_projection_control_baseline') IS NOT NULL THEN
  RAISE EXCEPTION 'IP_CONTROL_BASELINE_NOT_ABSENT';
 END IF;
 END $absent$; ROLLBACK;"""
 run(baseline_absent)
 if baseline_sql.count('BEGIN;')!=1: raise RuntimeError('Projection baseline transaction drift')
 # Exercise the actual baseline constructor before any baseline exists. DDL
 # moved ahead of its preflight must fail this exact-identity control.
 expect_refusal('connection',baseline_sql.replace('BEGIN;','BEGIN; SET LOCAL ROLE anon;',1),'IP_FIXTURE_CONNECTION')
 run(baseline_absent)
 print('Projection guard control connection: actual baseline constructor refused and fresh-call absence passed',flush=True)
 run(baseline_sql)
 fresh="""DO $fresh$ BEGIN
 IF EXISTS(SELECT FROM pg_namespace WHERE nspname='smarter_private')
 OR EXISTS(SELECT FROM pg_roles WHERE rolname IN ('postgres','authenticator','ip_projection_outsider'))
 OR (SELECT to_jsonb(b) FROM public.ip_projection_control_baseline b) IS DISTINCT FROM
 (SELECT to_jsonb(s) FROM ("""+snapshot+""") s) THEN
  RAISE EXCEPTION 'IP_CONTROL_FRESH_PREIMAGE';
 END IF;
 END $fresh$;"""
 def before_guard(fault):
  if guard.count('DO $guard$')!=1: raise RuntimeError('Projection guard insertion drift')
  return guard.replace('DO $guard$',fault+'\nDO $guard$',1)
 body_fault=texts['insurance0145/definition.sql'].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1).replace('DECLARE','-- isolated body-corruption control\nDECLARE',1)
 rollback_marker='ROLLBACK TO SAVEPOINT ip_private_install;'
 if finish.count(rollback_marker)!=1: raise RuntimeError('Projection rollback insertion drift')
 controls=[
  ('owned-schema',before_guard('CREATE SCHEMA smarter_private;'),'IP_FIXTURE_OWNED_NAMES_EXIST'),
  ('membership',before_guard('GRANT anon TO authenticated;'),'IP_FIXTURE_ROLE_DEFAULT_ACL_PREIMAGE'),
  ('default-acl',before_guard('ALTER DEFAULT PRIVILEGES FOR ROLE journal_test GRANT EXECUTE ON FUNCTIONS TO anon;'),'IP_FIXTURE_ROLE_DEFAULT_ACL_PREIMAGE'),
  ('function-body',guard+'\n'+definitions+'\n'+body_fault+'\n'+readback,'IP_FIXTURE_FUNCTION_READBACK: insurance_projection_0144'),
  ('unlisted-function-grant',guard+'\n'+definitions+'\nCREATE ROLE ip_projection_outsider NOLOGIN; GRANT EXECUTE ON FUNCTION smarter_private.insurance_projection_0144(jsonb,jsonb) TO ip_projection_outsider;\n'+readback,'IP_FIXTURE_FUNCTION_READBACK: insurance_projection_0144'),
  ('schema-access',guard+'\n'+definitions+'\nGRANT USAGE ON SCHEMA smarter_private TO anon;\n'+readback,'IP_FIXTURE_SCHEMA_READBACK'),
  ('rollback-contamination',guard+'\n'+definitions+'\n'+readback+'\n'+finish.replace(rollback_marker,rollback_marker+'\nCREATE ROLE ip_projection_outsider NOLOGIN;',1),'IP_FIXTURE_ROLLBACK_READBACK'),
  ('postinstall-connection-close',guard+'\n'+definitions+'\n'+readback+"\nDO $fault$ BEGIN RAISE EXCEPTION 'IP_CONTROL_POSTINSTALL_UNEXPECTED'; END $fault$;",'IP_CONTROL_POSTINSTALL_UNEXPECTED'),
 ]
 for name,sql,marker in controls:
  expect_refusal(name,sql,marker)
  # run(sql) returned only after query.mjs ended the failing client. A new
  # invocation must independently observe rollback, including unexpected error.
  run(fresh)
  print('Projection guard control '+name+': exact refusal and fresh-call rollback passed',flush=True)
 run('DROP TABLE public.ip_projection_control_baseline;')
