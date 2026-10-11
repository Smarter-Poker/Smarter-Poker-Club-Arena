#!/usr/bin/env python3
"""Qualify 20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe
on a private PostgreSQL 17 cluster (127.0.0.1, a free port, trust auth, a
temporary data directory under $TMPDIR). Nothing here reaches production.

The fixture runs production's own text for the send path: the op-id wrapper
fn_union_send_to_member (20260901001025, md5 4758d36a..., the release-contract
pin) and its core fn_union_send_to_member_zd3core (tests/fixtures/union-send-db/
zd3core-live.sql, md5 fcb71e70...). The ledger writer is a stand-in for
fn_ca_autoledger on this path: a member's balance change journals one leg from
the declared counterparty (the union wallet) to that member's wallet, at the
transaction's instant, in the declared category.

FAIL BEFORE: a send of the same amount to a second member inside 20 seconds
is answered success and pays nothing. PASS AFTER: it is paid; a true retry is
still suppressed; the other kind is paid; the union pays exactly what it sent.
"""
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations/20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe.sql"
WRAPPER_SOURCE = ROOT / "supabase/migrations/20260901001025_ca_phase5_op_claims_record_their_actor.sql"
CORE_LIVE = ROOT / "tests/fixtures/union-send-db/zd3core-live.sql"
SCENARIO = ROOT / "tests/fixtures/union-send-db/scenario.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)"
WRAPPER_SIG = "public.fn_union_send_to_member(uuid,uuid,text,numeric,text,text,text)"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

cluster = Path(tempfile.mkdtemp(prefix="us-db-", dir=os.environ.get("TMPDIR")))
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


def q(db, sql, user="postgres", expect_fail=None):
    return run(psql(db, user), sql, expect_fail).stdout.strip()


def require(cond, label):
    if not cond:
        raise AssertionError("FAIL: " + label)
    print("PASS: " + label, flush=True)


MIGRATION = MIG.read_text()
PRE = re.search(r"IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION 'fn_union_send_to_member_zd3core is not the live text", MIGRATION).group(1)
POST = re.search(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION).group(1)
wrapper_src = WRAPPER_SOURCE.read_text()
start = wrapper_src.index("CREATE OR REPLACE FUNCTION public.fn_union_send_to_member(\n")
WRAPPER = wrapper_src[start:wrapper_src.index("$function$;", start) + len("$function$;")]

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
CREATE FUNCTION public.assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2;END IF;RAISE NOTICE 'PASS: %',$2;END$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY);
CREATE TABLE public.union_clubs(union_id uuid, club_id uuid);
CREATE TABLE public.club_members(club_id uuid, user_id uuid, role text, status text DEFAULT 'active',
  chip_balance numeric DEFAULT 0, updated_at timestamptz, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, user_id uuid,
  agent_wallet_balance numeric DEFAULT 0, promo_wallet_balance numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE public.union_wallets(union_id uuid PRIMARY KEY, chip_balance numeric, rake_wallet numeric,
  promo_wallet numeric, updated_at timestamptz);
CREATE TABLE public.union_wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid,
  wallet text, direction text, amount numeric, balance_after numeric, tx_type text, club_id uuid,
  period_id uuid, notes text, created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.chip_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  club_id uuid, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text,
  balance_after numeric, metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), from_type text NOT NULL,
  from_entity_id uuid, to_type text NOT NULL, to_entity_id uuid, amount numeric NOT NULL, category text NOT NULL,
  club_id uuid, created_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'posted');
CREATE INDEX idx_chip_ledger_to_entity_created ON public.chip_ledger(to_entity_id, created_at DESC);
CREATE TABLE public.ca_op_claims(op_id text, fn_name text, claimed_by uuid, result jsonb, finalized_at timestamptz,
  PRIMARY KEY (op_id, fn_name));
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
CREATE FUNCTION public.fn_union_can_manage_wallets(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT $2 = public.u(1) $$;
CREATE FUNCTION public.fn_player_home_club(uuid, uuid) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT club_id FROM public.club_members WHERE user_id = $1 ORDER BY club_id LIMIT 1 $$;
CREATE FUNCTION public.fn_ensure_agent_row(uuid, uuid, text) RETURNS uuid LANGUAGE sql AS
  $$ SELECT id FROM public.agents WHERE club_id = $1 AND user_id = $2 $$;
-- fn_ca_autoledger's shape on this path: a member's credit is one leg from the
-- declared counterparty to the member's wallet, at the transaction's instant.
CREATE FUNCTION public.fixture_autoledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chip_balance IS DISTINCT FROM OLD.chip_balance AND nullif(current_setting('app.ledger_category', true), '') IS NOT NULL THEN
    INSERT INTO public.chip_ledger(from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
    VALUES (current_setting('app.ledger_counterparty', true), nullif(current_setting('app.ledger_counterparty_entity', true), '')::uuid,
            'player_wallet', NEW.user_id, NEW.chip_balance - OLD.chip_balance, current_setting('app.ledger_category', true), NEW.club_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixture_autoledger AFTER UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fixture_autoledger();
INSERT INTO public.clubs VALUES (public.u(100));
INSERT INTO public.union_clubs VALUES (public.u(950), public.u(100));
INSERT INTO public.club_members(club_id, user_id, role) VALUES (public.u(100), public.u(20), 'player'), (public.u(100), public.u(21), 'player');
INSERT INTO public.union_wallets VALUES (public.u(950), 1000, 0, 1000, now());
"""


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE)
    q(db, CORE_LIVE.read_text())
    q(db, WRAPPER)
    q(db, f"""REVOKE ALL ON FUNCTION {SIG}, {WRAPPER_SIG} FROM PUBLIC, anon, authenticated;
              GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
              GRANT EXECUTE ON FUNCTION {WRAPPER_SIG} TO authenticated, service_role;""")


def scenario(db, expect_pass):
    # Autocommit: one send per transaction, as production runs them.
    p = subprocess.run(psql(db), input=SCENARIO.read_text(), capture_output=True, text=True, env=ENV, timeout=300)
    passes = re.findall(r"PASS: (.*)", p.stderr)
    fails = re.findall(r"FAIL: (.*)", p.stderr)
    total = len(re.findall(r"^SELECT assert_true\(", SCENARIO.read_text(), re.M))
    if expect_pass:
        require(p.returncode == 0 and not fails and len(passes) == total, f"scenario.sql: all {total} assertions pass ({len(passes)})")
    else:
        require(p.returncode != 0 and fails, f"scenario.sql fails on production's live body: {fails[:1]}")


def md5(db, sig):
    return q(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE;", user="fixture_bootstrap")

    install("before")
    require(md5("before", SIG) == PRE, f"production's live core reproduced byte for byte (md5 {PRE})")
    require(md5("before", WRAPPER_SIG) == "4758d36acff34f922bf1129ae6eecc1d", "production's op-id wrapper reproduced byte for byte (the release-contract md5)")
    scenario("before", expect_pass=False)

    install("after")
    acl = q("after", f"SELECT proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
    require(acl == "{postgres=X/postgres,service_role=X/postgres}", "the core is owner-and-service only, as production holds it")
    run(psql("after"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(md5("after", SIG) == PRE, "a rolled-back run changes nothing")
    run(psql("after"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(md5("after", SIG) == PRE, "a browser role cannot install it")
    run(psql("after"), MIGRATION)
    require(md5("after", SIG) == POST, f"the installed body is the reviewed text (md5 {POST})")
    require(q("after", f"SELECT proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure") == acl, "grants are unchanged")
    run(psql("after"), MIGRATION, expect_fail="is not the live text this migration was written against")
    require(md5("after", SIG) == POST, "a replay is refused and changes nothing")
    scenario("after", expect_pass=True)
    print("PASS: a union send is suppressed only as a retry to the same member", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
