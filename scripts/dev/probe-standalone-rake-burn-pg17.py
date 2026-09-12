#!/usr/bin/env python3
"""Isolated PG17 rake destination tests. No network or dependency installation.

Uses captured installed functions and real journal/register/escrow bodies.
Synthetic schema and attribution isolate routing; this is not full-engine or
production certification. Every temporary cluster is stopped and removed.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BINDIR = Path(os.environ.get("PG17_BINDIR", "/opt/homebrew/opt/postgresql@17/bin"))
PROBES = ROOT / "scripts/ci/probes"
MIGRATION = ROOT / "supabase/migrations/20260912010000_standalone_club_rake_is_burned.sql"
C = "71000000-0000-4000-8000-000000000001"
T = "71000000-0000-4000-8000-000000000002"
H = "71000000-0000-4000-8000-000000000003"
U = "71000000-0000-4000-8000-000000000004"
E = "71000000-0000-4000-8000-000000000005"

DDL = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
ALTER TABLE chip_ledger ADD PRIMARY KEY(id);
ALTER TABLE chip_ledger ADD actor_service text, ADD db_role text;
ALTER TABLE clubs ADD is_union boolean DEFAULT false;
ALTER TABLE tournaments ADD club_id uuid, ADD name text, ADD current_players integer DEFAULT 2;
CREATE TABLE profiles(id uuid PRIMARY KEY,username text,full_name text);
CREATE TABLE unions(id uuid PRIMARY KEY,name text);
CREATE TABLE ca_mint_policy(id integer,per_operation_cap_chips numeric,rolling_24h_cap_chips numeric);
CREATE TABLE ca_mint_ledger(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),op_id text UNIQUE,action text,asset text,
 holder_type text,holder_id uuid,holder_label text,amount numeric,
 balance_before numeric,balance_after numeric,supply_after numeric,reason text,
 performed_by uuid,performed_by_label text,db_role text,chip_ledger_id uuid UNIQUE REFERENCES chip_ledger(id),
 created_at timestamptz DEFAULT now());
CREATE TABLE tournament_escrow(
 tournament_id uuid PRIMARY KEY,enforced boolean DEFAULT true,
 gross_in numeric DEFAULT 0,fee_entries_in numeric DEFAULT 0,satellite_fee_in numeric DEFAULT 0,
 bounty_in numeric DEFAULT 0,overlay_in numeric DEFAULT 0,satellite_in numeric DEFAULT 0,
 prize_out numeric DEFAULT 0,bounty_out numeric DEFAULT 0,fee_out numeric DEFAULT 0,
 refund_prize numeric DEFAULT 0,refund_bounty numeric DEFAULT 0,refund_fee numeric DEFAULT 0,
 reserve_out numeric DEFAULT 0,reserve_in numeric DEFAULT 0,
 prize_balance numeric DEFAULT 0,bounty_balance numeric DEFAULT 0,fee_balance numeric DEFAULT 0,
 opened_from text,updated_at timestamptz DEFAULT now());
CREATE TABLE tournament_terminal_settlements(tournament_id uuid PRIMARY KEY);
CREATE TABLE tournament_rake_settlements(
 tournament_id uuid PRIMARY KEY,club_id uuid,amount numeric,union_id uuid,destination text,
 source text,settled_at timestamptz,attributed_at timestamptz,attributed_users integer,
 attribution_error text);
CREATE TABLE financial_alerts(severity text,source text,message text,context jsonb);
-- Attribution is deliberately isolated. Its internal behavior is not certified here.
CREATE FUNCTION fn_attribute_tournament_rake(uuid) RETURNS jsonb LANGUAGE sql AS
 $$SELECT '{"ok":true,"attributed_users":2,"members":2}'::jsonb$$;
CREATE FUNCTION test_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',label; END IF; END; $$;
"""
TRIGGERS = """
CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered AFTER INSERT ON chip_ledger
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.from_type IN ('system_mint','system_burn','issuance_reserve','chip_retirement')
 OR NEW.to_type IN ('system_mint','system_burn','issuance_reserve','chip_retirement'))
 EXECUTE FUNCTION fn_ca_issuance_leg_is_registered();
CREATE TRIGGER test_escrow AFTER INSERT OR UPDATE ON tournament_rake_settlements
 FOR EACH ROW EXECUTE FUNCTION fn_ca_escrow_on_rake_settlement();
CREATE TRIGGER test_union_journal AFTER INSERT OR UPDATE ON union_wallets
 FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('rake_wallet=union_wallet');
CREATE TRIGGER test_club_journal AFTER UPDATE ON clubs
 FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury');
CREATE FUNCTION test_register_fault() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF coalesce(current_setting('test.register_failure',true),'')='1' THEN
   RAISE EXCEPTION 'injected register failure' USING ERRCODE='23514';
 END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER test_register_failure BEFORE INSERT ON ca_mint_ledger
 FOR EACH ROW EXECUTE FUNCTION test_register_fault();
"""
STATE_TABLES = ["clubs", "club_wallets", "club_wallet_transactions", "union_wallets",
               "union_wallet_transactions", "rake_records", "rake_distribution_legs",
               "chip_ledger", "ca_mint_ledger", "tournament_rake_settlements", "tournament_escrow"]
STATE = "jsonb_build_array(" + ",".join(
    f"(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM {t} x)"
    for t in STATE_TABLES) + ")"
SEED = f"""
INSERT INTO clubs(id,name) VALUES('{C}','Synthetic rake club');
INSERT INTO tables(id,club_id,is_private) VALUES('{T}','{C}',true);
INSERT INTO club_wallets(club_id) VALUES('{C}');
INSERT INTO bbj_pools(id,club_id) VALUES('{T}','{C}');
INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES('{T}','{H}',1,100);
"""
EVENT = f"""
INSERT INTO tournaments(id,club_id,name,status) VALUES('{E}','{C}','Synthetic event','COMPLETING');
INSERT INTO tournament_escrow(tournament_id,gross_in,fee_entries_in,prize_balance,fee_balance)
 VALUES('{E}',100,5,95,5);
INSERT INTO rake_records(id,club_id,tournament_id,rake_amount,is_tournament)
 VALUES('{E}','{C}','{E}',5,true);
"""
def cash(hand=H, amount=5, bbj=0):
    ident = "NULL" if hand is None else f"'{hand}'"
    return f"atomic_distribute_rake('{T}','{C}',{ident},1,{amount},{bbj},100,2,NULL,NULL,NULL,'DEALT_EQUAL')"

def tournament():
    return f"fn_settle_tournament_rake('{E}','native-rake-burn-probe')"

checks = []
with tempfile.TemporaryDirectory(prefix="ca-rake-burn-", dir="/tmp") as temporary:
    base = Path(temporary)
    socket = base / "socket"
    socket.mkdir()
    port = "55447"
    subprocess.run([str(BINDIR/"initdb"), "-D", str(base/"data"), "-U", "postgres",
                    "-A", "trust", "--no-locale", "-E", "UTF8"], check=True, capture_output=True)
    started = False
    try:
        subprocess.run([str(BINDIR/"pg_ctl"), "-D", str(base/"data"), "-l", str(base/"postgres.log"),
                        "-o", f"-k {socket} -p {port} -c listen_addresses=''",
                        "-w", "start"], check=True, capture_output=True)
        started = True
        args = [str(BINDIR/"psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", str(socket),
                "-p", port, "-U", "postgres", "-d", "postgres"]
        def run(sql):
            r = subprocess.run(args, input=sql, text=True, capture_output=True)
            if r.returncode:
                raise AssertionError(r.stderr)
            return r.stdout
        def case(name, sql, event=False):
            run("BEGIN;\n" + SEED + (EVENT if event else "") + sql + "\nROLLBACK;")
            checks.append(name)
            print("PASS " + name, flush=True)
        run((PROBES/"chip-journal-atomicity/fixture.sql").read_text() + DDL
            + (PROBES/"standalone-rake-burn-preimage.sql").read_text()
            + (PROBES/"standalone-rake-burn-terminal-preimage.sql").read_text() + TRIGGERS)
        case("reproduce cash treasury credit", f"""
 SELECT * FROM {cash()};
 SELECT test_assert((SELECT chip_treasury=105 FROM clubs),'old credit');
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM chip_ledger WHERE to_type='chip_retirement'),'old no burn');
 """)
        case("reproduce tournament treasury credit", f"""
 SELECT {tournament()};
 SELECT test_assert((SELECT chip_treasury=105 FROM clubs),'old event credit');
 """, True)
        run("ALTER TABLE chip_ledger DISABLE TRIGGER zz_ca_issuance_leg_is_registered")
        refused = subprocess.run(args, input=MIGRATION.read_text(), text=True, capture_output=True)
        if refused.returncode == 0 or "requires the enabled native supply register" not in refused.stderr:
            raise AssertionError("migration admitted a disabled supply register")
        run("ALTER TABLE chip_ledger ENABLE TRIGGER zz_ca_issuance_leg_is_registered")
        checks.append("migration refuses a disabled supply register")
        run(MIGRATION.read_text())
        # Execute the exact installed terminal destination expressions, including
        # their original union and historical treasury alternatives. The full
        # outer terminal transaction remains a separate acceptance requirement.
        for function, record_names in [
            ("fn_ca_tournament_terminal_receipt", ["v_r"]),
            ("fn_complete_tournament_terminal_pre_seat_guard", ["v_prior_rake", "v_rake"]),
        ]:
            installed = subprocess.run(args + ["-A", "-t"], input=
                f"SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='{function}'",
                text=True, capture_output=True, check=True).stdout
            import re
            for record_name in record_names:
                predicate = re.search(re.escape(record_name) + r"\.destination NOT LIKE 'union:%'\s+AND "
                    + re.escape(record_name) + r"\.destination NOT LIKE 'club_treasury:%'\s+AND "
                    + re.escape(record_name) + r"\.destination NOT LIKE 'chip_retirement:%'", installed)
                if not predicate:
                    raise AssertionError("installed terminal predicate not found")
                for destination, rejected in [("union:"+U,False),("club_treasury:"+C,False),
                    ("chip_retirement:"+C,False),("pending",True),("unknown:"+C,True)]:
                    run(f"""DO $test$ DECLARE {record_name} record; BEGIN
 SELECT '{destination}'::text AS destination INTO {record_name};
 IF ({predicate.group(0)}) IS DISTINCT FROM {str(rejected).lower()} THEN
 RAISE EXCEPTION 'terminal destination predicate failed'; END IF; END; $test$;""")
                checks.append(function+":"+record_name+" five native destination checks")
        for hand in [H, None]:
            case("standalone cash burn " + ("UUID" if hand else "table-number"), f"""
 UPDATE table_seats SET stack=94.75;
 UPDATE bbj_pools SET main_balance=100.25;
 SELECT * FROM {cash(hand, bbj=0.25)};
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert((SELECT chip_treasury=100 AND total_rake=5 FROM clubs),'club balance untouched');
 SELECT test_assert((SELECT chip_balance=0 AND period_rake_collected=5
   AND period_bbj_contribution=0.25 FROM club_wallets),'counters only');
 SELECT test_assert((SELECT count(*)=1 AND sum(amount)=5 FROM chip_ledger
   WHERE to_type='chip_retirement' AND from_type='table_stack'),'exact rake burn');
 SELECT test_assert((SELECT count(*)=1 AND sum(amount)=5 AND bool_and(action='burn')
   FROM ca_mint_ledger),'one registered retirement');
 SELECT test_assert((SELECT main_balance=100.25 FROM bbj_pools),'jackpot retained');
 SELECT test_assert((SELECT sum(stack) FROM table_seats)+(SELECT chip_treasury FROM clubs)
   +(SELECT main_balance+backup_balance+promo_balance FROM bbj_pools)=310,'supply fell by five');
 DO $test$ DECLARE before_state jsonb; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM {cash(hand, bbj=0.25)};
  IF before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'replay moved money'; END IF;
 END; $test$;
 """)
        for first_hand, second_hand in [(None,H),(H,None)]:
            case("history identity transition " + str(first_hand is None), f"""
 SELECT * FROM {cash(first_hand)};
 SET CONSTRAINTS ALL IMMEDIATE;
 DO $test$ DECLARE before_state jsonb; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM {cash(second_hand)};
  IF before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'history transition duplicated rake'; END IF;
 END; $test$;
 SELECT test_assert((SELECT count(*)=1 FROM rake_records),'one logical hand record');
 SELECT test_assert((SELECT sum(amount)=5 AND count(*)=1 FROM ca_mint_ledger),'one logical hand burn');
 """)
        case("burn receipt reports no spendable credit", f"""
 SELECT test_assert((SELECT spendable_route='chip_retirement' AND spendable_amount=0
  AND club_net_credit=0 FROM {cash()}),'no spendable credit');
 """)
        case("standalone event burns while releasing fee escrow", f"""
 SELECT test_assert({tournament()}->>'destination'='chip_retirement:{C}','event burn destination');
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert((SELECT chip_treasury=100 FROM clubs),'event no bank credit');
 SELECT test_assert((SELECT fee_balance=0 AND fee_out=5 AND prize_balance=95 FROM tournament_escrow),'fee removed once');
 SELECT test_assert((SELECT sum(amount)=5 AND count(*)=1 FROM ca_mint_ledger WHERE action='burn'),'event mint register');
 SELECT test_assert((SELECT from_type='prize_liability' AND from_entity_id='{E}'
  AND tournament_id='{E}' FROM chip_ledger),'event source identity');
 DO $test$ DECLARE before_state jsonb; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM {tournament()};
  IF before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'event replay moved money'; END IF;
 END; $test$;
 """, True)
        union = f"UPDATE clubs SET union_id='{U}'; UPDATE tables SET is_private=false,union_id='{U}';"
        for kind, operation in [("cash",cash()), ("tournament",tournament())]:
            case("union retained once " + kind, union + f"""
 SELECT * FROM {operation};
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert((SELECT rake_wallet=5 FROM union_wallets),'union rake retained');
 SELECT test_assert((SELECT count(*)=1 AND sum(amount)=5 FROM union_wallet_transactions),'union domain journal');
 SELECT test_assert((SELECT count(*)=1 AND sum(amount)=5 FROM chip_ledger WHERE to_type='union_wallet'),'union chip journal');
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM ca_mint_ledger),'union not burned');
 DO $test$ DECLARE before_state jsonb; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM {operation};
  IF before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'union replay changed money'; END IF;
 END; $test$;
 """, kind=="tournament")
        for kind, operation in [("cash",cash()), ("tournament",tournament())]:
            for fault in ["55P03","40P01","23514","23505","XX001"]:
                case(f"{kind} journal rollback {fault}", f"""
 DO $test$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM set_config('test.journal_sqlstate','{fault}',true);
  BEGIN PERFORM {operation}; EXCEPTION WHEN SQLSTATE '{fault}' THEN caught:=true; END;
  IF NOT caught OR before_state IS DISTINCT FROM {STATE} THEN
   RAISE EXCEPTION 'journal failure left partial money'; END IF;
 END; $test$;
 """, kind=="tournament")
            case(kind+" register failure rolls back settlement", f"""
 DO $test$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
  SELECT {STATE} INTO before_state;
  PERFORM set_config('test.register_failure','1',true);
  BEGIN
   PERFORM {operation};
   SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN caught:=true;
  END;
  IF NOT caught OR before_state IS DISTINCT FROM {STATE} THEN
   RAISE EXCEPTION 'register failure left partial money'; END IF;
 END; $test$;
 """, kind=="tournament")
        case("cash retry preserves settled union after club leaves", union + f"""
 SELECT * FROM {cash()}; UPDATE clubs SET union_id=NULL; UPDATE tables SET union_id=NULL;
 SELECT * FROM {cash()}; SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert((SELECT rake_wallet=5 FROM union_wallets),'union destination immutable');
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM ca_mint_ledger),'no later burn');
 """)
        case("cash retry preserves burn after club joins", f"""
 SELECT * FROM {cash()}; {union}
 SELECT * FROM {cash()}; SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM union_wallets),'no later union credit');
 SELECT test_assert((SELECT sum(amount)=5 FROM ca_mint_ledger),'no later burn');
 """)
        case("legacy cash treasury receipt is not reburned", f"""
 INSERT INTO rake_records(hand_id,table_id,club_id,rake_amount,bbj_contribution)
  VALUES('{H}','{T}','{C}',5,0);
 INSERT INTO rake_distribution_legs VALUES('{H}','chip_treasury','{C}',NULL,5);
 INSERT INTO rake_distribution_legs VALUES('{H}','club_accumulator','{C}',NULL,5);
 SELECT test_assert((SELECT spendable_route='club_chip_treasury' FROM {cash()}),'honest historical receipt');
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM chip_ledger),'old credit not burned or repaid');
 """)
        case("legacy tournament treasury receipt is not reburned", f"""
 INSERT INTO tournament_rake_settlements(tournament_id,club_id,amount,destination,settled_at)
 VALUES('{E}','{C}',5,'club_treasury:{C}',now());
 SELECT test_assert(({tournament()}->>'already_settled')::boolean,'old event receipt');
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT test_assert(NOT EXISTS(SELECT 1 FROM chip_ledger),'old event not reburned');
 """, True)
        case("changed rake replay fails without writing", f"""
 SELECT * FROM {cash()}; SET CONSTRAINTS ALL IMMEDIATE;
 DO $test$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
 SELECT {STATE} INTO before_state;
 BEGIN PERFORM {cash(amount=6)}; EXCEPTION WHEN invalid_parameter_value THEN caught:=true; END;
 IF NOT caught OR before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'changed replay admitted'; END IF;
 END; $test$;
 """)
        case("legacy credit door refuses all mutation", f"""
 DO $test$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
 SELECT {STATE} INTO before_state;
 BEGIN PERFORM credit_club_rake_to_treasury('{C}',5); EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 IF NOT caught OR before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'legacy credit admitted'; END IF;
 END; $test$;
 """)
        case("short event escrow refuses the entire burn", f"""
 UPDATE tournament_escrow SET fee_entries_in=4,fee_balance=4;
 DO $test$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
 SELECT {STATE} INTO before_state;
 BEGIN PERFORM {tournament()}; EXCEPTION WHEN SQLSTATE 'P0403' THEN caught:=true; END;
 IF NOT caught OR before_state IS DISTINCT FROM {STATE} THEN RAISE EXCEPTION 'underfunded burn admitted'; END IF;
 END; $test$;
 """,True)
        run(SEED)
        first = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        first.stdin.write(f"BEGIN; SELECT * FROM {cash()}; SELECT pg_sleep(0.5); COMMIT;")
        first.stdin.close()
        second = subprocess.run(args, input=f"SELECT * FROM {cash()};", text=True, capture_output=True)
        first.wait(timeout=20)
        if first.returncode or second.returncode:
            raise AssertionError(first.stderr.read()+second.stderr)
        run(f"""
 SELECT test_assert((SELECT sum(amount)=5 AND count(*)=1 FROM ca_mint_ledger),'concurrent one burn');
 SELECT test_assert((SELECT chip_treasury=100 FROM clubs),'concurrent no credit');
 """)
        checks.append("two concurrent sessions burn the same hand once")
    finally:
        if started:
            subprocess.run([str(BINDIR/"pg_ctl"), "-D", str(base/"data"), "-m", "immediate", "-w", "stop"],
                           check=True, capture_output=True)
        if (base/"data/postmaster.pid").exists():
            raise AssertionError("temporary postgres did not stop")
print(json.dumps({"passed": len(checks), "checks": checks, "cleanup": "cluster stopped and removed",
                  "production_verified": False, "full_engine_verified": False}))

