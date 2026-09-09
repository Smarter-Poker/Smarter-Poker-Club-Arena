"""Real BBJ contribution and residue allocator, with isolated journal fault injection."""
from pathlib import Path
import re,os,subprocess,json
P="'40000000-0000-4000-8000-000000000001'"
Q="'40000000-0000-4000-8000-000000000002'"
T="'40000000-0000-4000-8000-000000000003'"
C="'40000000-0000-4000-8000-000000000004'"
H="'40000000-0000-4000-8000-000000000005'"
def verify_bbj(run):
 here=Path(__file__).resolve().parent
 root=here.parents[3]
 def extract(source,name):
  for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",source,re.I):
   tail=source[m.start():];body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
   end=tail.find(body.group(1),body.end())
   yield tail[:end+len(body.group(1))]+";"
 allocator=list(extract((root/"supabase/migrations/20260904212347_phase_4_3_the_allocator_carries_its_rounding_residue.sql").read_text(),"fn_bbj_allocate"))[-1]
 contributions=[]
 for p in sorted((root/"supabase/migrations").glob("*.sql")):
  if p.name>="20260908045746":contributions.extend(extract(p.read_text(),"bbj_record_contribution"))
 if not contributions:raise RuntimeError("Missing BBJ contribution definition")
 ddl=here.joinpath("bbj-fixture.sql").read_text()+allocator+contributions[-1]
 setup=f"""
 INSERT INTO bbj_pools(id,club_id) VALUES({P},{C}),({Q},{C});
 CREATE TRIGGER bbj_probe_journal AFTER UPDATE ON bbj_pools FOR EACH ROW
 EXECUTE FUNCTION fn_ca_autoledger('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');
 """
 def call(hand=H,amount="0.25",pool=P,table=T,club=C,number="1",blind="2"):
  return f"bbj_record_contribution({pool},{hand},{table},{amount},0,0,0,{blind},{number},{club})"
 state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in ["bbj_pools","bbj_contributions","ca_bbj_alloc_state","chip_ledger"])+")"
 for hand in [H,"NULL"]:
  run("BEGIN;"+ddl+setup+f"""
  DO $check$ DECLARE first_state jsonb; BEGIN
   PERFORM set_config('app.ledger_category','outer',true);
   PERFORM set_config('app.ledger_counterparty','outer-account',true);
   PERFORM {call(hand)};
   IF current_setting('app.ledger_category')<>'outer' OR current_setting('app.ledger_counterparty')<>'outer-account'
   THEN RAISE EXCEPTION 'Nested context lost'; END IF;
   IF (SELECT total_contributed FROM bbj_pools WHERE id={P})<>0.25
    OR (SELECT main_balance+backup_balance+promo_balance FROM bbj_pools WHERE id={P})<>115.25
    OR (SELECT sum(amount) FROM chip_ledger)<>0.25 THEN RAISE EXCEPTION 'Contribution not conserved'; END IF;
   SELECT {state} INTO first_state;
   PERFORM {call(hand)};
   IF first_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Replay moved money or residue'; END IF;
  END $check$; ROLLBACK;""")
  for fault in ["55P03","40P01","23514","23505","XX001"]:
   run("BEGIN;"+ddl+setup+f"""
   DO $check$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
    SELECT {state} INTO before_state;
    PERFORM set_config('test.journal_sqlstate','{fault}',true);
    BEGIN PERFORM {call(hand)};
    EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true; END;
    IF NOT caught OR before_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Partial BBJ contribution'; END IF;
   END $check$; ROLLBACK;""")
  for second in [call(hand,amount="0.26"),call(hand,pool=Q),call(hand,club=Q),call(hand,blind="3"),
                 call("NULL" if hand==H else H)]:
   run("BEGIN;"+ddl+setup+f"""
   DO $check$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
    PERFORM {call(hand)}; SELECT {state} INTO before_state;
    BEGIN PERFORM {second};
    EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
    IF NOT caught OR before_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Changed payment identity admitted'; END IF;
   END $check$; ROLLBACK;""")
 for bad in ["NULL","0","-1","0.251","'NaN'::numeric","'Infinity'::numeric"]:
  run("BEGIN;"+ddl+setup+f"""
  DO $check$ DECLARE caught boolean:=false; BEGIN
   BEGIN PERFORM {call(amount=bad)}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
   IF NOT caught OR EXISTS(SELECT 1 FROM bbj_contributions) OR EXISTS(SELECT 1 FROM ca_bbj_alloc_state)
   THEN RAISE EXCEPTION 'Invalid amount admitted'; END IF;
  END $check$;ROLLBACK;""")

 # Actual pool resolver snapshot is pinned by the migration dependency hash.
 routing_ddl=ddl+here.joinpath("bbj-routing-fixture.sql").read_text()
 routing_ddl+=list(extract((root/"supabase/migrations/20260908051016_bbj_table_routing_and_receipt_are_one_transaction.sql").read_text(),"bbj_record_table_contribution"))[-1]
 U="'40000000-0000-4000-8000-000000000006'"
 post=f"bbj_record_table_contribution({T},{C},1,0.25,2,{H})"
 journal="CREATE TRIGGER bbj_probe_journal AFTER UPDATE ON bbj_pools FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');"
 for private,union in [(True,True),(False,True),(False,False)]:
  seed=f"INSERT INTO clubs(id,union_id) VALUES({C},{U if union else 'NULL'}); INSERT INTO tables(id,club_id,is_private) VALUES({T},{C},{str(private).lower()});"
  if union:seed+=f"INSERT INTO bbj_pools(id,union_id) VALUES({P},{U});"
  expected=f"pool_id={P}" if union and not private else f"pool_id IN (SELECT id FROM bbj_pools WHERE club_id={C} AND union_id IS NULL)"
  run("BEGIN;"+routing_ddl+seed+journal+f"""
  SELECT {post};
  DO $check$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM bbj_contributions WHERE {expected} AND amount=0.25)
    OR (SELECT sum(total_contributed) FROM bbj_pools)<>0.25
    OR (SELECT sum(amount) FROM chip_ledger)<>0.25
   THEN RAISE EXCEPTION 'Wrong BBJ destination or accounting'; END IF;
  END $check$;ROLLBACK;""")
 seed=f"INSERT INTO clubs(id,union_id) VALUES({C},{U}); INSERT INTO tables(id,club_id,is_private) VALUES({T},{C},false); INSERT INTO bbj_pools(id,union_id) VALUES({P},{U});"
 run("BEGIN;"+routing_ddl+seed+journal+f"""
 SELECT {post};
 UPDATE clubs SET union_id=NULL WHERE id={C};
 SELECT {post};
 DO $check$ BEGIN
  IF (SELECT count(*) FROM bbj_pools)<>1 OR (SELECT count(*) FROM bbj_contributions)<>1
   OR (SELECT total_contributed FROM bbj_pools)<>0.25
  THEN RAISE EXCEPTION 'Replay changed destination after membership update'; END IF;
 END $check$;ROLLBACK;""")
 seed=f"INSERT INTO clubs(id) VALUES({C}); INSERT INTO tables(id,club_id,is_private) VALUES({T},{C},true);"
 for fault in ["55P03","23514"]:
  run("BEGIN;"+routing_ddl+seed+journal+f"""
  DO $check$ DECLARE caught boolean:=false; BEGIN
   PERFORM set_config('test.journal_sqlstate','{fault}',true);
   BEGIN PERFORM {post}; EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true; END;
   IF NOT caught OR EXISTS(SELECT 1 FROM bbj_pools) OR EXISTS(SELECT 1 FROM bbj_contributions)
    OR EXISTS(SELECT 1 FROM ca_bbj_alloc_state) OR EXISTS(SELECT 1 FROM chip_ledger)
   THEN RAISE EXCEPTION 'Pool creation or payment escaped rollback'; END IF;
  END $check$;ROLLBACK;""")
 run("BEGIN;"+routing_ddl+seed+journal+f"""
 DO $check$ DECLARE caught boolean:=false; BEGIN
  BEGIN PERFORM bbj_record_table_contribution({T},{Q},1,0.25,2,{H});
  EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
  IF NOT caught OR EXISTS(SELECT 1 FROM bbj_pools) THEN RAISE EXCEPTION 'Wrong club admitted'; END IF;
 END $check$;ROLLBACK;""")
 print("TOTAL fixed BBJ routing: 7 passing cases",flush=True)

 print("TOTAL fixed BBJ sequential: 28 passing cases",flush=True)
 from test_bbj_accepted_replay import verify_accepted_replay
 verify_accepted_replay(run, ddl, setup, call, state, extract, root)
 if os.environ.get("PGNODE"):
  for hand in [H,"NULL"]:
   for conflict in [False,True]:
    payload=dict(name="BBJ "+("UUID" if hand==H else "table-hand")+(" conflict" if conflict else " replay"),
      setup=ddl+setup,actor="SELECT 1",first="to_jsonb("+call(hand)+")",
      second="to_jsonb("+call(hand,pool=Q if conflict else P)+")",conflict=conflict,compositeReceipt=True,
      verify=f"""DO $check$ BEGIN
       IF (SELECT count(*) FROM bbj_contributions)<>1 OR (SELECT sum(total_contributed) FROM bbj_pools)<>0.25
       OR (SELECT sum(amount) FROM chip_ledger)<>0.25 THEN RAISE EXCEPTION 'Concurrent BBJ double credit'; END IF;
      END $check$;""",
      cleanup="DROP TRIGGER bbj_probe_journal ON bbj_pools; DELETE FROM bbj_pools; DELETE FROM chip_ledger; DROP FUNCTION bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid); DROP FUNCTION fn_bbj_allocate(numeric,numeric,uuid); DROP TABLE bbj_contributions,ca_bbj_policy,ca_bbj_alloc_state; ALTER TABLE bbj_pools DROP COLUMN alloc_cum_amount,DROP COLUMN total_contributed,DROP COLUMN hands_contributed,DROP COLUMN updated_at;")
    if os.environ.get("BBJ_ORIGINAL_PROOF") and hand=="NULL" and not conflict:
     original=dict(payload)
     original["name"]="original BBJ NULL-hand double credit reproduction"
     original["setup"]=here.joinpath("bbj-fixture.sql").read_text()+allocator+Path(os.environ["BBJ_ORIGINAL_PROOF"]).read_text()+setup
     original["expectDistinctReceipts"]=True
     original["verify"]=payload["verify"].replace("<>1 OR","<>2 OR").replace("<>0.25","<>0.50")
     proof=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(original),text=True,capture_output=True)
     if proof.returncode:raise RuntimeError(proof.stderr)
     print(proof.stdout.strip(),flush=True)
    result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True)
    if result.returncode:raise RuntimeError(result.stderr)
    print(result.stdout.strip(),flush=True)
