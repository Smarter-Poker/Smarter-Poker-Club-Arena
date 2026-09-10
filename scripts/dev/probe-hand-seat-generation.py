#!/usr/bin/env python3
"""Real PG17 seat-generation regression; isolated fixture, no production.
Tests the stack writer and terminal roster effects. Does not certify the
outer hand commit, exact engine payloads or the full strict cutover.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "scripts/ci/probes/chip-journal-atomicity"
BINDIR = Path(os.environ.get("PG17_BINDIR", "/opt/homebrew/opt/postgresql@17/bin"))

def definition(source):
    match = re.search(r"CREATE OR REPLACE FUNCTION public\.fn_ca_settle_hand_stacks_absolute\s*\(.*?\$function\$", source, re.S | re.I)
    assert match, "Stack function declaration missing"
    end = source.index("$function$", match.end()) + len("$function$")
    return source[match.start():end] + ";"

original = definition((ROOT / "supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql").read_text())
migrations = list((ROOT / "supabase/migrations").glob("*_restore_exact_hand_generation_after_terminal_writer.sql"))
assert len(migrations) == 1, "Expected one authoritative generation restoration"
candidate = definition(migrations[0].read_text())
A = "20000000-0000-4000-8000-000000000003"
B = "20000000-0000-4000-8000-000000000004"
T = "20000000-0000-4000-8000-000000000001"
C = "20000000-0000-4000-8000-000000000002"
JOIN = "2026-09-09T10:00:00.123456+00:00"

def quote(s):
    return "'" + s.replace("'", "''") + "'"

def payload(a=95, b=105):
    return [dict(user_id=u, seat_id=u, seat_joined_at=JOIN, stack_before=100, stack=n)
            for u,n in [(A,a),(B,b)]]

def call(rows):
    return f"public.fn_ca_settle_hand_stacks_absolute('{T}',1,{quote(json.dumps(rows))}::jsonb,0,0,NULL,0)"

state = "jsonb_build_array(" + ",".join(
    f"(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM {t} x)"
    for t in ["table_seats","tournament_players","chip_ledger","club_members"]
) + ")"
with tempfile.TemporaryDirectory(prefix="ca-hand-generation-", dir="/tmp") as temporary:
    base = Path(temporary)
    socket = base / "socket"
    socket.mkdir()
    subprocess.run([str(BINDIR / "initdb"), "-D", str(base/"data"), "-U", "postgres", "-A", "trust", "--no-locale"], check=True, capture_output=True)
    subprocess.run([str(BINDIR/"pg_ctl"), "-D", str(base/"data"), "-l", str(base/"postgres.log"),
                    "-o", f"-k {socket} -p 55443 -c listen_addresses=''", "-w", "start"], check=True, capture_output=True)
    try:
        def run(statement):
            if os.environ.get("PGNODE"):
                env = dict(os.environ, PGHOST=str(socket), PGPORT="55443", PGUSER="postgres", PGDATABASE="postgres")
                args = [os.environ["PGNODE"], str(FIXTURE/"postgres-runtime/query.mjs")]
            else:
                env = os.environ.copy()
                args = [str(BINDIR/"psql"), "-X", "-v", "ON_ERROR_STOP=1", "-h", str(socket), "-p", "55443", "-U", "postgres", "-d", "postgres"]
            result = subprocess.run(args, input=statement, text=True, capture_output=True, env=env)
            if result.returncode:
                raise AssertionError(result.stderr)
        run((FIXTURE/"fixture.sql").read_text() + (FIXTURE/"hand-fixture.sql").read_text())
        setup = f"""
INSERT INTO tables(id,club_id) VALUES('{T}','{C}');
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at)
 VALUES('{A}','{T}','{A}',1,100,'{JOIN}'),('{B}','{T}','{B}',2,100,'{JOIN}');
"""
        count = 0
        for tournament in [False, True]:
            event = f"""
INSERT INTO tournaments(id,status,prize_pool_finalized) VALUES('{C}','running',false);
INSERT INTO tournament_players(tournament_id,user_id,status,chips)
 VALUES('{C}','{A}','playing',100),('{C}','{B}','playing',100);
UPDATE tables SET tournament_id='{C}' WHERE id='{T}';
""" if tournament else ""
            # Red proof: the actual overwritten writer applies the old hand to
            # the same row after joined_at has changed to a later occupancy.
            replacement = f"UPDATE table_seats SET joined_at=joined_at+interval '1 second' WHERE user_id='{A}';"
            run("BEGIN;" + original + setup + event + replacement + f"""
DO $test$ DECLARE result jsonb; BEGIN
 result := {call(payload())};
 IF result->>'success' IS DISTINCT FROM 'true' OR
 (SELECT stack FROM table_seats WHERE user_id='{A}') <> 95 THEN
 RAISE EXCEPTION 'Regression not reproduced: %',result; END IF;
END $test$; ROLLBACK;
""")
            count += 1
            cases = []
            cases.append(("same-row replacement", payload(), replacement))
            wrong = payload(); wrong[0]["seat_id"] = C
            cases.append(("different seat row", wrong, ""))
            mixed = payload(); mixed[0].pop("seat_id"); mixed[0].pop("seat_joined_at")
            cases.append(("mixed protocol", mixed, ""))
            partial = payload(); partial[0].pop("seat_joined_at")
            cases.append(("partial identity", partial, ""))
            for label, rows, mutation in cases:
                run("BEGIN;" + candidate + setup + event + mutation + f"""
DO $test$ DECLARE result jsonb; before_state jsonb; denied boolean:=false; BEGIN
 SELECT {state} INTO before_state;
 BEGIN
 result := {call(rows)};
 denied := result->>'success' IS DISTINCT FROM 'true';
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;
 END;
 IF NOT denied OR before_state IS DISTINCT FROM {state} THEN
 RAISE EXCEPTION 'Invalid generation mutated financial state: {label}: %',result; END IF;
END $test$; ROLLBACK;
""")
                count += 1
            run("BEGIN;" + candidate + setup + event + f"""
DO $test$ DECLARE result jsonb; first_state jsonb; BEGIN
 result := {call(payload())};
 IF result->>'success' IS DISTINCT FROM 'true' OR (SELECT sum(stack) FROM table_seats)<>200
 OR (SELECT stack FROM table_seats WHERE user_id='{A}')<>95 THEN
 RAISE EXCEPTION 'Exact generation failed: %',result; END IF;
 SELECT {state} INTO first_state;
 result := {call(list(reversed(payload())))};
 IF result->>'replay' IS DISTINCT FROM 'true' OR first_state IS DISTINCT FROM {state} THEN
 RAISE EXCEPTION 'Exact reordered replay changed financial state'; END IF;
END $test$; ROLLBACK;
""")
            count += 1
            if tournament:
                run("BEGIN;" + candidate + setup + event + f"""
DO $test$ DECLARE result jsonb; BEGIN
 result := {call(payload(0,200))};
 IF result->>'success' IS DISTINCT FROM 'true'
 OR (SELECT chips FROM tournament_players WHERE user_id='{A}')<>0
 OR (SELECT chips FROM tournament_players WHERE user_id='{B}')<>200
 OR NOT EXISTS(SELECT 1 FROM table_seats WHERE user_id='{A}' AND left_at IS NOT NULL AND stack=0)
 OR (result->>'tournament_zero_stack_seat_count')::integer<>1 THEN
 RAISE EXCEPTION 'Current terminal zero-stack behavior lost: %',result; END IF;
END $test$; ROLLBACK;
""")
                count += 1
        print(f"{count} real PostgreSQL checks passed, including two reproduced overwrite regressions; outer commit and engine remain unverified.")
    finally:
        subprocess.run([str(BINDIR/"pg_ctl"), "-D", str(base/"data"), "-m", "immediate", "-w", "stop"], check=True, capture_output=True)
