#!/usr/bin/env python3
"""Test actual ticket scope contracts in an owned, socket-only PostgreSQL 17.

The complete captured functions run. Financial prelock is an explicit sentinel:
this fixture proves admission scope, not funded entry or production authority.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
fixture = repo / "scripts/dev/fixtures/union-ticket-scope"
capture = json.loads((fixture / "captured-contracts.json").read_text())
migration = repo / "supabase/migrations/20260914114316_union_ticket_scope_matches_issued_awards.sql"
pg = Path(os.environ.get("POKER_AUDIT_PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
assert " 17." in subprocess.check_output([str(pg / "postgres"), "--version"], text=True)
root = Path(tempfile.mkdtemp(prefix="ca-union-ticket-scope-"))
socket = root / "socket"
socket.mkdir()
cluster = root / "cluster"
port = str(35000 + os.getpid() % 10000)
started = False
passed = []
T = "11111111-1111-4111-8111-111111111111"
S = "22222222-2222-4222-8222-222222222222"
U = "33333333-3333-4333-8333-333333333333"
H = "44444444-4444-4444-8444-444444444444"
C = "55555555-5555-4555-8555-555555555555"
O = "66666666-6666-4666-8666-666666666666"
K = "77777777-7777-4777-8777-777777777777"
P = "88888888-8888-4888-8888-888888888888"
L = "99999999-9999-4999-8999-999999999999"
E = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
key = f"tourney:{S}:satellite_ticket:place:1"
args = []


def command(cmd, **kwargs):
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=45, **kwargs)
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return result.stdout.strip()


def sql(body):
    return command(args, input=body)


def check(name):
    passed.append(name)
    print("PASS " + name, flush=True)


def selector(target=T):
    return json.loads(sql(f"SELECT fn_ca_find_tournament_entry_ticket_for('{target}','{U}');"))


def hints(target=T):
    return json.loads(sql(f"SELECT fn_horse_tournament_entry_ticket_hints('{target}');"))["holder_ids"]


def admission(target=T):
    return json.loads(sql(f"SELECT test_ticket_admission('{target}','{K}','{U}');"))


def seed(club=C, union=True, returned=False):
    tables = sorted({c["table"] for c in capture["columns"]})
    sql("TRUNCATE " + ",".join('public."' + t + '"' for t in tables) + ";")
    # All records are synthetic. Required financial issue facts match each other.
    ticket_source = T
    issue_from = T if returned else S
    issue_key = f"tourney:{T}:satellite-ticket-return:{E}" if returned else key + ":ticket_escrow"
    tx_key = issue_key if returned else key
    metadata = {
        "kind": "direct_satellite_entry_ticket", "ticket_id": K,
        "payout_id": P, "satellite_target_id": T, "user_id": U, "position": 1,
    }
    tx = {"ticket_id": K, "source_tournament_id": T, "source_satellite_id": S,
          "source_award_place": 1, "payout_id": P, "ledger_id": L,
          "idempotency_key": tx_key, "entitlement_id": E}
    union_sql = "'" + H + "'" if union else "NULL"
    host = H if union else club
    sql(f"""
    INSERT INTO profiles(id,is_horse,display_name) VALUES('{U}',true,'Test Horse');
    INSERT INTO tournaments(id,club_id,union_id,status,variant,max_players,buy_in_amount,
      buy_in_fee,bounty_amount,prize_pool_finalized,authorized_to_register,is_vip_only)
    VALUES('{T}','{host}',{union_sql},'REGISTERING','freezeout',200,90,10,0,false,false,false),
      ('{T2}','{host}',{union_sql},'REGISTERING','freezeout',200,90,10,0,false,false,false);
    INSERT INTO club_members(club_id,user_id,status)
      VALUES('{H}','{U}','active'),('{C}','{U}','active'),('{O}','{U}','active');
    INSERT INTO union_clubs(union_id,club_id) VALUES('{H}','{C}');
    INSERT INTO tournament_tickets(id,club_id,holder_id,value,status,redemption_mode,
      source_tournament_id,source_satellite_id,source_refund_entitlement_id,
      source_satellite_award_place,entry_prize,entry_bounty,entry_fee,created_at)
    VALUES('{K}','{club}','{U}',100,'issued','tournament_entry_only','{ticket_source}','{S}',
      {"'" + E + "'" if returned else "NULL"},{'NULL' if returned else '1'},90,0,10,now());
    INSERT INTO tournament_satellite_awards(tournament_id,place,user_id,delivery_kind,
      amount,payout_id,payout_source,idempotency_key,ticket_id)
      VALUES('{S}',1,'{U}','ticket',100,'{P}','satellite_ticket','{key}','{K}');
    INSERT INTO tournament_satellite_settlements(tournament_id,target_id,ticket_cost,target_buy_in,target_fee)
      VALUES('{S}','{T}',100,90,10);
    INSERT INTO tournament_payouts(id,tournament_id,user_id,"position",amount,source,idempotency_key)
      VALUES('{P}','{S}','{U}',1,100,'satellite_ticket','{key}');
    INSERT INTO chip_ledger(id,idempotency_key,from_type,from_entity_id,to_type,to_entity_id,
      club_id,amount,category,tournament_id,metadata)
      VALUES('{L}','{issue_key}','prize_liability','{issue_from}','escrow','{K}',
      '{club}',100,'ticket_issue','{S}','{json.dumps(metadata)}');
    INSERT INTO chip_transactions(id,transaction_type,club_id,from_user_id,to_user_id,amount,metadata)
      VALUES(gen_random_uuid(),'tournament_ticket_issue','{club}',NULL,'{U}',100,'{json.dumps(tx)}');
    """)
    if returned:
        sql(f"""INSERT INTO tournament_refund_entitlements(id,tournament_id,user_id,
        entitlement_kind,gross,refund_prize,refund_bounty,refund_fee,source_satellite_id)
        VALUES('{E}','{T}','{U}','tournament_ticket',100,90,0,10,'{S}');""")


def desired(which):
    if which == "selector":
        assert selector().get("ticket_id") == K, selector()
    elif which == "hints":
        assert U in hints(), hints()
    else:
        assert admission() == {"boundary": "unchanged_financial_prelock"}, admission()


def metadata():
    names = ",".join("'" + f["name"] + "'" for f in capture["functions"])
    return json.loads(sql(f"""SELECT jsonb_object_agg(proname,jsonb_build_array(oid,proowner,
      proacl::text,proconfig,prosecdef,provolatile,proparallel,proleakproof,proisstrict))
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN({names});"""))


def bodies():
    names = ",".join("'" + f["name"] + "'" for f in capture["functions"])
    return json.loads(sql(f"""SELECT jsonb_object_agg(proname,md5(prosrc)) FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname IN({names});"""))


try:
    share = Path(command([str(pg / "pg_config"), "--sharedir"]))
    if not (share / "postgres.bki").exists():
        share = pg.parent / "share/postgresql"
    command([str(pg / "initdb"), "-L", str(share), "-D", str(cluster), "-U", "postgres",
             "--auth=trust", "--no-locale", "-E", "UTF8"])
    command([str(pg / "pg_ctl"), "-D", str(cluster), "-l", str(root / "postgres.log"),
             "-o", f"-h '' -k '{socket}' -p {port}", "-w", "start"])
    started = True
    args = [str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
            "-h", str(socket), "-p", port, "-d", "postgres"]
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;")
    tables = {}
    for column in capture["columns"]:
        tables.setdefault(column["table"], []).append(
            '"' + column["column"] + '" ' + column["type"])
    for name, columns in tables.items():
        sql('CREATE TABLE public."' + name + '"(' + ",".join(columns) + ");")
    # Captured columns/types are exact; unrelated defaults/constraints/triggers
    # are deliberately absent. No financial mutation is allowed by this fixture.
    for f in capture["functions"]:
        sql(f["definition"])
        sql(f"REVOKE ALL ON FUNCTION public.{f['signature']} FROM PUBLIC,anon,authenticated,service_role;")
        if f["name"] == "fn_horse_tournament_entry_ticket_hints":
            sql(f"GRANT EXECUTE ON FUNCTION public.{f['signature']} TO service_role;")
        if f["name"] == "fn_tournament_club_for_user":
            sql(f"GRANT EXECUTE ON FUNCTION public.{f['signature']} TO authenticated,service_role;")
        if f["name"] == "fn_tournament_entry_split":
            sql(f"GRANT EXECUTE ON FUNCTION public.{f['signature']} TO PUBLIC,anon,authenticated,service_role;")
    sql("""
    CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid) RETURNS void
      LANGUAGE sql AS 'SELECT NULL::void';
    CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION fn_tournament_late_registration_open(uuid) RETURNS boolean
      LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION fn_tournament_entry_cap_reached(uuid) RETURNS boolean
      LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION is_club_admin(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION fn_ca_escrow_apply(uuid,text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'unchanged financial prelock' USING ERRCODE='P0999'; END $$;
    CREATE FUNCTION test_ticket_admission(t uuid,k uuid,u uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN RETURN fn_ca_register_for_tournament_with_ticket_for(t,k,u);
      EXCEPTION WHEN SQLSTATE 'P0999' THEN
        RETURN jsonb_build_object('boundary','unchanged_financial_prelock');
      WHEN SQLSTATE 'P0404' THEN RETURN jsonb_build_object('refused','issue_evidence');
      END $$;
    """)
    assert bodies() == {f["name"]: f["body_md5"] for f in capture["functions"]}
    before_metadata = metadata()
    original_failures = []
    for label, club in [("member", C), ("host", H)]:
        seed(club)
        for which in ["selector", "hints", "admission"]:
            try:
                desired(which)
            except AssertionError:
                original_failures.append(label + "_" + which)
    assert len(original_failures) == 6, original_failures
    check("six desired behaviors fail against exact installed source")
    sql(migration.read_text())
    assert metadata() == before_metadata
    changed_bodies = bodies()
    sql(migration.read_text())
    assert bodies() == changed_bodies and metadata() == before_metadata
    check("migration preserves function identity and authorization; replay is stable")
    for label, club, union, returned in [
        ("union member", C, True, False), ("union host", H, True, False),
        ("standalone club", C, False, False),
        ("returned union member", C, True, True), ("returned union host", H, True, True),
    ]:
        seed(club, union, returned)
        for which in ["selector", "hints", "admission"]:
            desired(which)
        if returned:
            assert selector(T2).get("ticket_id") == K
            assert U in hints(T2)
            assert admission(T2) == {"boundary": "unchanged_financial_prelock"}
        assert sql("SELECT count(*) FROM tournament_players;") == "0"
        assert sql("SELECT status FROM tournament_tickets;") == "issued"
        check(label + " reaches unchanged financial boundary without any write")
    for label, change, reason in [
        ("unrelated union club", f"UPDATE tournament_tickets SET club_id='{O}'; UPDATE chip_ledger SET club_id='{O}'; UPDATE chip_transactions SET club_id='{O}';", "ticket_union_mismatch"),
        ("inactive membership", f"UPDATE club_members SET status='inactive' WHERE club_id='{C}';", "ticket_club_membership_inactive"),
        ("standalone other club", f"UPDATE tournaments SET union_id=NULL,club_id='{H}';", "ticket_club_mismatch"),
    ]:
        seed()
        sql(change)
        assert selector().get("ticket_id") is None
        assert U not in hints()
        assert admission().get("reason") == reason, admission()
        check(label + " refuses every ticket path")
    seed()
    sql("UPDATE chip_ledger SET amount=99;")
    assert selector() == {"ok": False, "reason": "matching_tournament_ticket_unavailable", "ticket_id": None}
    assert U in hints()  # Candidate presence prevents wallet fallback; not authorization.
    assert admission() == {"refused": "issue_evidence"}
    check("corrupt issue evidence stays visible and cannot authorize admission")
    seed()
    assert selector(T2).get("ticket_id") is None and U not in hints(T2)
    assert admission(T2) == {"refused": "issue_evidence"}
    check("direct satellite ticket cannot enter another target")
    for label, change, reason in [
        ("closed", "UPDATE tournaments SET status='COMPLETED';", "registration_closed"),
        ("finalized", "UPDATE tournaments SET prize_pool_finalized=true;", "target_pool_finalized"),
        ("duplicate", f"INSERT INTO tournament_players(tournament_id,user_id) VALUES('{T}','{U}');", "already_registered"),
        ("approval", "UPDATE tournaments SET authorized_to_register=true;", "not_authorized_to_register"),
        ("VIP", "UPDATE tournaments SET is_vip_only=true;", "vip_only"),
        ("wrong value", "UPDATE tournaments SET buy_in_amount=91;", "ticket_entry_contract_mismatch"),
        ("wallet only", "UPDATE tournament_tickets SET redemption_mode='wallet_only';", "ticket_is_wallet_only"),
    ]:
        seed()
        sql(change)
        assert admission().get("reason") == reason, admission()
        check(label + " admission guard remains authoritative")
    for fn, reason in [("fn_entry_purchases_frozen", "platform_frozen"),
                       ("fn_tournament_entry_cap_reached", "tournament_full")]:
        seed()
        sig = "" if "purchases" in fn else "uuid"
        sql(f"CREATE OR REPLACE FUNCTION {fn}({sig}) RETURNS boolean LANGUAGE sql AS 'SELECT true';")
        assert admission().get("reason") == reason
        sql(f"CREATE OR REPLACE FUNCTION {fn}({sig}) RETURNS boolean LANGUAGE sql AS 'SELECT false';")
        check(reason + " prevents ticket admission")
    seed()
    assert json.loads(sql(f"SET ROLE service_role; SELECT fn_horse_tournament_entry_ticket_hints('{T}');"))["holder_ids"] == [U]
    for role, fn in [("service_role", f"fn_ca_register_for_tournament_with_ticket_for('{T}','{K}','{U}')"),
                     ("authenticated", f"fn_horse_tournament_entry_ticket_hints('{T}')"),
                     ("anon", f"fn_ca_find_tournament_entry_ticket_for('{T}','{U}')")]:
        try:
            sql(f"SET ROLE {role}; SELECT {fn};")
        except AssertionError as exc:
            assert "permission denied" in str(exc)
        else:
            raise AssertionError("private ticket authority became exposed to " + role)
    check("service-only hints and private financial helper ACLs remain intact")
    # Reset all three original definitions, then drift the last migration entry.
    # A refusal after earlier replacements must roll back those replacements.
    for f in capture["functions"]:
        if f["name"].startswith("fn_ca_") or f["name"] == "fn_horse_tournament_entry_ticket_hints":
            definition = f["definition"]
            if f["name"] == "fn_horse_tournament_entry_ticket_hints":
                definition = definition.replace("DECLARE", "-- independent source drift\nDECLARE", 1)
            sql(definition)
    drift_bodies = bodies()
    try:
        sql(migration.read_text())
    except AssertionError as exc:
        assert "Union ticket scope source drift" in str(exc)
    else:
        raise AssertionError("source drift was accepted")
    assert bodies() == drift_bodies and metadata() == before_metadata
    check("source drift rolls the entire migration back")
    for f in capture["functions"]:
        if f["name"].startswith("fn_ca_") or f["name"] == "fn_horse_tournament_entry_ticket_hints":
            sql(f["definition"])
    sql("GRANT EXECUTE ON FUNCTION fn_horse_tournament_entry_ticket_hints(uuid) TO authenticated;")
    drift_bodies, drift_metadata = bodies(), metadata()
    try:
        sql(migration.read_text())
    except AssertionError as exc:
        assert "Union ticket scope authorization prerequisite drift" in str(exc)
    else:
        raise AssertionError("authorization drift was accepted")
    assert bodies() == drift_bodies and metadata() == drift_metadata
    check("authorization drift refuses installation and rolls earlier replacements back")
    print(json.dumps({"passed_groups": len(passed), "original_failures": original_failures,
                      "limits": "Scope and unchanged prelock only; no funded entry, production trigger graph or provider certificate."}))
finally:
    if started:
        subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-m", "immediate", "-w", "stop"],
                       capture_output=True, timeout=15)
    shutil.rmtree(root)
