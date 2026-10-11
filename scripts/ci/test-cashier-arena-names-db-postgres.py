#!/usr/bin/env python3
"""Qualify 20261010005048_a_cashier_list_names_a_member_by_the_arena_name on a
private PostgreSQL 17 cluster (127.0.0.1, a free port, trust auth, a temporary
data directory under $TMPDIR). Nothing here reaches production.

The fixture runs production's own text for every function on the path:
fn_club_trade_ledger (20261004124327) and fn_agent_wallet_reversible
(20260825184056), each pinned by the md5 the migration and the release
contract hold, and fn_arena_name, fn_club_bank_role and
fn_club_active_cashier_edges as production printed them
(tests/fixtures/cashier-arena-names-db/production-helpers.sql). Only
fn_cashier_member_is_active is a stand-in (an active club_members row).

FAIL BEFORE: the claim-back list names people by the World Hub name first and
the Trade record by the display name ahead of the username. PASS AFTER: both
name every profile with fn_arena_name, and nothing but the names changes.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations/20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql"
TRADE_SOURCE = ROOT / "supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql"
REV_SOURCE = ROOT / "supabase/migrations/20260825184056_agent_wallet_send_claim_back_and_admin_pull.sql"
HELPERS = ROOT / "tests/fixtures/cashier-arena-names-db/production-helpers.sql"
SCENARIO = ROOT / "tests/fixtures/cashier-arena-names-db/scenario.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
TRADE = "public.fn_club_trade_ledger(uuid,integer,integer)"
REV = "public.fn_agent_wallet_reversible(uuid)"
HELPER_MD5 = {
    "public.fn_arena_name(text,text,text,text,text,text)": "2b7a84c23987cb7c923dde302f9ea998",
    "public.fn_club_bank_role(uuid,uuid)": "36d48c9e935b77e4410075a482194dab",
    "public.fn_club_active_cashier_edges(uuid)": "886a0ff43829825eae68d08cfbb43a9a",
}
FAIL_BEFORE = {
    "the claim-back list names a recipient by the poker alias, never the World Hub name first",
    "a recipient with no alias is named by the username, not the real name",
    "a profile with no name in it reads Player, the arena fallback",
    "the owner's Trade record names every side by the arena name",
    "the agent's Trade record is its downline, named by the arena name",
    "a member's Trade record is only their own rows, named by the arena name",
    "no cashier list prints a real name or a World Hub name",
}
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

cluster = Path(tempfile.mkdtemp(prefix="names-db-", dir=os.environ.get("TMPDIR")))
data = cluster / "data"
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
started = False


def psql(db, user="postgres"):
    return [str(PG / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", str(PORT), "-U", user, "-d", db]


def run(argv, text=None, expect_fail=None):
    p = subprocess.run(argv, input=text, capture_output=True, text=True, env=ENV, timeout=300)
    if expect_fail is not None:
        if p.returncode == 0 or expect_fail not in p.stderr:
            raise AssertionError(f"expected failure containing {expect_fail!r}\n{p.stdout}\n{p.stderr[-3000:]}")
        return p
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    return p


def q(db, sql, user="postgres"):
    return run(psql(db, user), sql).stdout.strip()


def require(cond, label):
    if not cond:
        raise AssertionError("FAIL: " + label)
    print("PASS: " + label, flush=True)


def slice_create(text, head):
    start = text.index(head)
    tag = re.compile(r"\bas\s+(\$[A-Za-z0-9_]*\$)", re.I).search(text, start)
    end = text.index(tag.group(1), tag.end())
    return text[start:end + len(tag.group(1))] + ";"


def md5_of(db, sig):
    return q(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


MIGRATION = MIG.read_text()
PRE = dict(re.findall(r"IF md5\(pg_get_functiondef\('([^']+)'::regprocedure\)\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION '\w+ is not the live text", MIGRATION))
POST = dict(re.findall(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('([^']+)'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION))
assert set(PRE) == set(POST) == {TRADE, REV}, (PRE, POST)
TRADE_FN = slice_create(TRADE_SOURCE.read_text(), "CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(")
REV_FN = slice_create(REV_SOURCE.read_text(), "create or replace function public.fn_agent_wallet_reversible(")

FIXTURE = """
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE FUNCTION public.u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
CREATE FUNCTION public.as_user(int) RETURNS void LANGUAGE sql AS
  $$SELECT set_config('request.jwt.claims', json_build_object('sub', public.u($1), 'role', 'authenticated')::text, false)$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.club_members(club_id uuid NOT NULL, user_id uuid NOT NULL, role text DEFAULT 'player',
  status text DEFAULT 'active', agent_id uuid, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.profiles(id uuid PRIMARY KEY, alias text, username text, display_name text,
  first_name text, last_name text, full_name text);
CREATE TABLE public.chip_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  club_id uuid NOT NULL, transaction_type text NOT NULL, amount numeric NOT NULL, from_user_id uuid,
  to_user_id uuid, notes text, metadata jsonb DEFAULT '{}'::jsonb, is_reversed boolean DEFAULT false,
  reversible_until timestamptz);
REVOKE ALL ON public.clubs, public.club_members, public.profiles, public.chip_transactions FROM anon, authenticated;
-- Stand-in: production's helper also reads agents.status; here an active row is an active member.
CREATE FUNCTION public.fn_cashier_member_is_active(p_club uuid, p_user uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT EXISTS (SELECT 1 FROM public.club_members WHERE club_id = p_club AND user_id = p_user AND status = 'active') $$;
"""
GRANTS = f"""
REVOKE ALL ON FUNCTION public.fn_cashier_member_is_active(uuid,uuid), public.fn_club_active_cashier_edges(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashier_member_is_active(uuid,uuid), public.fn_club_active_cashier_edges(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_bank_role(uuid,uuid), {TRADE}, {REV} FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid), {TRADE}, {REV} TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_arena_name(text,text,text,text,text,text) TO anon, authenticated, service_role;
"""
SEED = """
INSERT INTO public.clubs VALUES (public.u(100), public.u(1));
INSERT INTO public.profiles(id, alias, username, display_name, first_name, last_name, full_name) VALUES
  (public.u(1),  'TheHouse',  'owner1',   'Olivia Owner',   'Olivia', 'Owner',   'Olivia Owner'),
  (public.u(10), 'SharkTank', 'agent10',  'Arthur Agent',   'Arthur', 'Agent',   'Arthur Agent'),
  (public.u(20), 'Kingfish',  'kingfish', 'Dan Bekavac',    'Dan',    'Bekavac', 'Dan Bekavac'),
  (public.u(21), NULL,        'jsmith',   'John Smith',     'John',   'Smith',   NULL),
  (public.u(23), NULL,        NULL,       NULL,             NULL,     NULL,      NULL),
  (public.u(24), 'RiverRat',  'rr24',     'River Hub Name', NULL,     NULL,      NULL),
  (public.u(30), 'Outsider',  'out30',    'Olga Outsider',  'Olga',   'Outsider', 'Olga Outsider');
INSERT INTO public.club_members(club_id, user_id, role, agent_id) VALUES
  (public.u(100), public.u(1), 'owner', NULL), (public.u(100), public.u(10), 'agent', NULL),
  (public.u(100), public.u(20), 'player', public.u(10)), (public.u(100), public.u(21), 'player', public.u(10)),
  (public.u(100), public.u(22), 'player', public.u(10)), (public.u(100), public.u(23), 'player', public.u(10)),
  (public.u(100), public.u(24), 'player', public.u(10)), (public.u(100), public.u(30), 'player', NULL);
INSERT INTO public.chip_transactions(id, created_at, club_id, transaction_type, amount, from_user_id, to_user_id, notes, metadata, reversible_until) VALUES
  (public.u(9001), now() - interval '8 minutes', public.u(100), 'agent_wallet_send', 100, public.u(10), public.u(20), 'Agent Send', '{}', now() + interval '10 minutes'),
  (public.u(9002), now() - interval '7 minutes', public.u(100), 'agent_wallet_send', 50, public.u(10), public.u(21), 'Agent Send', '{}', now() + interval '10 minutes'),
  (public.u(9003), now() - interval '6 minutes', public.u(100), 'agent_wallet_send', 25, public.u(10), public.u(22), 'Agent Send', '{}', now() + interval '10 minutes'),
  (public.u(9004), now() - interval '5 minutes', public.u(100), 'agent_wallet_send', 10, public.u(10), public.u(23), 'Agent Send', '{"claimed_back": 4}', now() + interval '10 minutes'),
  (public.u(9005), now() - interval '4 minutes', public.u(100), 'agent_wallet_send', 5, public.u(10), public.u(24), 'Agent Send', '{"destination": "player_wallet"}', now() + interval '10 minutes'),
  (public.u(9006), now() - interval '3 minutes', public.u(100), 'club_bank_send', 200, NULL, public.u(21), 'Club Bank Send', '{}', NULL),
  (public.u(9007), now() - interval '2 minutes', public.u(100), 'club_bank_claim', 15, public.u(30), NULL, 'Club Bank Claim', '{}', NULL),
  (public.u(9008), now() - interval '30 minutes', public.u(100), 'agent_wallet_send', 40, public.u(10), public.u(20), 'Agent Send', '{}', now() - interval '20 minutes');
"""
# Every column but the names, per viewer, to prove nothing else moves.
VIEWS = """
SELECT json_build_object(
  'ledger', (SELECT json_agg(json_build_array(l.id, l.created_at, l.transaction_type, l.amount, l.from_user_id,
               l.to_user_id, l.notes, l.metadata)) FROM public.fn_club_trade_ledger(public.u(100), 251, 0) l),
  'reversible', (SELECT json_agg(json_build_array(r.transaction_id, r.to_user_id, r.amount, r.claimed_back, r.remaining,
               r.destination, r.created_at, r.reversible_until)) FROM public.fn_agent_wallet_reversible(public.u(100)) r),
  'names', (SELECT json_build_object(
               'ledger', (SELECT json_object_agg(right(l.id::text, 4), json_build_array(l.from_name, l.to_name))
                            FROM public.fn_club_trade_ledger(public.u(100), 251, 0) l),
               'reversible', (SELECT json_object_agg(right(r.transaction_id::text, 4), r.to_name)
                                FROM public.fn_agent_wallet_reversible(public.u(100)) r))))
"""


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE)
    q(db, HELPERS.read_text())
    q(db, TRADE_FN + "\n" + REV_FN)
    q(db, GRANTS)
    q(db, SEED)


def scenario(db):
    p = subprocess.run(psql(db), input="BEGIN;\n" + SCENARIO.read_text() + "\nROLLBACK;\n", capture_output=True, text=True, env=ENV, timeout=300)
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    passes = re.findall(r"PASS: (.*)", p.stderr)
    fails = re.findall(r"FAIL: (.*)", p.stderr)
    return set(passes), set(fails), p.stdout


def views(db, viewer):
    return json.loads(q(db, f"SELECT public.as_user({viewer}); SET ROLE authenticated;\n{VIEWS};").splitlines()[-1])


def posture(db):
    return q(db, f"""SELECT json_agg(json_build_array(oid::regprocedure::text, pg_get_userbyid(proowner), prosecdef, provolatile, proconfig, proacl::text[],
      has_function_privilege('anon', oid, 'EXECUTE'), has_function_privilege('authenticated', oid, 'EXECUTE'),
      has_function_privilege('service_role', oid, 'EXECUTE'), pg_get_function_result(oid)) ORDER BY oid::regprocedure::text)
      FROM pg_proc WHERE oid IN ('{TRADE}'::regprocedure, '{REV}'::regprocedure)""")


def table_digest(db):
    return q(db, """SELECT md5(concat_ws('|',
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM public.chip_transactions t),
      (SELECT string_agg(p::text, ',' ORDER BY p.id) FROM public.profiles p),
      (SELECT string_agg(m::text, ',' ORDER BY m.user_id) FROM public.club_members m)))""")


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE;", user="fixture_bootstrap")

    install("live")
    for sig in (TRADE, REV):
        require(md5_of("live", sig) == PRE[sig], f"production's live {sig} reproduced byte for byte (md5 {PRE[sig]})")
    require(all(md5_of("live", sig) == want for sig, want in HELPER_MD5.items()),
            "fn_arena_name, fn_club_bank_role and fn_club_active_cashier_edges are production's text")

    passes, fails, out = scenario("live")
    require(fails == FAIL_BEFORE and len(passes) == 4 and "SCENARIO FAILED 7 OF 11" in out,
            f"scenario.sql fails exactly its {len(FAIL_BEFORE)} naming assertions on production's live bodies ({sorted(fails)})")
    before_views = {v: views("live", v) for v in (1, 10, 21, 30)}
    before_posture = posture("live")
    before_tables = table_digest("live")
    before_helpers = {sig: md5_of("live", sig) for sig in HELPER_MD5}

    install("drift")
    q("drift", REV_FN.replace("'Member'", "'A Member'"))
    run(psql("drift"), MIGRATION, expect_fail="fn_agent_wallet_reversible is not the live text this migration was written against")
    require(md5_of("drift", TRADE) == PRE[TRADE], "a drifted body refuses the whole file, and the other function is left as it was")

    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(all(md5_of("live", sig) == PRE[sig] for sig in (TRADE, REV)), "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(all(md5_of("live", sig) == PRE[sig] for sig in (TRADE, REV)), "a browser role cannot install it")

    run(psql("live"), MIGRATION)
    for sig in (TRADE, REV):
        require(md5_of("live", sig) == POST[sig], f"the installed {sig} is the reviewed text (md5 {POST[sig]})")
    require(posture("live") == before_posture,
            "owner, SECURITY DEFINER, volatility, search_path, lock_timeout, result shape and grants are unchanged (authenticated and service_role, never anon)")
    require({sig: md5_of("live", sig) for sig in HELPER_MD5} == before_helpers, "no other function changes")
    require(table_digest("live") == before_tables, "no row is written")
    run(psql("live"), MIGRATION, expect_fail="fn_club_trade_ledger is not the live text this migration was written against")
    require(all(md5_of("live", sig) == POST[sig] for sig in (TRADE, REV)), "a replay is refused and changes nothing")

    passes, fails, out = scenario("live")
    require(not fails and len(passes) == 11 and "SCENARIO PASSED 11" in out, f"scenario.sql: all 11 assertions pass ({len(passes)})")

    changed = set()
    for v in (1, 10, 21, 30):
        after = views("live", v)
        require(after["ledger"] == before_views[v]["ledger"] and after["reversible"] == before_views[v]["reversible"],
                f"viewer u({v}): the same rows, in the same order, with every other column identical")
        for key, pair in (before_views[v]["names"]["ledger"] or {}).items():
            for side, old, new in zip(("from", "to"), pair, after["names"]["ledger"][key]):
                if old != new:
                    changed.add(("ledger", v, key, side, old, new))
        for key, old in (before_views[v]["names"]["reversible"] or {}).items():
            new = after["names"]["reversible"][key]
            if old != new:
                changed.add(("reversible", v, key, "to", old, new))
    expected = {
        ("ledger", 1, "9002", "to", "John Smith", "jsmith"), ("ledger", 1, "9004", "to", None, "Player"),
        ("ledger", 1, "9006", "to", "John Smith", "jsmith"),
        ("ledger", 10, "9002", "to", "John Smith", "jsmith"), ("ledger", 10, "9004", "to", None, "Player"),
        ("ledger", 10, "9006", "to", "John Smith", "jsmith"),
        ("ledger", 21, "9002", "to", "John Smith", "jsmith"), ("ledger", 21, "9006", "to", "John Smith", "jsmith"),
        ("reversible", 10, "9001", "to", "Dan Bekavac", "Kingfish"), ("reversible", 10, "9002", "to", "John Smith", "jsmith"),
        ("reversible", 10, "9004", "to", "Member", "Player"), ("reversible", 10, "9005", "to", "River Hub Name", "RiverRat"),
    }
    require(changed == expected, f"only the names change, exactly where a profile was named another way ({len(changed)} cells)")
    print("PASS: a cashier list names a member by the arena name", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
