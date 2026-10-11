#!/usr/bin/env python3
"""Qualify 20261010003544_a_chip_request_approval_key_belongs_to_its_approver
on a private PostgreSQL 17 cluster (127.0.0.1, a free port, trust auth, a
temporary data directory under $TMPDIR). Nothing here reaches production.

The fixture runs production's own text for every function on the path:
fn_respond_chip_request (20260905040100), fn_agent_wallet_send and the
exact-intent gate fn_cashier_exact_intent_begin / _finish (20261004124327),
each pinned by the md5 the release contract and the migration hold. Only the
send's accounting core is a stand-in (it pays from the caller's agent float
and refuses when the float is short), because the defect is in the key, not
in the core.

FAIL BEFORE: an agent refused for lack of float leaves the request
unapprovable by the owner. PASS AFTER: the owner approves, the chips move
once, retries replay, and an approval made under the old key still replays.
"""
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations/20261010003544_a_chip_request_approval_key_belongs_to_its_approver.sql"
RESPOND_SOURCE = ROOT / "supabase/migrations/20260905040100_an_approval_can_be_retried_and_a_freeze_means_something.sql"
GATE_SOURCE = ROOT / "supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql"
SCENARIO = ROOT / "tests/fixtures/chip-request-approval-db/scenario.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.fn_respond_chip_request(uuid,text)"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

cluster = Path(tempfile.mkdtemp(prefix="cr-db-", dir=os.environ.get("TMPDIR")))
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


def slice_create(text, head):
    start = text.index(head)
    return text[start:text.index("$function$;", start) + len("$function$;")]


MIGRATION = MIG.read_text()
PRE = re.search(r"IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION 'fn_respond_chip_request is not the live text", MIGRATION).group(1)
POST = re.search(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION).group(1)
gate = GATE_SOURCE.read_text()
INTENTS = gate[gate.index("CREATE TABLE public.cashier_rpc_operation_intents ("):gate.index("ALTER TABLE public.cashier_rpc_operation_intents ENABLE ROW LEVEL SECURITY;")]
BEGIN_FN = slice_create(gate, "CREATE FUNCTION public.fn_cashier_exact_intent_begin(")
FINISH_FN = slice_create(gate, "CREATE FUNCTION public.fn_cashier_exact_intent_finish(")
SEND_FN = slice_create(gate, "CREATE FUNCTION public.fn_agent_wallet_send(\n")
RESPOND_FN = slice_create(RESPOND_SOURCE.read_text(), "CREATE OR REPLACE FUNCTION public.fn_respond_chip_request(")

FIXTURE = """
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE FUNCTION public.u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
CREATE FUNCTION public.as_user(int) RETURNS void LANGUAGE sql AS
  $$SELECT set_config('request.jwt.claims', json_build_object('sub', public.u($1), 'role', 'authenticated')::text, false)$$;
CREATE FUNCTION public.assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2;END IF;RAISE NOTICE 'PASS: %',$2;END$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.club_members(club_id uuid, user_id uuid, role text, status text DEFAULT 'active', PRIMARY KEY(club_id, user_id));
CREATE TABLE public.agents(club_id uuid, user_id uuid, status text DEFAULT 'active', agent_wallet_balance numeric DEFAULT 0, PRIMARY KEY(club_id, user_id));
CREATE TABLE public.chip_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  club_id uuid, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid,
  notes text, metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.chip_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid NOT NULL, requester_id uuid NOT NULL,
  approver_id uuid, amount numeric(18,2) NOT NULL CHECK (amount > 0), note text,
  status text NOT NULL DEFAULT 'pending', responded_by uuid, responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), op_id uuid);
REVOKE ALL ON public.clubs, public.club_members, public.agents, public.chip_transactions, public.chip_requests FROM anon, authenticated;
CREATE FUNCTION public.fn_club_bank_role(p_club uuid, p_user uuid DEFAULT NULL) RETURNS text LANGUAGE sql STABLE
SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM clubs WHERE id = p_club AND owner_id = coalesce(p_user, auth.uid())) THEN 'owner'
              ELSE (SELECT role FROM club_members WHERE club_id = p_club AND user_id = coalesce(p_user, auth.uid()) AND status = 'active') END $$;
CREATE FUNCTION public.fn_club_settlement_frozen(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
-- The accounting core's stand-in: pays from the caller's agent float, refuses a short float.
CREATE FUNCTION public.fn_agent_wallet_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text DEFAULT 'player_wallet', p_reason text DEFAULT NULL, p_op_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_after numeric; v_tx uuid;
BEGIN
  UPDATE agents SET agent_wallet_balance = agent_wallet_balance - p_amount
   WHERE club_id = p_club_id AND user_id = auth.uid() AND agent_wallet_balance >= p_amount
  RETURNING agent_wallet_balance INTO v_after;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not Enough Chips In Your Agent Wallet'); END IF;
  INSERT INTO chip_transactions(club_id, transaction_type, amount, from_user_id, to_user_id, notes, metadata)
  VALUES (p_club_id, 'agent_wallet_send', p_amount, auth.uid(), p_to_user_id, p_reason, jsonb_build_object('op_id', p_op_id::text))
  RETURNING id INTO v_tx;
  RETURN jsonb_build_object('success', true, 'transaction_id', v_tx, 'agent_wallet_after', v_after, 'recipient_balance_after', p_amount);
END $$;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
"""
SEED = """
INSERT INTO public.clubs VALUES (public.u(100), public.u(1));
INSERT INTO public.club_members(club_id, user_id, role) VALUES
  (public.u(100), public.u(1), 'owner'), (public.u(100), public.u(10), 'agent'),
  (public.u(100), public.u(20), 'member'), (public.u(100), public.u(21), 'member');
INSERT INTO public.agents(club_id, user_id, agent_wallet_balance) VALUES
  (public.u(100), public.u(1), 1000), (public.u(100), public.u(10), 0);
-- An approval answered before the migration, under the request-only key.
INSERT INTO public.chip_requests(id, club_id, requester_id, approver_id, amount, status)
VALUES (public.u(7002), public.u(100), public.u(21), NULL, 25, 'pending');
SELECT public.as_user(1);
SET ROLE authenticated;
SELECT public.fn_respond_chip_request(public.u(7002), 'approve');
RESET ROLE;
"""


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE)
    q(db, INTENTS)
    q(db, "ALTER TABLE public.cashier_rpc_operation_intents ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.cashier_rpc_operation_intents FROM PUBLIC, anon, authenticated;")
    q(db, BEGIN_FN + "\n" + FINISH_FN + "\n" + SEND_FN + "\n" + RESPOND_FN)
    q(db, """REVOKE ALL ON FUNCTION public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb), public.fn_cashier_exact_intent_finish(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
             REVOKE ALL ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid), public.fn_respond_chip_request(uuid,text) FROM PUBLIC, anon;
             GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid), public.fn_respond_chip_request(uuid,text) TO authenticated, service_role;""")
    q(db, SEED)


def scenario(db, expect_pass):
    p = subprocess.run(psql(db), input="BEGIN;\n" + SCENARIO.read_text() + "\nROLLBACK;\n", capture_output=True, text=True, env=ENV, timeout=300)
    passes = re.findall(r"PASS: (.*)", p.stderr)
    fails = re.findall(r"FAIL: (.*)", p.stderr)
    total = len(re.findall(r"^SELECT assert_true\(", SCENARIO.read_text(), re.M))
    if expect_pass:
        require(p.returncode == 0 and not fails and len(passes) == total, f"scenario.sql: all {total} assertions pass ({len(passes)})")
    else:
        require(p.returncode != 0 and fails, f"scenario.sql fails on production's live body: {fails[:1]}")


def posture(db):
    return q(db, f"""SELECT json_build_array(pg_get_userbyid(proowner), prosecdef, proconfig, proacl::text[],
      has_function_privilege('anon', oid, 'EXECUTE'), has_function_privilege('authenticated', oid, 'EXECUTE'),
      has_function_privilege('service_role', oid, 'EXECUTE')) FROM pg_proc WHERE oid = '{SIG}'::regprocedure""")


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE;", user="fixture_bootstrap")

    install("live")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == PRE, f"production's live fn_respond_chip_request reproduced byte for byte (md5 {PRE})")
    require(q("live", "SELECT md5(pg_get_functiondef('public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure))") == "c6c14eb18feb9a645a7aa2ffad3cf6f1"
            and q("live", "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb)'::regprocedure") == "3ec6fc367b3dae5c4bf3978d0175ef22"
            and q("live", "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_cashier_exact_intent_finish(uuid,jsonb)'::regprocedure") == "cc05789c598b9b889a04f726b9b1e2ea",
            "the send wrapper and the exact-intent gate are production's text (release-contract md5s)")
    require(q("live", "SELECT status FROM public.chip_requests WHERE id = public.u(7002)") == "approved", "an approval answered under the live body (request-only key)")
    scenario("live", expect_pass=False)
    before = posture("live")

    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == PRE, "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == PRE, "a browser role cannot install it")
    run(psql("live"), MIGRATION)
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST, f"the installed body is the reviewed text (md5 {POST})")
    require(posture("live") == before, "owner, SECURITY DEFINER, search_path and grants are unchanged (authenticated and service_role, never anon)")
    run(psql("live"), MIGRATION, expect_fail="is not the live text this migration was written against")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST, "a replay is refused and changes nothing")
    scenario("live", expect_pass=True)
    q("live", "SELECT public.as_user(1)")
    replay = q("live", "SELECT public.as_user(1); SET ROLE authenticated; SELECT public.fn_respond_chip_request(public.u(7002), 'approve');")
    require('"replayed": true' in replay and q("live", "SELECT count(*) FROM public.chip_transactions WHERE to_user_id = public.u(21)") == "1",
            "an approval made under the request-only key still replays for its approver, and pays nothing twice")
    print("PASS: a chip request approval key belongs to its approver", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
