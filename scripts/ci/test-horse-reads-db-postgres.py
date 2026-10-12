#!/usr/bin/env python3
"""Qualify 20261012040542_a_treasury_funded_seat_reads_as_a_club_bank_send on a
private PostgreSQL 17 cluster (127.0.0.1, a free port, trust auth, a temporary
data directory under $TMPDIR). Nothing here reaches production.

The fixture runs production's own text for every read it changes, each pinned
by the md5 the migration holds: fn_club_trade_ledger as 20261010005048 leaves
it (that file is applied here, over production's 20261004124327 text, exactly
as the installer will), fn_club_bank_ledger (tests/fixtures/horse-reads-db/
club-bank-ledger-live.sql), fn_ca_chip_statement_page (20260914060325) and
fn_ca_chip_statement (20260914070338); and production's helpers on the path
(fn_arena_name, fn_club_bank_role, fn_club_active_cashier_edges,
fn_cashier_member_is_active as 20261010190307 leaves it, fn_can_use_club_bank,
ca_can_view_club_finances as 20261010010632 leaves it).
Only the treasury balance reader fn_ca_account_balance is a stand-in.

FAIL BEFORE: the Trade record and the Club Bank ledger print a treasury-funded
seat as 'horse_treasury_funding' with its horse note, the bank ledger offers
that kind as a filter, and the treasury statement carries 'horse_funding' and
the horse's user id. PASS AFTER: a funded seat and a person's Club Bank send
are the same row but for id, time, amount and recipient; every row, order,
count and figure is what it was.
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
MIGS = ROOT / "supabase/migrations"
MIG = MIGS / "20261012040542_a_treasury_funded_seat_reads_as_a_club_bank_send.sql"
NAMES_MIG = MIGS / "20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql"
FIX = ROOT / "tests/fixtures/horse-reads-db"
HELPERS = ROOT / "tests/fixtures/cashier-arena-names-db/production-helpers.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
SIG = {
    "trade": "public.fn_club_trade_ledger(uuid,integer,integer)",
    "bank": "public.fn_club_bank_ledger(uuid,integer,integer,text[])",
    "page": "public.fn_ca_chip_statement_page(text,uuid,jsonb,integer)",
    "stmt": "public.fn_ca_chip_statement(text,uuid,timestamptz,integer)",
}
OTHERS = {
    "public.fn_agent_wallet_reversible(uuid)": "3cc86bbb6317359a7b43fc34524d5876",
    "public.fn_arena_name(text,text,text,text,text,text)": "2b7a84c23987cb7c923dde302f9ea998",
    "public.fn_club_bank_role(uuid,uuid)": "36d48c9e935b77e4410075a482194dab",
    "public.fn_club_active_cashier_edges(uuid)": "886a0ff43829825eae68d08cfbb43a9a",
    "public.fn_cashier_member_is_active(uuid,uuid)": "2cabb4a5d0eb8e1cbb32d25cf4c4fa34",
    "public.fn_can_use_club_bank(uuid)": "0be67506c5fea9bc500d762fefcaa317",
    "public.ca_can_view_club_finances(uuid)": "20d5095763dc302c5cad8fcf1f66a9e9",
}
FAIL_BEFORE = {
    "a treasury-funded seat is a Club Bank send in the Trade record",
    "a funded seat and a person's Club Bank send carry the same kind, sender, note and fields",
    "no Trade record row says horse, for the owner, a super agent or an agent",
    "the Club Bank is the sender of every Club Bank send, never the operator who pressed Send",
    "an agent reads a funded seat in the downline exactly as a person's send",
    "a Club Bank send carries only where its chips went",
    "the Club Bank ledger offers no horse kind to filter by",
    "filtering Club Bank sends lists the funded seats with the rest, and the count agrees",
    "a funded seat and a person's Club Bank send carry the same fields in the Club Bank ledger",
    "no Club Bank ledger answer says horse",
    "the treasury statement names no horse, on either door",
    "a funded seat names no sender to anyone",
    "the funded seat's leg reads as table funding with no description",
}
TOTAL = 18

cluster = Path(tempfile.mkdtemp(prefix="horse-db-", dir=os.environ.get("TMPDIR")))
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


def slice_create(path, pattern):
    text = (MIGS / path).read_text()
    start = re.compile(pattern, re.I).search(text).start()
    tag = re.compile(r"\bas\s+(\$[A-Za-z0-9_]*\$)", re.I).search(text, start)
    end = text.index(tag.group(1), tag.end())
    return text[start:end + len(tag.group(1))] + ";"


def md5_of(db, sig):
    return q(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


MIGRATION = MIG.read_text()
PRE = dict(re.findall(r"IF md5\(pg_get_functiondef\('([^']+)'::regprocedure\)\) IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION '\w+ is not the live text", MIGRATION))
POST = dict(re.findall(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('([^']+)'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION))
assert set(PRE) == set(POST) == set(SIG.values()), (PRE, POST)

FIXTURE = """
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE FUNCTION public.u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
CREATE FUNCTION public.as_user(int) RETURNS void LANGUAGE sql AS
  $$SELECT set_config('request.jwt.claims', json_build_object('sub', public.u($1), 'role', 'authenticated')::text, false)$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, owner_id uuid, name text);
CREATE TABLE public.club_members(club_id uuid NOT NULL, user_id uuid NOT NULL, role text DEFAULT 'player',
  status text DEFAULT 'active', agent_id uuid, chip_balance numeric DEFAULT 0, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.agents(club_id uuid NOT NULL, user_id uuid NOT NULL, status text DEFAULT 'active', PRIMARY KEY (club_id, user_id));
CREATE TABLE public.profiles(id uuid PRIMARY KEY, alias text, username text, display_name text,
  first_name text, last_name text, full_name text, is_admin boolean DEFAULT false, is_horse boolean DEFAULT false,
  status text);
CREATE TABLE public.chip_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  club_id uuid NOT NULL, transaction_type text NOT NULL, amount numeric NOT NULL, from_user_id uuid,
  to_user_id uuid, notes text, metadata jsonb DEFAULT '{}'::jsonb, balance_after numeric,
  is_reversed boolean DEFAULT false, reversible_until timestamptz);
CREATE TABLE public.chip_ledger(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), amount numeric NOT NULL,
  category text NOT NULL, description text, club_id uuid, table_id uuid, tournament_id uuid, hand_id uuid,
  settlement_id uuid, from_type text, from_label text, from_entity_id uuid, to_type text, to_label text,
  to_entity_id uuid, metadata jsonb DEFAULT '{}'::jsonb, idempotency_key text, status text DEFAULT 'posted');
CREATE TABLE public.ca_account_snapshots(account_key text, balance numeric, taken_at timestamptz,
  cum_unexplained numeric, is_baseline boolean);
REVOKE ALL ON public.clubs, public.club_members, public.agents, public.profiles, public.chip_transactions,
  public.chip_ledger, public.ca_account_snapshots FROM anon, authenticated;
-- Stand-in: production's reader resolves the account's storage column; the
-- statement's legs, not its balance, are under test.
CREATE FUNCTION public.fn_ca_account_balance(p_type text, p_entity uuid, p_club uuid, p_col text) RETURNS numeric
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT 1000::numeric $$;
"""


def install(db, names_installed=True):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE)
    q(db, slice_create("20261010190307_deleted_accounts_cannot_receive_cashier_transfers.sql",
                       r"CREATE (OR REPLACE )?FUNCTION public\.fn_cashier_member_is_active\("))
    q(db, HELPERS.read_text())
    q(db, slice_create("20260823140232_club_bank_cashier_access_and_send.sql", r"create or replace function public\.fn_can_use_club_bank\("))
    q(db, slice_create("20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql", r"CREATE OR REPLACE FUNCTION public\.ca_can_view_club_finances\("))
    q(db, slice_create("20261004124327_cashier_authority_and_retry_keys_are_exact.sql", r"CREATE OR REPLACE FUNCTION public\.fn_club_trade_ledger\("))
    q(db, slice_create("20260825184056_agent_wallet_send_claim_back_and_admin_pull.sql", r"create or replace function public\.fn_agent_wallet_reversible\("))
    q(db, (FIX / "club-bank-ledger-live.sql").read_text())
    q(db, slice_create("20260914060325_chip_statement_complete_page_cursor.sql", r"CREATE OR REPLACE FUNCTION public\.fn_ca_chip_statement_page\("))
    q(db, slice_create("20260914070338_chip_statement_cached_boundary_refusal.sql", r"CREATE OR REPLACE FUNCTION public\.fn_ca_chip_statement\("))
    q(db, """
      REVOKE ALL ON FUNCTION public.fn_cashier_member_is_active(uuid,uuid), public.fn_club_active_cashier_edges(uuid),
        public.fn_ca_account_balance(text,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.fn_cashier_member_is_active(uuid,uuid), public.fn_club_active_cashier_edges(uuid),
        public.fn_ca_account_balance(text,uuid,uuid,text) TO service_role;
      REVOKE ALL ON FUNCTION public.fn_club_bank_role(uuid,uuid), public.fn_can_use_club_bank(uuid), public.ca_can_view_club_finances(uuid),
        public.fn_club_trade_ledger(uuid,integer,integer), public.fn_agent_wallet_reversible(uuid),
        public.fn_club_bank_ledger(uuid,integer,integer,text[]), public.fn_ca_chip_statement_page(text,uuid,jsonb,integer),
        public.fn_ca_chip_statement(text,uuid,timestamptz,integer) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid), public.fn_can_use_club_bank(uuid), public.ca_can_view_club_finances(uuid),
        public.fn_club_trade_ledger(uuid,integer,integer), public.fn_agent_wallet_reversible(uuid),
        public.fn_club_bank_ledger(uuid,integer,integer,text[]), public.fn_ca_chip_statement_page(text,uuid,jsonb,integer),
        public.fn_ca_chip_statement(text,uuid,timestamptz,integer) TO authenticated, service_role;""")
    if names_installed:
        q(db, NAMES_MIG.read_text())
    q(db, (FIX / "seed.sql").read_text())


def scenario(db):
    p = subprocess.run(psql(db, "authenticator"), input="BEGIN;\n" + (FIX / "scenario.sql").read_text() + "\nROLLBACK;\n",
                       capture_output=True, text=True, env=ENV, timeout=300)
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    return set(re.findall(r"PASS: (.*)", p.stderr)), set(re.findall(r"FAIL: (.*)", p.stderr)), p.stdout


def as_viewer(db, viewer, sql):
    return json.loads(q(db, f"SELECT public.as_user({viewer}); SET ROLE authenticated;\n{sql};", user="authenticator").splitlines()[-1])


def reads(db):
    """What every viewer is handed, by read."""
    out = {}
    for v in (1, 2, 10, 21):
        out[("trade", v)] = as_viewer(db, v, "SELECT coalesce(json_agg(to_jsonb(l)), '[]') FROM public.fn_club_trade_ledger(public.u(100), 251, 0) l")
    for v in (1, 2):
        out[("bank", v)] = as_viewer(db, v, "SELECT public.fn_club_bank_ledger(public.u(100), 200, 0, NULL)")
    out[("page", 1)] = as_viewer(db, 1, "SELECT public.fn_ca_chip_statement_page('club_treasury', public.u(100), NULL, 50) - 'generated_at' - 'ms'")
    out[("stmt", 1)] = as_viewer(db, 1, "SELECT public.fn_ca_chip_statement('club_treasury', public.u(100), NULL, 50) - 'generated_at' - 'ms'")
    return out


SAME = {"trade": ("id", "created_at", "amount", "to_user_id"),
        "bank": ("id", "created_at", "amount", "to_user_id", "balance_after", "is_reversed", "reversible")}


def skeleton(kind, value):
    """The part of an answer this migration must not move: which rows, in what
    order, for how much and to whom, and every figure."""
    if kind == "trade":
        return [[r[k] for k in SAME["trade"]] for r in value]
    if kind == "bank":
        return {"rows": [[r[k] for k in SAME["bank"]] for r in value["rows"]],
                **{k: value[k] for k in ("authorized", "total", "limit", "offset", "totals")}}
    legs = [[l[k] for k in ("id", "at", "direction", "amount", "counterparty_type", "counterparty_label", "counterparty_id",
                            "club_id", "table_id")] for l in value["legs"]]
    return {"legs": legs, **{k: v for k, v in value.items() if k != "legs"}}


def changed_cells(before, after):
    cells = set()
    for (kind, v), b in before.items():
        a = after[(kind, v)]
        if kind == "trade":
            pairs = [(r["id"][-4:], r, s) for r, s in zip(b, a)]
        elif kind == "bank":
            pairs = [(r["id"][-4:], r, s) for r, s in zip(b["rows"], a["rows"])]
            if b["types"] != a["types"]:
                cells.add((kind, v, "types"))
        else:
            pairs = [(r["id"][-4:], r, s) for r, s in zip(b["legs"], a["legs"])]
        for rid, r, s in pairs:
            for k in r:
                if r[k] != s[k]:
                    cells.add((kind, v, rid, k))
    return cells


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE; "
                  "CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO authenticator WITH SET TRUE;",
      user="fixture_bootstrap")

    install("live")
    for sig in SIG.values():
        require(md5_of("live", sig) == PRE[sig], f"production's {sig} reproduced byte for byte (md5 {PRE[sig]})")
    require(all(md5_of("live", sig) == want for sig, want in OTHERS.items()),
            "every helper on the path is production's text, and fn_agent_wallet_reversible is as 20261010005048 leaves it")

    passes, fails, out = scenario("live")
    require(fails == FAIL_BEFORE and len(passes) == TOTAL - len(FAIL_BEFORE) and f"SCENARIO FAILED {len(FAIL_BEFORE)} OF {TOTAL}" in out,
            f"scenario.sql fails exactly its {len(FAIL_BEFORE)} horse assertions on production's reads ({sorted(fails)})")
    before = reads("live")
    before_tables = q("live", "SELECT md5(concat_ws('|', (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM public.chip_transactions t), "
                              "(SELECT string_agg(l::text, ',' ORDER BY l.id) FROM public.chip_ledger l)))")
    posture_sql = ("SELECT json_agg(json_build_array(oid::regprocedure::text, pg_get_userbyid(proowner), prosecdef, provolatile, proconfig, "
                   "proacl::text[], pg_get_function_result(oid)) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ("
                   + ", ".join(f"'{s}'::regprocedure" for s in SIG.values()) + ")")
    before_posture = q("live", posture_sql)

    install("unnamed", names_installed=False)
    run(psql("unnamed"), MIGRATION, expect_fail="install 20261010005048_a_cashier_list_names_a_member_by_the_arena_name first")
    require(md5_of("unnamed", SIG["bank"]) == PRE[SIG["bank"]], "it refuses to run before 20261010005048 is installed, and changes nothing")
    install("drift")
    q("drift", (FIX / "club-bank-ledger-live.sql").read_text().replace("limit v_limit offset v_offset", "limit v_limit offset v_offset "))
    run(psql("drift"), MIGRATION, expect_fail="fn_club_bank_ledger is not the live text this migration was written against")
    require(md5_of("drift", SIG["trade"]) == PRE[SIG["trade"]], "a drifted read refuses the whole file")

    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(all(md5_of("live", s) == PRE[s] for s in SIG.values()), "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(all(md5_of("live", s) == PRE[s] for s in SIG.values()), "a browser role cannot install it")

    run(psql("live"), MIGRATION)
    for sig in SIG.values():
        require(md5_of("live", sig) == POST[sig], f"the installed {sig} is the reviewed text (md5 {POST[sig]})")
    require(q("live", posture_sql) == before_posture,
            "owner, SECURITY DEFINER, volatility, search_path, lock_timeout, result shape and grants are unchanged")
    require(all(md5_of("live", sig) == want for sig, want in OTHERS.items()), "no other function changes")
    require(q("live", "SELECT md5(concat_ws('|', (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM public.chip_transactions t), "
                      "(SELECT string_agg(l::text, ',' ORDER BY l.id) FROM public.chip_ledger l)))") == before_tables, "no row is written")
    run(psql("live"), MIGRATION, expect_fail="is not the live text this migration was written against")
    require(all(md5_of("live", s) == POST[s] for s in SIG.values()), "a replay is refused and changes nothing")

    passes, fails, out = scenario("live")
    require(not fails and len(passes) == TOTAL and f"SCENARIO PASSED {TOTAL}" in out, f"scenario.sql: all {TOTAL} assertions pass ({len(passes)})")

    after = reads("live")
    for key in before:
        require(skeleton(key[0], before[key]) == skeleton(key[0], after[key]),
                f"{key[0]} for u({key[1]}): the same rows, in the same order, for the same amounts and recipients, and the same figures")
    cells = changed_cells(before, after)
    expected = set()
    # A person's Club Bank send (9101 the owner's to u(21), stock note; 9104
    # the super agent's to u(10), typed reason): only where it went is kept of
    # its metadata, a stock note goes, and its operator is unnamed unless the
    # viewer is the operator or the member paid (lead decision 2).
    PARTY = {("trade", 1): {"9101"}, ("trade", 2): {"9104"}, ("trade", 10): {"9104"}, ("trade", 21): {"9101"},
             ("bank", 1): {"9101"}, ("bank", 2): {"9104"}}
    SEES = {("trade", 1): {"9101", "9104"}, ("trade", 2): {"9101", "9104"}, ("trade", 10): {"9101", "9104"},
            ("trade", 21): {"9101"}, ("bank", 1): {"9101", "9104"}, ("bank", 2): {"9101", "9104"}}
    for (kind, v), rows in SEES.items():
        for r in rows:
            expected.add((kind, v, r, "metadata"))
            if r == "9101":
                expected.add((kind, v, r, "notes"))
            if r not in PARTY[(kind, v)]:
                expected |= {(kind, v, r, "from_user_id"), (kind, v, r, "from_name")}
    for v in (1, 2, 10):
        expected |= {("trade", v, r, k) for r in ("9102", "9103") for k in ("transaction_type", "notes", "metadata")}
    for v in (1, 2):
        expected |= {("trade", v, "9106", "notes")}
        # The bank ledger named a sender-less row's "from" through fn_arena_name's
        # fallback ('Player'); a funded seat has no named sender now.
        expected |= {("bank", v, r, k) for r in ("9102", "9103") for k in ("transaction_type", "notes", "metadata", "from_name")}
        expected |= {("bank", v, "9106", "notes"), ("bank", v, "types")}
    expected |= {(d, 1, r, k) for d in ("page", "stmt") for r in ("8101", "8102") for k in ("category", "description")}
    require(cells == expected, f"only the horse tells and the Club Bank send's shape change ({len(cells)} cells; "
                               f"unexpected {sorted(cells - expected)[:6]}, missing {sorted(expected - cells)[:6]})")
    print("PASS: a treasury-funded seat reads as a Club Bank send", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
