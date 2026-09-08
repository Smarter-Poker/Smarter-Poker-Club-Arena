"""Real agent send/claim bodies must scope ledger state and roll back every write."""
import os,re
from pathlib import Path
def verify_agent_context(run):
 here=Path(__file__).resolve().parent;root=here.parents[3]
 def latest(name):
  result=None
  for p in sorted((root/"supabase/migrations").glob("*.sql")):
   s=p.read_text()
   for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",s,re.I):
    t=s[m.start():];b=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",t,re.I)
    if not b:continue
    e=t.find(b.group(1),b.end());result=t[:e+len(b.group(1))]+";"
  if not result:raise RuntimeError("No function: "+name)
  return result
 original=os.environ.get("PGDATABASE","postgres")
 run("CREATE DATABASE agent_context_probe");os.environ["PGDATABASE"]="agent_context_probe"
 try:
  sql=(here/"fixture.sql").read_text()
  for n in ["fn_club_members_ledger_writer","fn_ca_autoledger","fn_ca_post_leg"]:sql+=latest(n)
  sql+=(here/"agent-context-fixture.sql").read_text()
  for n in ["fn_ca_declare_ledger","fn_agent_wallet_send_core_20260830","fn_agent_wallet_claim_back_phase2_core_20260831"]:sql+=latest(n)
  run(sql)
  C="90000000-0000-4000-8000-000000000001";I="90000000-0000-4000-8000-000000000002";H="90000000-0000-4000-8000-000000000003";X="90000000-0000-4000-8000-000000000004";O="90000000-0000-4000-8000-000000000005";Q="90000000-0000-4000-8000-000000000006"
  keys=["category","counterparty","counterparty_entity","tournament","settlement","idempotency_key","correlation","autoskip_agents"]
  values=["outside","outside",X,X,X,"outside",X,"1"]
  context="".join(f"SELECT set_config('app.ledger_{k}','{v}',true);" for k,v in zip(keys,values))
  correct=" AND ".join(f"current_setting('app.ledger_{k}',true)='{v}'" for k,v in zip(keys,values))
  state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {n} t)" for n in ["club_members","agents","chip_transactions","chip_ledger"])+")"
  count=0
  for dest in ["player_wallet","agent_wallet"]:
   seed=f"INSERT INTO clubs(id) VALUES('{C}');INSERT INTO club_members(id,user_id,club_id,role) VALUES('{I}','{I}','{C}','owner'),('{H}','{H}','{C}','{'player' if dest=='player_wallet' else 'agent'}');INSERT INTO agents(club_id,user_id,agent_wallet_balance) VALUES('{C}','{I}',2),('{C}','{H}',20);SELECT set_config('test.actor','{I}',true);"
   send=f"fn_agent_wallet_send_core_20260830('{C}','{H}',5,'{dest}',NULL,'{O}')"
   claim=f"fn_agent_wallet_claim_back_phase2_core_20260831('{C}',(SELECT id FROM chip_transactions WHERE transaction_type='agent_wallet_send'),NULL,NULL,'{Q}')"
   run("BEGIN;"+seed+context+f"""
    DO $t$ DECLARE r jsonb;s jsonb;BEGIN
     r:={send};
     IF r->>'success' IS DISTINCT FROM 'true' OR NOT ({correct}) THEN RAISE EXCEPTION 'Agent send leaks ledger context';END IF;
     IF EXISTS(SELECT 1 FROM chip_ledger WHERE tournament_id IS NOT NULL) OR (SELECT count(*) FROM chip_ledger)<>2
      OR (SELECT credit_used FROM agents WHERE user_id='{I}')<>3 THEN RAISE EXCEPTION 'Incorrect send accounting';END IF;
     SELECT {state} INTO s;r:={send};
     IF r->>'replayed' IS DISTINCT FROM 'true' OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Send replay changed state';END IF;
     r:={claim};
     IF r->>'success' IS DISTINCT FROM 'true' OR NOT ({correct}) THEN RAISE EXCEPTION 'Agent claim leaks ledger context';END IF;
     IF (SELECT agent_wallet_balance FROM agents WHERE user_id='{I}')<>2
      OR (SELECT credit_used FROM agents WHERE user_id='{I}')<>0 OR (SELECT count(*) FROM chip_ledger)<>4
      OR EXISTS(SELECT 1 FROM chip_ledger WHERE tournament_id IS NOT NULL) THEN RAISE EXCEPTION 'Incorrect claim accounting';END IF;
     SELECT {state} INTO s;r:={claim};
     IF r->>'replayed' IS DISTINCT FROM 'true' OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Claim replay changed state';END IF;
    END $t$;ROLLBACK;""");count+=6
   for action,call in [("send",send),("claim",claim)]:
    for table in ["agents","chip_ledger","chip_transactions"]+(["club_members"] if dest=="player_wallet" else []):
     for fault in ["55P03","40P01","23514","23505","XX001"]:
      prefix=seed+(f"SELECT {send};" if action=="claim" else "")+context
      trigger=f"""CREATE FUNCTION agent_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'injected failure' USING ERRCODE='{fault}';END $fault$;
       CREATE TRIGGER agent_fault BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION agent_fault();"""
      run("BEGIN;"+prefix+trigger+f"""
       DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
        BEGIN PERFORM {call};EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true;END;
        IF NOT caught OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Partial agent operation or leaked context';END IF;
       END $t$;ROLLBACK;""");count+=1
  run("ALTER TABLE agents ADD COLUMN status text DEFAULT 'active'; CREATE FUNCTION fn_club_bank_role(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT role FROM club_members WHERE club_id=$1 AND user_id=$2 $$;")
  run(Path(os.environ["SELF_STAKE_ORIGINAL"]).read_text() if os.environ.get("SELF_STAKE_ORIGINAL") else latest("fn_agent_wallet_self_stake"))
  stake_seed=f"INSERT INTO clubs(id) VALUES('{C}');INSERT INTO club_members(id,user_id,club_id,role) VALUES('{I}','{I}','{C}','agent');INSERT INTO agents(club_id,user_id,agent_wallet_balance) VALUES('{C}','{I}',100);SELECT set_config('test.actor','{I}',true);"
  stake=lambda amount="5",key=O:f"fn_agent_wallet_self_stake('{C}',{amount},NULL,{'NULL' if key is None else chr(39)+key+chr(39)})"
  run("BEGIN;"+stake_seed+context+f"""DO $t$ DECLARE r jsonb;s jsonb;BEGIN
   r:={stake()};
   IF r->>'success' IS DISTINCT FROM 'true' OR NOT ({correct}) THEN RAISE EXCEPTION 'Self-stake leaks ledger context';END IF;
   IF (SELECT agent_wallet_balance FROM agents)<>95 OR (SELECT chip_balance FROM club_members)<>105
    OR (SELECT count(*) FROM chip_ledger)<>1 OR EXISTS(SELECT 1 FROM chip_ledger WHERE tournament_id IS NOT NULL) THEN RAISE EXCEPTION 'Incorrect self-stake accounting';END IF;
   SELECT {state} INTO s;r:={stake()};
   IF r->>'replayed' IS DISTINCT FROM 'true' OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Self-stake replay changed state';END IF;
   END $t$;ROLLBACK;""")
  stake_count=2
  run("BEGIN;"+stake_seed.replace(",100);",",2);")+context+f"""DO $t$ DECLARE r jsonb;s jsonb;BEGIN SELECT {state} INTO s;
   r:={stake()};IF r->>'success' IS DISTINCT FROM 'false' OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Refused self-stake changed state or context';END IF;
   END $t$;ROLLBACK;""");stake_count+=1
  for table in ["agents","club_members","chip_ledger","chip_transactions"]:
   for fault in ["55P03","40P01","23514","23505","XX001"]:
    run("BEGIN;"+stake_seed+context+f"""CREATE FUNCTION stake_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='{fault}';END $f$;
     CREATE TRIGGER stake_fault BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION stake_fault();
     DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
      BEGIN PERFORM {stake()};EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true;END;
      IF NOT caught OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Partial self-stake or leaked context';END IF;
     END $t$;ROLLBACK;""");stake_count+=1
  for amount in ["NULL","0","-1","5.001","'NaN'::numeric","'Infinity'::numeric","'-Infinity'::numeric"]:
   run("BEGIN;"+stake_seed+context+f"""DO $t$ DECLARE r jsonb;s jsonb;BEGIN SELECT {state} INTO s;r:={stake(amount)};
    IF r->>'success' IS DISTINCT FROM 'false' OR s IS DISTINCT FROM {state} OR NOT ({correct}) THEN RAISE EXCEPTION 'Invalid self-stake changed state';END IF;END $t$;ROLLBACK;""");stake_count+=1
  print(f"TOTAL self-stake ledger context: {stake_count} passing cases",flush=True)
  print(f"TOTAL agent ledger context: {count} passing cases",flush=True)
 finally:
  os.environ["PGDATABASE"]=original;run("DROP DATABASE agent_context_probe")
