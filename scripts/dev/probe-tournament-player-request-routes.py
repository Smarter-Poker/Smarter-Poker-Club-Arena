#!/usr/bin/env python3
"""Exercise the actual staged PostgREST hook in isolated PostgreSQL 17.
This verifies request routing and lease proof only, not the full cutover or
economic settlement cores. No network database and no production transactions.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BINDIR = Path(os.environ.get("PG17_BINDIR", "/opt/homebrew/opt/postgresql@17/bin"))
STAGED = ROOT / "scripts/deploy/phase-three-strict-tournament-cutover.sql"
source = STAGED.read_text()
match = re.search(
    r"CREATE OR REPLACE FUNCTION smarter_private\.fn_smarter_data_api_pre_request\(\)"
    r".*?\$function\$;", source, re.S
)
assert match, "staged request hook is missing"

def quote(value):
    return "'" + value.replace("'", "''") + "'"

with tempfile.TemporaryDirectory(prefix="ca-route-", dir="/tmp") as temporary:
    base = Path(temporary)
    data = base / "data"
    socket = base / "socket"
    socket.mkdir()
    subprocess.run([str(BINDIR / "initdb"), "-D", str(data), "-U", "route_test", "--auth=trust", "--no-locale"],
                   check=True, capture_output=True)
    subprocess.run([str(BINDIR / "pg_ctl"), "-D", str(data), "-l", str(base / "postgres.log"),
                    "-o", f"-k {socket} -p 55442 -c listen_addresses=''", "-w", "start"],
                   check=True, capture_output=True)
    try:
        def sql(statement):
            # CI's pinned embedded server ships no psql. Reuse its existing
            # pinned Node SQL client, with this probe's isolated connection.
            if os.environ.get("PGNODE"):
                connection = dict(os.environ, PGHOST=str(socket), PGPORT="55442",
                                  PGUSER="route_test", PGDATABASE="postgres")
                return subprocess.run(
                    [os.environ["PGNODE"], str(ROOT / "scripts/ci/probes/chip-journal-atomicity/postgres-runtime/query.mjs")],
                    input=statement, text=True, capture_output=True, env=connection
                )
            return subprocess.run(
                [str(BINDIR / "psql"), "-X", "-v", "ON_ERROR_STOP=1",
                 "-h", str(socket), "-p", "55442", "-U", "route_test", "-d", "postgres", "-c", statement],
                text=True, capture_output=True
            )
        setup = """
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA smarter_private;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $auth$
 SELECT current_setting('request.jwt.claims',true)::jsonb->>'role'
$auth$;
CREATE TABLE public.engine_tournament_leases(
 tournament_id uuid PRIMARY KEY, protocol_version integer,
 lease_generation uuid, heartbeat_at timestamptz);
INSERT INTO public.engine_tournament_leases VALUES(
 '10000000-0000-4000-8000-000000000001',2,
 '50000000-0000-4000-8000-000000000001',clock_timestamp());
"""
        r = sql(setup + match.group() + """
REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
 TO anon, authenticated, service_role;
""")
        assert r.returncode == 0, r.stderr
        count = 0
        def check(role, route, headers, expected_actor=None, error=None):
            global count
            context = {
                "request.jwt.claims": json.dumps({"role": role}),
                "request.headers": json.dumps(headers),
                "request.path": route,
                "request.method": "POST",
            }
            statement = "BEGIN;" + "".join(
                "SELECT set_config(" + quote(k) + "," + quote(v) + ",true);"
                for k, v in context.items()
            )
            statement += f"SET LOCAL ROLE {role};SELECT smarter_private.fn_smarter_data_api_pre_request();RESET ROLE;"
            if expected_actor:
                proof = "protocol-2" if expected_actor == "tournament-manager" else ""
                statement += """
DO $assert$ BEGIN
 IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM ACTOR
 OR COALESCE(current_setting('app.smarter_manager_request_fenced',true),'') IS DISTINCT FROM PROOF THEN
  RAISE EXCEPTION 'request actor or lease proof mismatch';
 END IF;
END $assert$;
""".replace("ACTOR", quote(expected_actor)).replace("PROOF", quote(proof))
            statement += "ROLLBACK;"
            r = sql(statement)
            if error:
                assert r.returncode != 0 and error in r.stderr, (role, route, r.stderr)
            else:
                assert r.returncode == 0, (role, route, r.stderr)
            count += 1

        service = {"x-smarter-data-actor": "service", "x-smarter-data-protocol": "1"}
        manager = {
            "x-smarter-data-actor": "tournament-manager", "x-smarter-data-protocol": "2",
            "x-smarter-tournament-id": "10000000-0000-4000-8000-000000000001",
            "x-smarter-tournament-lease-generation": "50000000-0000-4000-8000-000000000001",
        }
        for route in ["/rpc/process_tournament_rebuy", "/rest/v1/rpc/fn_decline_tournament_rebuy"]:
            check("authenticated", route, {}, "browser")
            check("anon", route, {}, error="TOURNAMENT_MANAGER_AUTHORITY_REQUIRED")
            check("service_role", route, {}, error="TOURNAMENT_MANAGER_AUTHORITY_REQUIRED")
            check("service_role", route, service, error="TOURNAMENT_MANAGER_AUTHORITY_REQUIRED")
            check("authenticated", route, manager, error="DATA_ACTOR_FORBIDDEN")
            check("service_role", route, manager, "tournament-manager")
        check("authenticated", "/rpc/fn_spin_draw_and_settle_atomic", {},
              error="TOURNAMENT_MANAGER_AUTHORITY_REQUIRED")
        check("service_role", "/rpc/fn_spin_draw_and_settle_atomic", {},
              error="TOURNAMENT_MANAGER_AUTHORITY_REQUIRED")
        check("service_role", "/rpc/fn_spin_draw_and_settle_atomic", manager, "tournament-manager")
        check("service_role", "/rpc/claim_table_lease_v2", service, "service")
        check("service_role", "/unrelated_shared_table", {}, "shared-estate-service")
        stale = dict(manager, **{"x-smarter-tournament-lease-generation": "50000000-0000-4000-8000-000000000099"})
        check("service_role", "/rpc/process_tournament_rebuy", stale, error="TOURNAMENT_MANAGER_FENCED")
        print(f"{count} PostgreSQL request-route cases passed; full cutover remains separately gated.")
    finally:
        subprocess.run([str(BINDIR / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "stop"],
                       capture_output=True, check=True)
