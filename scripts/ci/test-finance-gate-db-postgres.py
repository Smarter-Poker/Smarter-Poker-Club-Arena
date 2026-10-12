#!/usr/bin/env python3
"""Qualify 20261010010632_a_suspended_agent_stops_reading_the_club_finances on
a private PostgreSQL 17 cluster (127.0.0.1, a free port, trust auth, a
temporary data directory under $TMPDIR). Nothing here reaches production.

The fixture runs production's own text for the gate,
ca_can_view_club_finances (20260904180000), and for the cashier's activity
rule it now asks, fn_cashier_member_is_active (20261004124327), each pinned by
the md5 production printed. The scenario runs with session user authenticator,
as PostgREST calls it: the gate admits the database's own sessions outright,
so a scenario run as postgres would prove nothing.

FAIL BEFORE: a super agent the club suspended, one with no agents row or with
an agents row in another club, and an admin whose membership is pending all
read the books. PASS AFTER: none of them does, through the gate or through
the rake audit policy that calls it; everybody else is answered as before.
"""
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations/20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql"
GATE_SOURCE = ROOT / "supabase/migrations/20260904180000_a_player_record_says_what_it_measured.sql"
ACTIVE_SOURCE = ROOT / "supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql"
SCENARIO = ROOT / "tests/fixtures/finance-gate-db/scenario.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.ca_can_view_club_finances(uuid)"
ACTIVE = "public.fn_cashier_member_is_active(uuid,uuid)"
ACTIVE_MD5 = "6b08e6f97db67f009f47fcc69098e683"
FAIL_BEFORE = {
    "a super agent the club suspended does not, through the reports or the audit policy",
    "a super agent with no agents row does not",
    "a super agent whose active agents row is in another club does not",
    "an admin whose membership is pending does not",
}
TOTAL = 10
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

cluster = Path(tempfile.mkdtemp(prefix="gate-db-", dir=os.environ.get("TMPDIR")))
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


def slice_create(text, pattern):
    start = re.compile(pattern, re.I).search(text).start()
    tag = re.compile(r"\bas\s+(\$[A-Za-z0-9_]*\$)", re.I).search(text, start)
    end = text.index(tag.group(1), tag.end())
    return text[start:end + len(tag.group(1))] + ";"


def md5_of(db, sig):
    return q(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


MIGRATION = MIG.read_text()
PRE = re.search(r"IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION 'ca_can_view_club_finances is not the live text", MIGRATION).group(1)
POST = re.search(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION).group(1)
GATE_FN = slice_create(GATE_SOURCE.read_text(), r"CREATE OR REPLACE FUNCTION public\.ca_can_view_club_finances\(")
ACTIVE_FN = slice_create(ACTIVE_SOURCE.read_text(), r"CREATE (OR REPLACE )?FUNCTION public\.fn_cashier_member_is_active\(")

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
CREATE TABLE public.clubs(id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.club_members(club_id uuid NOT NULL, user_id uuid NOT NULL, role text DEFAULT 'player',
  status text DEFAULT 'active', agent_id uuid, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.agents(club_id uuid NOT NULL, user_id uuid NOT NULL, status text DEFAULT 'active', PRIMARY KEY (club_id, user_id));
CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_admin boolean DEFAULT false);
REVOKE ALL ON public.clubs, public.club_members, public.agents, public.profiles FROM anon, authenticated;
"""
# Production's rake_rate_audit read policy, on a probe table of the same shape.
POLICY = f"""
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public' AS $$ SELECT coalesce((SELECT is_admin FROM public.profiles WHERE id = auth.uid()), false) $$;
CREATE TABLE public.rake_rate_audit(id serial PRIMARY KEY, club_id uuid NOT NULL, note text);
ALTER TABLE public.rake_rate_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY rake_rate_audit_finance_read ON public.rake_rate_audit FOR SELECT TO authenticated
  USING (ca_can_view_club_finances(club_id) OR (SELECT fn_is_platform_admin()));
GRANT SELECT ON public.rake_rate_audit TO authenticated;
REVOKE ALL ON FUNCTION {ACTIVE} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION {ACTIVE} TO service_role;
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION {SIG} TO authenticated, service_role;
"""
SEED = """
INSERT INTO public.clubs VALUES (public.u(100), public.u(1)), (public.u(200), public.u(12));
INSERT INTO public.club_members(club_id, user_id, role, status) VALUES
  (public.u(100), public.u(1), 'owner', 'active'), (public.u(100), public.u(2), 'co_owner', 'approved'),
  (public.u(100), public.u(3), 'admin', 'active'), (public.u(100), public.u(4), 'super_agent', 'approved'),
  (public.u(100), public.u(5), 'super_agent', 'active'), (public.u(100), public.u(6), 'super_agent', 'active'),
  (public.u(100), public.u(7), 'admin', 'pending'), (public.u(100), public.u(8), 'admin', 'banned'),
  (public.u(100), public.u(9), 'agent', 'active'), (public.u(100), public.u(10), 'player', 'approved'),
  (public.u(100), public.u(14), 'super_agent', 'active'), (public.u(200), public.u(14), 'player', 'active');
INSERT INTO public.agents(club_id, user_id, status) VALUES
  (public.u(100), public.u(4), 'active'), (public.u(100), public.u(5), 'suspended'),
  (public.u(100), public.u(9), 'active'), (public.u(200), public.u(14), 'active');
INSERT INTO public.profiles(id, is_admin) VALUES (public.u(11), true);
INSERT INTO public.rake_rate_audit(club_id, note) VALUES (public.u(100), 'rake 5%'), (public.u(100), 'cap 3');
"""


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE)
    q(db, ACTIVE_FN + "\n" + GATE_FN)
    q(db, POLICY)
    q(db, SEED)


def scenario(db):
    p = subprocess.run(psql(db, "authenticator"), input="BEGIN;\n" + SCENARIO.read_text() + "\nROLLBACK;\n",
                       capture_output=True, text=True, env=ENV, timeout=300)
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    return set(re.findall(r"PASS: (.*)", p.stderr)), set(re.findall(r"FAIL: (.*)", p.stderr)), p.stdout


def posture(db):
    return q(db, f"""SELECT json_build_array(pg_get_userbyid(proowner), prosecdef, provolatile, proconfig, proacl::text[],
      has_function_privilege('anon', oid, 'EXECUTE'), has_function_privilege('authenticated', oid, 'EXECUTE'),
      has_function_privilege('service_role', oid, 'EXECUTE'), pg_get_function_result(oid)) FROM pg_proc WHERE oid = '{SIG}'::regprocedure""")


def table_digest(db):
    return q(db, """SELECT md5(concat_ws('|',
      (SELECT string_agg(m::text, ',' ORDER BY m.club_id, m.user_id) FROM public.club_members m),
      (SELECT string_agg(a::text, ',' ORDER BY a.club_id, a.user_id) FROM public.agents a),
      (SELECT string_agg(r::text, ',' ORDER BY r.id) FROM public.rake_rate_audit r)))""")


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
    require(md5_of("live", SIG) == PRE, f"production's live {SIG} reproduced byte for byte (md5 {PRE})")
    require(md5_of("live", ACTIVE) == ACTIVE_MD5, f"fn_cashier_member_is_active is production's text (md5 {ACTIVE_MD5})")
    require(q("live", "SELECT session_user", user="authenticator") == "authenticator"
            and q("live", f"SELECT public.as_user(5); SET ROLE authenticated; SELECT public.ca_can_view_club_finances(public.u(100));", user="authenticator").splitlines()[-1] == "t",
            "the scenario runs as PostgREST does (session user authenticator), where the suspended super agent is admitted today")

    passes, fails, out = scenario("live")
    require(fails == FAIL_BEFORE and len(passes) == TOTAL - len(FAIL_BEFORE) and f"SCENARIO FAILED {len(FAIL_BEFORE)} OF {TOTAL}" in out,
            f"scenario.sql fails exactly its {len(FAIL_BEFORE)} refusals on production's live gate ({sorted(fails)})")
    before_posture = posture("live")
    before_tables = table_digest("live")

    install("drift")
    q("drift", GATE_FN.replace("'banned', 'suspended'", "'banned', 'suspended', 'left'"))
    run(psql("drift"), MIGRATION, expect_fail="ca_can_view_club_finances is not the live text this migration was written against")
    require(md5_of("drift", SIG) != POST, "a drifted gate refuses the file")

    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(md5_of("live", SIG) == PRE, "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(md5_of("live", SIG) == PRE, "a browser role cannot install it")

    run(psql("live"), MIGRATION)
    require(md5_of("live", SIG) == POST, f"the installed gate is the reviewed text (md5 {POST})")
    require(posture("live") == before_posture,
            "owner, SECURITY DEFINER, volatility, search_path, result and grants are unchanged (authenticated and service_role, never anon)")
    require(md5_of("live", ACTIVE) == ACTIVE_MD5, "fn_cashier_member_is_active is unchanged")
    require(table_digest("live") == before_tables, "no row is written")
    run(psql("live"), MIGRATION, expect_fail="ca_can_view_club_finances is not the live text this migration was written against")
    require(md5_of("live", SIG) == POST, "a replay is refused and changes nothing")

    passes, fails, out = scenario("live")
    require(not fails and len(passes) == TOTAL and f"SCENARIO PASSED {TOTAL}" in out, f"scenario.sql: all {TOTAL} assertions pass ({len(passes)})")
    require(q("live", "SELECT public.ca_can_view_club_finances(public.u(100))") == "t",
            "the database's own sessions are still admitted (the installer, the jobs)")
    print("PASS: a suspended agent stops reading the club finances", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
