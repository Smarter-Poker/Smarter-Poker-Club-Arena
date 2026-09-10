"""Hand roster conservation and payload-bound receipts in real PostgreSQL."""
from pathlib import Path
import re
TABLE="'20000000-0000-4000-8000-000000000001'"
CLUB="'20000000-0000-4000-8000-000000000002'"
A="20000000-0000-4000-8000-000000000003"
B="20000000-0000-4000-8000-000000000004"
def payload(a=95,b=105,duplicate=False,reverse=False,mixed=False):
 import json
 rows=[dict(user_id=A,stack=a,stack_before=100),dict(user_id=B,stack=b,stack_before=100)]
 if duplicate: rows.insert(0,dict(rows[0]))
 if reverse: rows.reverse()
 if mixed: del rows[0]["stack_before"]
 return "'"+json.dumps(rows)+"'::jsonb"
def operation(stacks,rake=0,bbj=0,inflow=0):
 return f"fn_ca_settle_hand_stacks_absolute({TABLE},1,{stacks},{rake},{bbj},null,{inflow})"
SETUP=f"""
INSERT INTO clubs(id,asset) VALUES({CLUB},'chips');
INSERT INTO tables(id,club_id) VALUES({TABLE},{CLUB});
INSERT INTO table_seats(table_id,user_id,seat_number,stack,is_sitting_out) VALUES({TABLE},'{A}',1,100,false),({TABLE},'{B}',2,100,false);
"""
STATE="jsonb_build_array("+",".join(f"(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in ["table_seats","settlement_idempotency_keys","ca_settlements","ca_seat_stack_rebases"])+")"
def verify_hand(run, original=None):
 here=Path(__file__).resolve().parent
 if original:
  definition=Path(original).read_text()+";"
 else:
  definition=None
  for path in sorted((here.parents[3]/"supabase/migrations").glob("*.sql")):
   if path.name<"20260908042156":continue
   text=path.read_text()
   for match in re.finditer(r"CREATE OR REPLACE FUNCTION public\.fn_ca_settle_hand_stacks_absolute\s*\(",text,re.I):
    tail=text[match.start():]; body=re.search(r"\bAS\s+(\$[A-Za-z0-9_]*\$)",tail,re.I)
    end=tail.find(body.group(1),body.end()); definition=tail[:end+len(body.group(1))]+";"
  if not definition:raise RuntimeError("Authoritative hand function missing")
 ddl=here.joinpath("hand-fixture.sql").read_text()+definition+"""
ALTER FUNCTION fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric) OWNER TO postgres;
"""
 if original:
  run("BEGIN;"+ddl+SETUP+f"""
 DO $proof$ DECLARE receipt jsonb; BEGIN
 receipt:={operation(payload(a=95,b=110,duplicate=True))};
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(stack) FROM table_seats)<>205
 THEN RAISE EXCEPTION 'Original duplicate mint not reproduced: %',receipt; END IF;
 END $proof$; ROLLBACK;""")
  print("ORIGINAL DEFECT REPRODUCED: a duplicate player turns 200 chips into 205 while receipt says success",flush=True)
  return
 passed=0
 for tournament in [False,True]:
  event=(
   f"INSERT INTO tournaments(id,status,prize_pool_finalized) "
   f"VALUES('{CLUB.strip(chr(39))}','running',false);"
   f"INSERT INTO tournament_players(tournament_id,user_id,status,chips) VALUES"
   f"('{CLUB.strip(chr(39))}','{A}','playing',100),"
   f"('{CLUB.strip(chr(39))}','{B}','playing',100);"
   f"UPDATE tables SET tournament_id='{CLUB.strip(chr(39))}' WHERE id={TABLE};"
  ) if tournament else ""
  for name,stacks in [("duplicate",payload(a=95,b=110,duplicate=True)),("mixed",payload(mixed=True)),("missing_id","'[{}]'::jsonb"),("string_amount",f"""'[{{"user_id":"{A}","stack":"100"}}]'::jsonb""")]:
   run("BEGIN;"+ddl+SETUP+event+f"""
 DO $check$ DECLARE before_state jsonb; after_state jsonb; caught boolean:=false;
 BEGIN SELECT {STATE} INTO before_state;
 BEGIN PERFORM {operation(stacks)}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
 SELECT {STATE} INTO after_state;
 IF NOT caught OR before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Invalid roster changed accounting'; END IF;
 END $check$; ROLLBACK;""")
   passed+=1
  run("BEGIN;"+ddl+SETUP+event+f"""
 DO $check$ DECLARE receipt jsonb; first_state jsonb; again_state jsonb; caught boolean:=false;
 BEGIN
 receipt:={operation(payload())};
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(stack) FROM table_seats)<>200
 THEN RAISE EXCEPTION 'Valid hand failed: %',receipt; END IF;
 SELECT {STATE} INTO first_state;
 receipt:={operation(payload(reverse=True))};
 IF receipt->>'replay' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Reordered replay failed'; END IF;
 SELECT {STATE} INTO again_state;
 IF first_state IS DISTINCT FROM again_state THEN RAISE EXCEPTION 'Replay changed accounting'; END IF;
 BEGIN PERFORM {operation(payload(a=90,b=110))}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Changed payload reused receipt'; END IF;
 SELECT {STATE} INTO again_state;
 IF first_state IS DISTINCT FROM again_state THEN RAISE EXCEPTION 'Conflicting payload moved chips'; END IF;
 END $check$; ROLLBACK;""")
  passed+=3
 run("BEGIN;"+ddl+SETUP+f"""
 UPDATE table_seats SET stack=120 WHERE user_id='{A}';
 DO $check$ DECLARE receipt jsonb; BEGIN
 receipt:={operation(payload())};
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(stack) FROM table_seats)<>220
 OR (SELECT stack FROM table_seats WHERE user_id='{A}')<>115
 THEN RAISE EXCEPTION 'Existing additive credit was erased: %',receipt; END IF;
 END $check$; ROLLBACK;""")
 passed+=1
 run("BEGIN;"+ddl+SETUP+f"""
 DO $check$ DECLARE receipt jsonb; caught boolean:=false; BEGIN
 receipt:={operation(payload(a=90,b=107),rake=2,bbj=1)};
 IF receipt->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(stack) FROM table_seats)<>197
 THEN RAISE EXCEPTION 'Declared fees failed: %',receipt; END IF;
 BEGIN PERFORM {operation(payload(a=90,b=107),rake=3,bbj=0)}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Different fee payload reused receipt'; END IF;
 END $check$; ROLLBACK;""")
 passed+=2
 print(f"TOTAL fixed hand roster: {passed} passing cases",flush=True)
