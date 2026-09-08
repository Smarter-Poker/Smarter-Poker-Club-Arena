
"""Ticket account identity, legacy compatibility and rollback of every release stage."""
import os,json,re,subprocess
from pathlib import Path
def verify_tickets(run):
 if not os.environ.get("PGNODE"):raise RuntimeError("Ticket probes require isolated PGNODE")
 here=Path(__file__).resolve().parent;root=here.parents[3]
 def latest(name):
  bodies=[]
  for p in sorted((root/"supabase/migrations").glob("*.sql")):
   if p.name<"20260908024909":continue
   s=p.read_text()
   for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\."+name+r"\s*\(",s,re.I):
    t=s[m.start():];b=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",t,re.I);e=t.find(b.group(1),b.end())
    bodies.append(t[:e+len(b.group(1))]+";")
  if not bodies:raise RuntimeError("No current body: "+name)
  return bodies[-1]
 original=os.environ.get("PGDATABASE","postgres")
 run("CREATE DATABASE ticket_identity_probe");os.environ["PGDATABASE"]="ticket_identity_probe"
 try:
  setup=(here/"fixture.sql").read_text()+latest("fn_club_members_ledger_writer")+(here/"ticket-fixture.sql").read_text()
  for name in ["fn_issue_tournament_ticket_phase2_core_20260831","fn_cancel_tournament_ticket","fn_redeem_tournament_ticket"]:setup+=latest(name)
  run(setup)
  C="80000000-0000-4000-8000-000000000001";I="80000000-0000-4000-8000-000000000002";H="80000000-0000-4000-8000-000000000003";X="80000000-0000-4000-8000-000000000004"
  seed=f"INSERT INTO clubs(id) VALUES('{C}');INSERT INTO club_members(id,user_id,club_id) VALUES('{I}','{I}','{C}'),('{H}','{H}','{C}');"
  actor=lambda who:f"SELECT set_config('test.actor','{who}',false);"
  issue=f"fn_issue_tournament_ticket_phase2_core_20260831('{C}','{H}',5,NULL,'ticket-probe')"
  release=lambda action:f"fn_{action}_tournament_ticket((SELECT id FROM tournament_tickets LIMIT 1))"
  names=["club_members","tournament_tickets","chip_transactions","chip_ledger","wallet_transactions"]
  state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in names)+")"
  count=0
  for action,tables in [("issue",["chip_ledger","tournament_tickets","chip_transactions"]),("cancel",["chip_ledger","tournament_tickets","chip_transactions"]),("redeem",["chip_ledger","tournament_tickets","chip_transactions","wallet_transactions"])]:
   for table in tables:
    for fault in ["55P03","40P01","23514","23505","XX001"]:
     prefix=seed+actor(I)
     if action!="issue":prefix+=f"SELECT {issue};"+actor(I if action=="cancel" else H)
     trigger=f"""CREATE FUNCTION ticket_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'injected ticket failure' USING ERRCODE='{fault}';END $fault$;
      CREATE TRIGGER ticket_fault BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION ticket_fault();"""
     call=issue if action=="issue" else release(action)
     run("BEGIN;"+prefix+trigger+f"""
      DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN
       SELECT {state} INTO s;
       BEGIN PERFORM {call};EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true;END;
       IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Partial ticket movement';END IF;
      END $t$;ROLLBACK;""");count+=1
  context=f"SELECT set_config('app.ledger_category','outside',true),set_config('app.ledger_counterparty','outside',true),set_config('app.ledger_counterparty_entity','{X}',true),set_config('app.ledger_tournament','{X}',true);"
  for action in ["cancel","redeem"]:
   run("BEGIN;"+seed+actor(I)+context+f"""
    DO $t$ DECLARE r jsonb;v_ticket uuid;s jsonb;BEGIN
     r:={issue};v_ticket:=(r->>'ticket_id')::uuid;
     IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT to_entity_id FROM chip_ledger WHERE category='ticket_issue') IS DISTINCT FROM v_ticket
      OR current_setting('app.ledger_category')<>'outside' OR current_setting('app.ledger_tournament')<>'{X}'
      THEN RAISE EXCEPTION 'Ticket issue identity or context incorrect';END IF;
     SELECT {state} INTO s;r:={issue};
     IF r->>'replayed' IS DISTINCT FROM 'true' OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Issue replay changed state';END IF;
     PERFORM set_config('test.actor','{I if action=="cancel" else H}',false);
     r:={release(action)};
     IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(chip_balance) FROM club_members)<>200
      OR (SELECT count(*) FROM chip_ledger WHERE from_type='escrow' AND from_entity_id=v_ticket)<>1
      OR EXISTS(SELECT 1 FROM chip_ledger WHERE tournament_id IS NOT NULL)
      OR current_setting('app.ledger_category')<>'outside' OR current_setting('app.ledger_counterparty_entity')<>'{X}'
      THEN RAISE EXCEPTION 'Ticket release did not close the same account';END IF;
     SELECT {state} INTO s;r:={release(action)};
     IF r->>'replayed' IS DISTINCT FROM 'true' OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Release replay changed state';END IF;
    END $t$;ROLLBACK;""");count+=4
   run("BEGIN;"+seed+actor(I)+f"SELECT {issue};"+"""
    UPDATE chip_transactions SET metadata=metadata-'escrow_entity_id';
    UPDATE chip_ledger SET to_entity_id=NULL WHERE category='ticket_issue';
   """+actor(I if action=="cancel" else H)+f"""
    DO $t$ DECLARE r jsonb;BEGIN r:={release(action)};
     IF r->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM chip_ledger WHERE from_type='escrow' AND from_entity_id IS NULL)
      THEN RAISE EXCEPTION 'Legacy escrow identity changed';END IF;
    END $t$;ROLLBACK;""");count+=1
  for action in ["cancel","redeem"]:
   run("BEGIN;"+seed+actor(I)+f"SELECT {issue};"+f"UPDATE chip_transactions SET metadata=metadata||jsonb_build_object('escrow_entity_id','{X}');"+actor(I if action=="cancel" else H)+f"""
    DO $t$ DECLARE s jsonb;caught boolean:=false;BEGIN SELECT {state} INTO s;
     BEGIN PERFORM {release(action)};EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true;END;
     IF NOT caught OR s IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Mismatched escrow receipt admitted';END IF;
    END $t$;ROLLBACK;""");count+=1
  for action in ["cancel","redeem"]:
   prefix=seed+actor(I)+f"SELECT {issue};UPDATE club_members SET status='inactive' WHERE user_id='{I if action=='cancel' else H}';"
   run("BEGIN;"+prefix+actor(I if action=="cancel" else H)+context+f"""
    DO $t$ DECLARE r jsonb;s jsonb;BEGIN SELECT {state} INTO s;r:={release(action)};
     IF r->>'success' IS DISTINCT FROM 'false' OR s IS DISTINCT FROM {state}
       OR current_setting('app.ledger_category')<>'outside' THEN RAISE EXCEPTION 'Failed release changed state or leaked context';END IF;
    END $t$;ROLLBACK;""");count+=1
  for first,second in [("cancel","cancel"),("redeem","redeem"),("cancel","redeem")]:
   params=dict(name="ticket "+first+"/"+second,setup=seed+actor(I)+f"SELECT {issue};",
    actor=actor(I if first=="cancel" else H),secondActor=actor(I if second=="cancel" else H),
    first=release(first),second=release(second),ticketReceipt=True,
    verify="""DO $t$ BEGIN
     IF (SELECT sum(chip_balance) FROM club_members)<>200
      OR (SELECT count(*) FROM chip_ledger WHERE from_type='escrow')<>1
      OR (SELECT count(*) FROM chip_ledger WHERE to_type='escrow')<>1
      OR (SELECT count(*) FROM tournament_tickets WHERE status<>'issued')<>1
     THEN RAISE EXCEPTION 'Concurrent ticket release changed conservation';END IF;
    END $t$;""",
    cleanup="TRUNCATE "+",".join(names+["clubs"])+" CASCADE")
   if first!=second:params["receiptError"]="Ticket Already Cancelled"
   result=subprocess.run([os.environ["PGNODE"],str(here/"test_transaction_concurrency.mjs")],input=json.dumps(params),text=True,capture_output=True)
   if result.returncode:raise RuntimeError(result.stderr)
   print(result.stdout.strip(),flush=True);count+=1
  print(f"TOTAL ticket escrow identity: {count} passing cases",flush=True)
 finally:
  os.environ["PGDATABASE"]=original;run("DROP DATABASE ticket_identity_probe")
