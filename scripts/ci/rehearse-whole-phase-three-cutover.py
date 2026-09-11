#!/usr/bin/env python3
"""Prove repeated Stage B components or its exact one-pass bundle in native PG.

Runs the paid final-deal proof and actual R3 satellite source-to-target flow. Does not
deploy or certify engine adoption. Missing production break-bootstrap coverage
is reported separately and cannot be treated as Phase 3 completion.
"""
import argparse
import ast
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
SOCKET = "/tmp/codex-chip-drift-cutover-e2iav203/socket"
DB = "full_stage1"


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def q(text):
    return "'" + text.replace("'", "''") + "'"


def read_sql(query):
    return subprocess.check_output([PSQL, "-X", "-h", SOCKET, "-p", "55473",
        "-U", "postgres", "-d", DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", query],
        text=True).strip()


def function(source, name, expected):
    matches = list(re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION " + re.escape(name)
        + r"\(.*?\bAS\s+(\$\w*\$)(.*?)\1;", source, re.S | re.I))
    if len(matches) != 1 or hashlib.md5(matches[0][2].encode()).hexdigest() != expected:
        raise ValueError("exact function source differs: " + name)
    return matches[0][0]


def without_transaction(source):
    if len(re.findall(r"^BEGIN;$", source, re.M)) != 1 or len(re.findall(r"^COMMIT;$", source, re.M)) != 1:
        raise ValueError("source must have exactly one outer transaction")
    return re.sub(r"^(BEGIN|COMMIT);$", "", source, flags=re.M)


ACTIVATION_COMPONENTS = (
    "scripts/deploy/phase-three-current-satellite-terminal.sql",
    "scripts/deploy/phase-three-satellite-manager-target-scope.sql",
    "scripts/deploy/phase-three-strict-tournament-cutover.sql",
)
ACTIVATION_PATH = "scripts/deploy/phase-three-activate-current-terminal-authorities.sql"


def assemble_activation_bundle(root):
    """Reconstruct the exact reviewable single-transaction activation artifact."""
    strict = (root / ACTIVATION_COMPONENTS[-1]).read_text()
    first = "/* A busy relation aborts the whole cutover"
    last = "LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;"
    if strict.count(first) != 1 or strict.count(last) != 1:
        raise ValueError("strict global catalog lock source differs")
    lock_block = strict[strict.index(first):strict.index(last) + len(last)]
    parts = ["-- Prepared exact current terminal activation. NOT APPLIED.\n"
        "-- Run only after the full engine and bootstrap compatibility gates pass.\n"
        "-- One atomic transaction: current satellite adapter, target authority, strict cutover.\n"
        "BEGIN;\n\n-- Preserve the strict cutover's global-catalog-before-public-DDL lock order.\n"
        + lock_block + "\n"]
    for name in ACTIVATION_COMPONENTS:
        source = (root / name).read_text()
        body = without_transaction(source)
        if re.search(r"^(BEGIN|COMMIT|ROLLBACK);$", body, re.M):
            raise ValueError("activation component contains an extra transaction: " + name)
        parts.append("\n-- BEGIN ACTIVATION COMPONENT " + name + " SHA256 " + digest(source)
            + "\n" + body + "\n-- END ACTIVATION COMPONENT " + name + "\n")
    parts.append("\nCOMMIT;\n")
    result = "".join(parts)
    if len(re.findall(r"^BEGIN;$", result, re.M)) != 1 or len(re.findall(r"^COMMIT;$", result, re.M)) != 1:
        raise ValueError("activation bundle must contain exactly one BEGIN and COMMIT")
    return result


def replacement(source, start, end):
    expr = source.split(start, 1)[1].split(end, 1)[0]
    return "".join(x.replace("''", "'").replace("\\n", "\n")
        for x in re.findall(r"E'((?:[^']|'')*)'", expr))


def snapshot():
    catalogs = ("pg_proc", "pg_trigger", "pg_class", "pg_attribute", "pg_attrdef",
        "pg_constraint", "pg_index", "pg_policy", "pg_namespace", "pg_default_acl",
        "pg_db_role_setting", "pg_event_trigger", "pg_depend", "pg_shdepend", "pg_description")
    tables = json.loads(read_sql("""
SELECT COALESCE(json_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname,c.relname),'[]'::json)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','auth','smarter_private','cron','supabase_migrations') AND c.relkind IN ('r','p')
"""))
    queries = []
    for name in ["pg_catalog." + c for c in catalogs] + tables:
        queries.append("SELECT " + q(name) + " name,jsonb_build_object('count',count(*),"
            "'md5',md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' "
            "ORDER BY row_to_json(t)::text),''))) value FROM " + name + " t")
    result = {}
    for offset in range(0, len(queries), 60):
        result.update(json.loads(read_sql("SELECT jsonb_object_agg(name,value) FROM ("
            + " UNION ALL ".join(queries[offset:offset + 60]) + ") s")))
    return result


def request_dependencies(root):
    migrations = root / "supabase/migrations"
    busy = (migrations / "20260910063559_a_busy_manager_keeps_its_lease.sql").read_text()
    hook = function((migrations / "20260908043200_tournament_manager_requests_carry_lease_authority.sql").read_text(),
        "smarter_private.fn_smarter_data_api_pre_request", "79419c8aa9365edabf9b01b8a44d70a5")
    anchor = "     FOR SHARE;\n  END IF;"
    if hook.count(anchor) != 1:
        raise ValueError("Stage A hook anchor differs")
    hook = hook.replace(anchor, replacement(busy, "v_hook_new    text :=", "v_claim_anchor text :="), 1)
    hook = function(hook, "smarter_private.fn_smarter_data_api_pre_request", "ab227471f29f2944ebd64909622b6af7")
    claim = function((migrations / "20260908042900_tournament_leases_have_fencing_generations.sql").read_text(),
        "public.claim_tournament_lease_v2", "5396bfe7cfc936851d831aeb387d2751")
    anchor = "  INSERT INTO public.engine_tournament_leases AS l ("
    if claim.count(anchor) != 1:
        raise ValueError("takeover anchor differs")
    claim = claim.replace(anchor, replacement(busy, "v_claim_new    text :=", "BEGIN\n  -- 1. the hook"), 1)
    claim = function(claim, "public.claim_tournament_lease_v2", "d1b5100c2b9f92bec5fd1680b0b4f230")
    heartbeat = function((migrations / "20260908221010_lease_heartbeats_skip_busy_generations.sql").read_text(),
        "public.heartbeat_tournament_leases_v4", "5e6c99545e07c21efcb50e5cb3441c14")
    sql = """
DO $native_request_preimages$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
  AND md5(prosrc)='5aa393562da8742a2f5ef99ab15fcca6' AND prosecdef AND proowner='postgres'::regrole)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure
  AND md5(prosrc)='5396bfe7cfc936851d831aeb387d2751' AND prosecdef AND proowner='postgres'::regrole)
 OR to_regprocedure('public.heartbeat_tournament_leases_v4(text,jsonb,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'owned Stage A request baseline differs'; END IF;
END $native_request_preimages$;
"""
    sql += hook + "\n" + claim + "\n" + heartbeat + "\n"
    sql += """
-- Native clone restores the SELECT/UPDATE grants verified true on the bound production project.
GRANT SELECT,UPDATE ON public.tournaments TO service_role;
GRANT SELECT ON public.clubs,public.tournament_players,public.managed_game_contract_versions TO service_role;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT EXECUTE ON FUNCTION auth.role(),auth.uid() TO service_role;
REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC,anon,authenticated,service_role,authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) TO authenticated,service_role;
"""
    return sql


REQUEST_PROBE = """
CREATE FUNCTION pg_temp.whole_stage_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'PASS %',label;
END $assert$;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.headers','{}',true),set_config('request.method','POST',true),
 set_config('request.path','rpc/claim_tournament_lease_v2',true);
DO $unmarked$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM smarter_private.fn_smarter_data_api_pre_request();
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.whole_stage_assert(refused,'whole Stage B denies unmarked exact engine request');
END $unmarked$;
SELECT set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.whole_stage_assert(granted,'current exact claim grants synthetic manager')
 FROM public.claim_tournament_lease_v2('87000000-0000-0000-0000-000000000001',
 'native-whole-phase-three','native-reviewed-source','87900000-0000-0000-0000-000000000001',30);
SELECT set_config('request.headers',
 '{"x-smarter-data-actor":"tournament-manager","x-smarter-data-protocol":"2","x-smarter-tournament-id":"87000000-0000-0000-0000-000000000001","x-smarter-tournament-lease-generation":"87900000-0000-0000-0000-000000000001"}',true),
 set_config('request.path','tournaments',true),set_config('request.method','PATCH',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.whole_stage_assert(current_setting('app.smarter_manager_request_fenced',true)='protocol-2',
 'whole Stage B request hook proves real current lease generation');
UPDATE public.tournaments SET name=name WHERE id='87000000-0000-0000-0000-000000000001';
DO $scope$
DECLARE refused boolean:=false;
BEGIN
 BEGIN
  UPDATE public.tournaments SET name=name WHERE id='30000000-0000-0000-0000-000000000001';
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.whole_stage_assert(refused,'whole Stage B row trigger rejects cross-event manager write');
END $scope$;
RESET ROLE;
SELECT set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true),
 set_config('request.jwt.claims','{}',true),set_config('request.headers','{}',true);
SELECT 'WHOLE_STAGE_B_CATALOG='||jsonb_build_object(
 'hook_md5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure),
 'legacy_hand_door',to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
 'lease_table_service_write',has_table_privilege('service_role','public.engine_tournament_leases','UPDATE'),
 'scope_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname='a0_tournament_manager_write_scope' AND tgenabled<>'D' AND NOT tgisinternal),
 'break_window_triggers',(SELECT COALESCE(jsonb_agg(evtname ORDER BY evtname),'[]'::jsonb) FROM pg_event_trigger
  WHERE evtname IN ('ca_break_window_refuses_ddl','ca_break_window_refuses_drops') AND evtenabled='O')
)::text;
"""


def compose(root, bootstrap=None, activation_bundle=None):
    final = module(root / "scripts/ci/rehearse-final-deal-current-terminal.py", "whole_phase_final")
    original_runtime = final.runtime_sql
    stage = without_transaction((root / "scripts/deploy/phase-three-strict-tournament-cutover.sql").read_text())
    satellite = module(root / "scripts/ci/rehearse-satellite-full-terminal.py", "whole_satellite_authority")
    entry = module(root / "scripts/ci/rehearse-satellite-cancel-current.py", "whole_satellite_entry")
    manager = module(root / "scripts/ci/satellite-stage-b-manager-probe.py", "whole_satellite_manager")
    adapter = without_transaction((root / "scripts/deploy/phase-three-current-satellite-terminal.sql").read_text())
    target = without_transaction((root / "scripts/deploy/phase-three-satellite-manager-target-scope.sql").read_text())
    activation = None
    if activation_bundle is not None:
        if activation_bundle.resolve() != (root / ACTIVATION_PATH).resolve():
            raise ValueError("requires the exact prepared current-terminal activation bundle")
        source = activation_bundle.read_text()
        if source != assemble_activation_bundle(root):
            raise ValueError("activation bundle differs from its exact current components or lock ordering")
        activation = without_transaction(source)

    def runtime(selected_root):
        original = original_runtime(selected_root)
        marker = "-- BEGIN CANONICAL TERMINAL PLACE BATCH CONTRACT"
        if original.count(marker) != 1:
            raise ValueError("final runtime cutover marker differs")
        prefix = original.split(marker, 1)[0]
        marker = "SELECT 'FINAL_DEAL_NATIVE_COMPOSITION='"
        if original.count(marker) != 1:
            raise ValueError("composition evidence marker differs")
        manifest = marker + original.split(marker, 1)[1]
        preparation = request_dependencies(root)
        # Match expand state before the complete contraction. All seven guards
        # are enabled by Stage B before any acceptance payment is attempted.
        preparation += "\n".join("ALTER TABLE public.tournaments DISABLE TRIGGER " + n + ";"
            for n in final.GUARDS) + "\n"
        bootstrap_sql = ""
        if bootstrap:
            # The retained native baseline predates the production DDL guards.
            # Install their exact tracked sources and history receipts inside
            # the same outer rollback before the already-applied bootstrap.
            for version, name, expected in (
                ("20260910154446", "the_database_refuses_migrations_inside_the_break_window", "772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082"),
                ("20260910160841", "the_break_window_refusal_names_its_rule_and_explains_list_migrations", "7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d"),
            ):
                source = (root / "scripts/ci/fixtures" / ("production-" + version + ".sql")).read_text()
                if digest(source) != expected:
                    raise ValueError("production DDL guard receipt source differs: " + version)
                native_source = without_transaction(source)
                if version == "20260910154446":
                    # Supabase postgres is NOSUPERUSER; initdb postgres is SUPERUSER.
                    # Preserve every production function/trigger byte. Adapt only
                    # the historical installer's role-fixture assertion, and do not
                    # claim native coverage of the protected-window exception.
                    role_check = re.search(r"  IF NOT public\.fn_ca_break_window_governs\('postgres', 'mgmt-api'\).*?  END IF;", native_source, re.S)
                    if role_check is None:
                        raise ValueError("historical role-fixture assertion differs")
                    native_check = "  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') OR public.fn_ca_break_window_governs('postgres','mgmt-api') THEN RAISE EXCEPTION 'native initdb role fixture differs'; END IF;"
                    native_source = native_source[:role_check.start()] + native_check + native_source[role_check.end():]
                bootstrap_sql += native_source + "\n"
                bootstrap_sql += "INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (" + q(version) + "," + q(name) + ",ARRAY[convert_from(decode(" + q(source.encode().hex()) + ",'hex'),'UTF8')]);\n"
            # Supabase default function ACL includes service_role; initdb has none.
            # Match the exact production preimage ACL required by the next source.
            bootstrap_sql += "GRANT EXECUTE ON FUNCTION public.fn_ca_break_window_ddl_guard() TO service_role;\n"
            bootstrap_sql += without_transaction(bootstrap.read_text()) + "\n"
        canonical = "".join(final.block(root / "scripts/deploy/phase-three-strict-tournament-cutover.sql", marker)
            for marker in ("CANONICAL TERMINAL PLACE BATCH CONTRACT", "CANONICAL TERMINAL READINESS DISPATCH"))
        request_probe = REQUEST_PROBE
        route_anchor = "UPDATE public.tournaments SET name=name WHERE id='87000000-0000-0000-0000-000000000001';"
        if request_probe.count(route_anchor) != 1:
            raise ValueError("whole-stage route test injection anchor differs")
        request_probe = request_probe.replace(route_anchor,
            (root / "scripts/ci/probes/phase-three-current-manager-routes.sql").read_text() + "\n" + route_anchor)
        cutover = activation if activation is not None else (
            adapter + "\n" + adapter + "\n" + target + "\n" + target + "\n" + stage + "\n" + stage + "\n")
        return (prefix + canonical + entry.runtime_sql(root, False) + satellite.satellite_authority(root)
            + preparation + bootstrap_sql + cutover + "\n" + manifest + request_probe)

    final.runtime_sql = runtime
    try:
        paid_probe = (root / "scripts/ci/probes/final-deal-current-terminal-native.sql").read_text()
        satellite_probe = manager.compose_manager_probe(root)
        active_anchor = "END $state$;"
        if satellite_probe.count(active_anchor) != 1:
            raise ValueError("active satellite target injection anchor differs")
        satellite_probe = satellite_probe.replace(active_anchor, active_anchor + "\n"
            + (root / "scripts/ci/probes/satellite-manager-target-negative-native.sql").read_text(), 1)
        satellite_probe = satellite_probe.replace("'tournament_tickets','tournament_satellite_settlements'",
            "'tournament_satellite_manager_targets','tournament_tickets','tournament_satellite_settlements'", 1)
        snapshot_anchor = "RETURN result||jsonb_build_object('observed_authorities',"
        if satellite_probe.count(snapshot_anchor) != 1:
            raise ValueError("satellite counter observer snapshot anchor differs")
        satellite_probe = satellite_probe.replace(snapshot_anchor,
            "RETURN result||jsonb_build_object('target_counter_events',"
            "(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text),'[]'::jsonb) FROM satellite_target_counter_events e),"
            "'observed_authorities',", 1)
        satellite_probe = satellite_probe.replace("SET CONSTRAINTS ALL IMMEDIATE;", """
SELECT pg_temp.satellite_full_assert((SELECT count(*)=16 FROM satellite_target_scope_denials)
 AND NOT EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets),
 'all active target denials passed and child authority was cascade-consumed with its source');
SELECT pg_temp.satellite_full_assert((SELECT count(*)=2 FROM satellite_target_counter_events)
 AND EXISTS(SELECT 1 FROM satellite_target_counter_events WHERE before_count=1 AND after_count=2
  AND before_prize=90 AND after_prize=90 AND before_fee=10 AND after_fee=10 AND award_count=0 AND depth>=2)
 AND EXISTS(SELECT 1 FROM satellite_target_counter_events WHERE before_count=2 AND after_count=2
  AND before_prize=90 AND after_prize=180 AND before_fee=10 AND after_fee=20 AND award_count=1 AND depth=1),
 'actual nested roster recount changes only count, then final funded aggregate counts that entrant once');
SET CONSTRAINTS ALL IMMEDIATE;
""", 1)
        if paid_probe.count("ROLLBACK;") != 1 or satellite_probe.count("-- @FINAL_DEAL_RUNTIME@") != 1:
            raise ValueError("combined terminal probe transaction or runtime marker differs")
        # A fresh RPC starts with catalog-declared initially deferred constraints.
        # The first proof deliberately flushes them; restore that initial mode for
        # the second real transaction scenario inside the outer native rollback.
        boundary = """
RESET ROLE;
-- PostgREST's legacy scalar claims take precedence over the JSON claims in
-- auth.uid()/auth.role(). Clear both representations before the next fixture
-- establishes its own genuine authenticated request and existing wallet.
SELECT set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true),
 set_config('app.smarter_manager_deleted_table_ids','',true),
 set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true),
 set_config('request.jwt.claim.role','',true),set_config('request.jwt.claim.email','',true),
 set_config('request.jwt.claim.aud','',true),set_config('request.jwt.claim.session_id','',true),
 set_config('request.headers','{}',true),set_config('request.cookies','{}',true),
 set_config('request.method','',true),set_config('request.path','',true);
DO $fresh_satellite_auth$ BEGIN
 IF current_user<>'postgres' OR auth.uid() IS NOT NULL OR NULLIF(auth.role(),'') IS NOT NULL THEN
  RAISE EXCEPTION 'next satellite fixture inherited an authenticated request'; END IF;
END $fresh_satellite_auth$;
DO $initial_constraints$ DECLARE r record; BEGIN
 FOR r IN SELECT DISTINCT n.nspname,c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
  WHERE n.nspname='public' AND c.condeferrable AND c.condeferred LOOP
  EXECUTE format('SET CONSTRAINTS %I.%I DEFERRED',r.nspname,r.conname);
 END LOOP;
END $initial_constraints$;
"""
        combined = paid_probe.replace("ROLLBACK;", "") + boundary + satellite_probe.replace("-- @FINAL_DEAL_RUNTIME@", "")
        with tempfile.TemporaryDirectory(prefix="codex-whole-stage-probe-") as directory:
            probe = Path(directory) / "combined-terminal-probe.sql"
            probe.write_text(combined)
            sql = final.compose(root, "paid", probe)
    finally:
        final.runtime_sql = original_runtime
    if len(re.findall(r"^BEGIN;$", sql, re.M)) != 1 or re.search(r"^COMMIT;$", sql, re.M):
        raise ValueError("native SQL must contain one rollback-only transaction")
    if len(re.findall(r"^ROLLBACK;$", sql, re.M)) != 1:
        raise ValueError("native SQL must end with exactly one rollback")
    return sql


def source_fingerprints(root, bootstrap=None, activation_bundle=None):
    # Follow literal repository source inputs through the composing Python
    # modules. Historical git objects are independently byte-pinned by those
    # modules and cannot change under their recorded commit identity.
    pending = [Path(__file__).resolve()]
    paths = set()
    while pending:
        path = pending.pop()
        if path in paths:
            continue
        paths.add(path)
        if path.suffix != ".py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            value = node.value
            if len(value) > 300 or "\n" in value or not value.endswith((".py", ".sql", ".json")):
                continue
            for candidate in (root / value, root / "supabase/migrations" / value,
                              root / "scripts/deploy" / value, root / "scripts/ci/probes" / value):
                if candidate.is_file() and candidate.resolve().is_relative_to(root):
                    pending.append(candidate.resolve())
    if bootstrap:
        paths.add(bootstrap)
        paths.update(root / "scripts/ci/fixtures" / name for name in (
            "production-20260910154446.sql", "production-20260910160841.sql"))
    if activation_bundle:
        paths.add(activation_bundle)
    return {str(path.relative_to(root)) if path.is_relative_to(root) else str(path):
            digest(path.read_text()) for path in sorted(paths)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--bootstrap-migration", type=Path)
    parser.add_argument("--activation-bundle", type=Path,
        help="prove the exact prepared one-pass base/target/strict activation bundle")
    parser.add_argument("--emit-only", type=Path, help="compose SQL without a database connection")
    args = parser.parse_args()
    root = args.root.resolve()
    if "/.agent-trees/" not in str(root):
        raise SystemExit("requires the explicitly owned repository worktree")
    bootstrap = args.bootstrap_migration.resolve() if args.bootstrap_migration else None
    if bootstrap and (not bootstrap.is_file() or "20260910164655" not in bootstrap.name):
        raise SystemExit("requires exact available 20260910164655 bootstrap source")
    activation_bundle = args.activation_bundle.resolve() if args.activation_bundle else None
    if activation_bundle and not activation_bundle.is_file():
        raise SystemExit("activation bundle file is missing")
    sources_before = source_fingerprints(root, bootstrap, activation_bundle)
    bundle_sha = digest(activation_bundle.read_text()) if activation_bundle else None
    sql = compose(root, bootstrap, activation_bundle)
    if args.emit_only:
        args.emit_only.write_text(sql)
        print(json.dumps({"sql":str(args.emit_only),"sha256":digest(sql),"database_connected":False}))
        return
    baseline = read_sql("""
SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='87000000-0000-0000-0000-000000000001')::text
""")
    if baseline != "full_stage1|postgres|true|15|12|0|3|false":
        raise SystemExit("exclusive retained baseline differs: " + baseline)
    before = snapshot()
    output = Path(tempfile.mkdtemp(prefix="codex-whole-phase-three-"))
    path = output / "whole-stage-b.sql"
    path.write_text(sql)
    run = subprocess.run([PSQL,"-X","-h",SOCKET,"-p","55473","-U","postgres","-d",DB,
        "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log = run.stdout + run.stderr
    (output / "whole-stage-b.log").write_text(log)
    after = snapshot()

    def row(prefix):
        values = [s[len(prefix):] for s in run.stdout.splitlines() if s.startswith(prefix)]
        return json.loads(values[0]) if len(values) == 1 else None

    terminal, cutover = row("FINAL_DEAL_NATIVE_EVIDENCE="), row("WHOLE_STAGE_B_CATALOG=")
    satellite = row("SATELLITE_FULL_NATIVE_EVIDENCE=")
    sources_after = source_fingerprints(root, bootstrap, activation_bundle)
    stable_sources = sources_before == sources_after
    passed = run.returncode == 0 and before == after and terminal is not None and cutover is not None and satellite is not None and stable_sources
    covered = bootstrap is not None and cutover is not None and len(cutover["break_window_triggers"]) == 2
    evidence = {"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "database":DB,"baseline":baseline,"status":"passed" if passed else "failed",
        "whole_stage_b_executed_twice":run.returncode == 0 and activation_bundle is None,"production_ddl_applied":False,
        "activation_bundle_executed_once":run.returncode == 0 and activation_bundle is not None,
        "activation_bundle_source":str(activation_bundle) if activation_bundle else None,
        "activation_bundle_sha256":bundle_sha,
        "one_outer_rollback_transaction":len(re.findall(r"^BEGIN;$",sql,re.M)) == 1
            and len(re.findall(r"^ROLLBACK;$",sql,re.M)) == 1 and re.search(r"^COMMIT;$",sql,re.M) is None,
        "composition_order":["current dependencies",
            *(["exact activation bundle once: global lock, base adapter, child target scope, strict cutover"]
              if activation_bundle else ["base satellite adapter twice","child target scope twice","strict cutover twice"]),
            "paid final deal","manager satellite"],
        "source_inputs_stable":stable_sources,
        "source_inputs_changed":[k for k in sorted(set(sources_before)|set(sources_after)) if sources_before.get(k)!=sources_after.get(k)],
        "engine_adoption_verified":False,"production_break_bootstrap_covered":False,
        "outside_window_production_guard_compatibility":covered,
        "native_role_fixture":"initdb postgres is SUPERUSER; deployed postgres is NOSUPERUSER. Only the historical installer role assertion is adapted. Production function and trigger bodies are unchanged.",
        "bootstrap_source":str(bootstrap) if bootstrap else None,
        "bootstrap_source_sha256":digest(bootstrap.read_text()) if bootstrap else None,
        "coverage_gaps":["Protected-window management-transport bootstrap exception is not certified; this rehearsal and activation are outside the protected window."],
        "exit_code":run.returncode,"assertions":len(re.findall(r"NOTICE:\s+PASS ",log)),
        "exact_rollback":before == after,
        "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k) != after.get(k)],
        "terminal_evidence":terminal,"satellite_terminal_evidence":satellite,"cutover_catalog":cutover,
        "satellite_actual_manager_request":passed,"satellite_runtime_composition":row("SATELLITE_FULL_COMPOSITION="),
        "runtime_composition":row("FINAL_DEAL_NATIVE_COMPOSITION="),
        "before":before,"after":after,"output_directory":str(output),"sql_sha256":digest(sql),
        "source_sha256":sources_before,"source_sha256_after":sources_after,
        "known_target_admission_limit":"Current M2 itself requires target cached pools equal existing escrow balances before delivery; this rehearsal does not certify targets with earlier paid liabilities. The child guard preserves all existing custody components and checks only exact funded deltas.",
        "failure_tail":[] if passed else log.splitlines()[-32:]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ("status","exit_code","assertions","exact_rollback",
        "changed_after_rollback","production_break_bootstrap_covered","coverage_gaps","output_directory","failure_tail")}),
        flush=True)
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
