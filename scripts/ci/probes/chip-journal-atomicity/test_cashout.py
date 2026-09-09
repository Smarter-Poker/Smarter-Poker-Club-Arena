"""Cashout transaction bodies with real wallet writers and ledger enrichment."""
from pathlib import Path
import re, os, json, subprocess

CLUB="'10000000-0000-4000-8000-000000000001'"
PLAYER="'10000000-0000-4000-8000-000000000002'"
AGENT="'10000000-0000-4000-8000-000000000003'"
REQUEST="'10000000-0000-4000-8000-000000000004'"
ESCROW="'10000000-0000-4000-8000-000000000005'"
OP="'10000000-0000-4000-8000-000000000006'"
OTHER="'10000000-0000-4000-8000-000000000007'"
TABLES=["clubs","club_members","agents","cashout_requests","chip_escrow","chip_transactions","chip_ledger","notifications"]
STATE="jsonb_build_array("+",".join(f"(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in TABLES)+")"

def verify_cashout(run):
 here=Path(__file__).resolve().parent
 root=here.parents[3]
 definitions={}
 for path in sorted((root/"supabase/migrations").glob("*.sql")):
  if path.name<"20260908035339": continue
  source=path.read_text()
  for name in ["fn_cashout_request","fn_cashout_approve","fn_cashout_release"]:
   for match in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",source,re.I):
    tail=source[match.start():]
    body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
    end=tail.find(body.group(1),body.end())
    definitions[name]=tail[:end+len(body.group(1))]+";"
 if len(definitions)!=3: raise RuntimeError("Cashout function declarations missing")
 run(here.joinpath("cashout-fixture.sql").read_text()+"\n"+"\n".join(definitions.values()))
 base=f"""
 INSERT INTO clubs(id,owner_id) VALUES({CLUB},{AGENT});
 INSERT INTO agents(club_id,user_id) VALUES({CLUB},{AGENT});
 """
 triggers="""
 CREATE TRIGGER cash_player AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
 CREATE TRIGGER cash_player_birth AFTER INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_balance=player_wallet');
 CREATE TRIGGER cash_agent AFTER UPDATE OF agent_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet');
 """
 cases={}
 for name in ["request","approve","deny","cancel","refund_missing_member"]:
  actor=PLAYER if name in ["request","cancel","refund_missing_member"] else AGENT
  setup=base
  if name!="refund_missing_member":
   balance=100 if name=="request" else 75
   setup+=f"INSERT INTO club_members(club_id,user_id,agent_id,chip_balance) VALUES({CLUB},{PLAYER},{AGENT},{balance});"
  if name!="request":
   setup+=f"INSERT INTO cashout_requests(id,club_id,player_id,agent_id,amount,status) VALUES({REQUEST},{CLUB},{PLAYER},{AGENT},25,'pending');"
   setup+=f"INSERT INTO chip_escrow(id,cashout_request_id,player_id,amount,club_id) VALUES({ESCROW},{REQUEST},{PLAYER},25,{CLUB});"
  setup+=triggers+f"SELECT set_config('test.actor',{actor},true);"
  operation=(f"fn_cashout_request({CLUB},25,null,{OP})" if name=="request" else
             f"fn_cashout_approve({REQUEST},null,{OP})" if name=="approve" else f"fn_cashout_release({REQUEST},null,{OP})")
  cases[name]=(setup,operation)
 passed=0
 for name,(setup,operation) in cases.items():
  for stage in ["journal","receipt"]:
   for code in ["55P03","40P01","23514","23505","XX001"]:
    run("BEGIN;"+setup+f"""
 DO $check$
 DECLARE before_state jsonb; after_state jsonb; caught boolean:=false; st text;
 BEGIN
 SELECT {STATE} INTO before_state;
 PERFORM set_config('test.{stage}_sqlstate','{code}',true);
 BEGIN PERFORM {operation};
 EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
 IF st<>'{code}' THEN RAISE EXCEPTION 'Unexpected %: %',st,SQLERRM; END IF;
 caught:=true;
 END;
 SELECT {STATE} INTO after_state;
 IF NOT caught THEN RAISE EXCEPTION 'Failure was hidden'; END IF;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Partial cashout commit'; END IF;
 END $check$; ROLLBACK;""")
    passed+=1
  expected_wallet=75 if name in ["request","approve"] else 25 if name=="refund_missing_member" else 100
  expected_agent=25 if name=="approve" else 0
  expected_held=25 if name=="request" else 0
  from_type="player_wallet" if name=="request" else "escrow"
  to_type="escrow" if name=="request" else "agent_wallet" if name=="approve" else "player_wallet"
  source=PLAYER if name=="request" else ESCROW
  target="(SELECT id FROM chip_escrow)" if name=="request" else AGENT if name=="approve" else PLAYER
  category="escrow_hold" if name=="request" else "escrow_release"
  run("BEGIN;"+setup+f"""
 DO $check$
 DECLARE receipt jsonb; replay jsonb; first_state jsonb; again_state jsonb;
 BEGIN
 PERFORM set_config('app.ledger_category','adjustment',true);
 PERFORM set_config('app.ledger_counterparty','settlement_suspense',true);
 PERFORM set_config('app.ledger_counterparty_entity',{OTHER},true);
 PERFORM set_config('app.ledger_idempotency_key','outer-operation',true);
 receipt:={operation};
 IF receipt->>'success'<>'true' OR receipt->>'replayed'<>'false' THEN RAISE EXCEPTION 'Wrong receipt %',receipt; END IF;
 IF (SELECT chip_balance FROM club_members)<>{expected_wallet}
 OR (SELECT agent_wallet_balance FROM agents)<>{expected_agent}
 OR (SELECT coalesce(sum(amount),0) FROM chip_escrow WHERE released_at IS NULL)<>{expected_held}
 THEN RAISE EXCEPTION 'Wrong successful balances'; END IF;
 IF (SELECT count(*) FROM chip_ledger)<>1 OR NOT EXISTS(
 SELECT 1 FROM chip_ledger WHERE from_type='{from_type}' AND to_type='{to_type}'
 AND from_entity_id={source} AND to_entity_id={target} AND amount=25 AND category='{category}'
 AND idempotency_key='cashout:'||(SELECT id::text FROM cashout_requests)||':{("hold" if name=="request" else "release")}')
 THEN RAISE EXCEPTION 'Wrong escrow journal'; END IF;
 IF current_setting('app.ledger_category')<>'adjustment'
 OR current_setting('app.ledger_counterparty')<>'settlement_suspense'
 OR current_setting('app.ledger_counterparty_entity')<>{OTHER}
 OR current_setting('app.ledger_idempotency_key')<>'outer-operation'
 THEN RAISE EXCEPTION 'Caller ledger context leaked'; END IF;
 SELECT {STATE} INTO first_state;
 replay:={operation};
 IF replay->>'success'<>'true' OR replay->>'replayed'<>'true' THEN RAISE EXCEPTION 'Wrong replay %',replay; END IF;
 SELECT {STATE} INTO again_state;
 IF first_state IS DISTINCT FROM again_state THEN RAISE EXCEPTION 'Replay moved funds'; END IF;
 END $check$; ROLLBACK;""")
  passed+=1
  mismatch=operation.replace(",25,null",",26,null") if name=="request" else operation.replace(REQUEST,OTHER)
  run("BEGIN;"+setup+f"""
 DO $check$ DECLARE caught boolean:=false; first_state jsonb; again_state jsonb;
 BEGIN
 PERFORM {operation};
 SELECT {STATE} INTO first_state;
 BEGIN PERFORM {mismatch}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Operation accepted a different payload'; END IF;
 SELECT {STATE} INTO again_state;
 IF first_state IS DISTINCT FROM again_state THEN RAISE EXCEPTION 'Conflict changed money'; END IF;
 END $check$; ROLLBACK;""")
  passed+=1
  print(f"fixed: cashout {name}: 10 rollback, receipt/replay/context, payload binding passed",flush=True)
 print(f"TOTAL fixed cashout: {passed} passing cases",flush=True)

 if os.environ.get("PGNODE"):
  cleanup="DROP TRIGGER IF EXISTS cash_player ON club_members; DROP TRIGGER IF EXISTS cash_player_birth ON club_members; DROP TRIGGER IF EXISTS cash_agent ON agents; TRUNCATE "+",".join(TABLES)+";"
  for name in ["request","approve","deny"]:
   setup,operation=cases[name]
   verify=f"""DO $check$ BEGIN
   IF (SELECT count(*) FROM chip_transactions)<>1 OR (SELECT count(*) FROM chip_ledger)<>1
   THEN RAISE EXCEPTION 'Concurrent replay duplicated accounting'; END IF;
   IF (SELECT coalesce(sum(chip_balance),0) FROM club_members)
    +(SELECT coalesce(sum(agent_wallet_balance),0) FROM agents)
    +(SELECT coalesce(sum(amount),0) FROM chip_escrow WHERE released_at IS NULL)<>100
   THEN RAISE EXCEPTION 'Concurrent replay changed supply'; END IF;
   END $check$;"""
   actor=PLAYER if name=="request" else AGENT
   payload=dict(name=name,setup=setup,actor=f"SELECT set_config('test.actor',{actor},true)",
    first=operation,second=operation,conflict=False,verify=verify,cleanup=cleanup)
   result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True)
   if result.returncode: raise RuntimeError(result.stderr)
   print(result.stdout.strip(),flush=True)
  # Two different players' refunds collide on one agent operation key.
  # This is the path whose old inner exception handler committed both refunds.
  setup,operation=cases["deny"]
  second_request="'10000000-0000-4000-8000-000000000008'"
  setup=setup.replace(triggers,"")
  setup+=f"INSERT INTO club_members(club_id,user_id,agent_id,chip_balance) VALUES({CLUB},{OTHER},{AGENT},75);"
  setup+=f"INSERT INTO cashout_requests(id,club_id,player_id,agent_id,amount,status) VALUES({second_request},{CLUB},{OTHER},{AGENT},25,'pending');"
  setup+=f"INSERT INTO chip_escrow(cashout_request_id,player_id,amount,club_id) VALUES({second_request},{OTHER},25,{CLUB});"+triggers
  verify=f"""DO $check$ BEGIN
   IF (SELECT chip_balance FROM club_members WHERE user_id={OTHER})<>75
    OR (SELECT status FROM cashout_requests WHERE id={second_request})<>'pending'
    OR (SELECT count(*) FROM chip_transactions)<>1
    OR (SELECT count(*) FROM chip_ledger)<>1
   THEN RAISE EXCEPTION 'Conflicting refund partially committed'; END IF;
   END $check$;"""
  payload=dict(name="conflicting refunds",setup=setup,actor=f"SELECT set_config('test.actor',{AGENT},true)",
   first=operation,second=operation.replace(REQUEST,second_request),conflict=True,verify=verify,cleanup=cleanup)
  result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(payload),text=True,capture_output=True)
  if result.returncode: raise RuntimeError(result.stderr)
  print(result.stdout.strip(),flush=True)
