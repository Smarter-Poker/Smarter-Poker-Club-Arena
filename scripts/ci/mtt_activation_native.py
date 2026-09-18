"""Actual R46 row-only activation cases in the existing owned PG17 Execution.

No standalone runner, production connection, application publisher or API bypass.
The existing driver owns process deadlines, signals, socket target and cleanup.
"""
import hashlib
import json
from pathlib import Path

from mtt_isolation_results import validate_case_result
from mtt_unlimited_fixture import preparation_supplement_sql
from satellite_qualifier_fixture import compose as financial_compose, function_sql
from mtt_break_authoring_native import authoring_inputs, _assert_scope, _assert_capture, _preserved_catalog

FIXTURE = "scripts/ci/fixtures/mtt-format-activation"
GUARD = "supabase/migrations/20260917232232_mtt_activation_guard_preparation.sql"
ACTIVATION = "supabase/migrations/20260917232311_mtt_activate_unlimited_admission.sql"
L03 = "supabase/migrations/20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql"
L04 = "supabase/migrations/20260917201651_satellite_multi_qualifier_receipt_v3.sql"
MONEY_GUARD = "scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_inputs(e):
    path = e.root / FIXTURE / "source-binding.json"
    manifest = json.loads(path.read_text())
    if manifest.get("version") != 1 or manifest.get("mode") != "activation":
        raise ValueError("actual activation manifest required")
    required = {GUARD, ACTIVATION, L03, L04, MONEY_GUARD, FIXTURE + "/prepared-authorities.json",
                FIXTURE + "/active-index.sql", "scripts/ci/mtt_activation_native.py"}
    required.update(FIXTURE + "/" + name for name in ("current-dependencies-20260917.json", "transition.sql", "funded-hu-before.sql", "funded-hu-after.sql"))
    required.update("scripts/ci/probes/mtt-activation/" + case.replace("_", "-") + ".spec" for case in TRANSITION_CASES)
    if not required.issubset(manifest.get("files", {})):
        raise ValueError("activation manifest omits actual production/fixture inputs")
    for name, sha in manifest["files"].items():
        source = (e.root / name).resolve()
        if (Path(name).is_absolute() or not source.is_relative_to(e.root)
                or digest(source) != sha):
            raise ValueError("activation source binding changed: " + name)
        e.report["source_sha256"][name] = sha
    e.report["source_sha256"][str(path.relative_to(e.root))] = digest(path)
    return manifest


def catalog_snapshot(e, database, label):
    value = e.catalog_snapshot(database, label)
    _, events, _ = e.sql(database, """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',e.evtname,'tags',e.evttags,'event',e.evtevent,'owner',pg_get_userbyid(e.evtowner),
      'enabled',e.evtenabled,'function',e.evtfoid::regprocedure::text) ORDER BY e.evtname),'[]')
      FROM pg_event_trigger e;""", label=label + "-event-guards")
    value["event_triggers"] = json.loads(events)
    return value


def load_money_ddl_guard(e, database):
    capture = json.loads((e.root / MONEY_GUARD).read_text())
    expected = [{"name": "ab_ca_money_rpc_registered", "tags": ["CREATE FUNCTION"],
        "event": "ddl_command_end", "owner": "postgres", "enabled": "O",
        "function": "fn_ca_money_rpc_registry_guard()"}]
    if capture["event_triggers"] != expected or {r["signature"] for r in capture["functions"]} != {
        "fn_ca_money_rpc_balance_columns()", "fn_ca_money_rpc_registry_guard()",
        "fn_ca_money_rpc_writes_balances(text)",
    }:
        raise ValueError("exact current money-DDL capture changed")
    for row in capture["functions"]:
        e.sql(database, "DO $$ BEGIN IF to_regprocedure('public." + row["signature"] +
              "') IS NOT NULL THEN RAISE EXCEPTION 'money-DDL guard must be absent before supplement'; "
              "END IF; END $$;\n" + function_sql(row), label="actual-money-DDL-function")
    e.sql(database, "CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end "
          "WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();",
          label="actual-money-DDL-event")
    if catalog_snapshot(e, database, "money-DDL-readback")["event_triggers"] != expected:
        raise RuntimeError("actual money-DDL event attachment differs")


def assert_unchanged(e, database, data, catalog, label):
    if data != e.snapshot(database, label + "-data"):
        raise RuntimeError("activation case changed data unexpectedly: " + label)
    if catalog != catalog_snapshot(e, database, label + "-catalog"):
        raise RuntimeError("activation case changed catalog unexpectedly: " + label)


def assert_present_capture(e, database, capture, label):
    # Financial closure contains the actual successor already. Require its exact
    # current identity instead of overwriting it with the retained predecessor.
    for row in capture["rows"]:
        signature = "public." + row["signature"]
        grants = sorted(row["grants"], key=lambda g: (g["grantee"], g["privilege_type"]))
        _, value, _ = e.sql(database, """SELECT jsonb_build_object(
 'source_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),
 'owner',pg_get_userbyid(p.proowner),'grants',
 (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'grantor',pg_get_userbyid(a.grantor),'is_grantable',a.is_grantable,'privilege_type',a.privilege_type)
 ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type)
 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a))
 FROM pg_proc p WHERE p.oid=to_regprocedure('""" + signature + "');", label=label)
        expected = {key: row[key] for key in ("source_md5", "definition_md5", "owner")}
        expected["grants"] = grants
        if json.loads(value) != expected:
            raise RuntimeError("actual installed successor differs from captured source/ACL")


def compose_template(e, catalog):
    f = financial_compose(e.root)
    e.report["source_sha256"].update(f["source_sha256"])
    e.report["retained_preimage_capture_limits"] = f["limits"]
    e.start()
    database = e.database()
    sql = e.output / "actual-financial-foundation.sql"
    sql.write_text(f["sql"])
    e.sql(database, file=sql, label="actual-current-financial-foundation", seconds=180)
    e.sql(database, f["entry_sql"], label="actual-current-entry-close")
    assert_present_capture(e, database, json.loads((e.root / catalog["fixtures"][0]["path"]).read_text()),
                           "actual-current-satellite-successor")
    registry = json.loads((e.root / "scripts/ci/fixtures/mtt-format-preparation/overlay-registry-20260917.json").read_text())["rows"][0]["row"]
    _, value, _ = e.sql(database, "SELECT to_jsonb(r) FROM public.ca_chip_store_coverage r WHERE store='club_treasury';",
                        label="actual-current-overlay-registry")
    if json.loads(value) != registry:
        raise RuntimeError("actual captured club_treasury declaration changed")
    supplement = preparation_supplement_sql(e.root, [x for x in catalog["fixtures"][1:] if x["kind"] != "registry"])
    sql = e.output / "remaining-preparation-supplements.sql"
    sql.write_text(supplement)
    e.sql(database, file=sql, label="remaining-preparation-supplements", seconds=180)
    for stage in catalog["stages"]:
        e.sql(database, file=e.root / stage["migration"]["path"], label="prepare-" + stage["id"])
    _, _, hashes = authoring_inputs(e.root)
    e.report["source_sha256"].update(hashes)
    _assert_scope(e, database, e.root)
    supplement = (e.root / "scripts/ci/fixtures/mtt-break-authoring/catalog-supplement.sql").read_text()
    seam = "DO $$ BEGIN IF to_regprocedure('public.fn_club_scope_ids(uuid)') IS NOT NULL"
    if supplement.count(seam) != 1 or not supplement.endswith("COMMIT;\n"):
        raise ValueError("exact shared scope boundary changed")
    before = e.catalog_snapshot(database, "before-authoring-supplement")
    e.sql(database, supplement.partition(seam)[0] + "COMMIT;\n", label="actual-authoring-dependencies")
    _preserved_catalog(e, database, before)
    _assert_capture(e, database, e.root)
    e.sql(database, file=e.root / L03, label=Path(L03).stem)
    load_money_ddl_guard(e, database)
    for path in (L04, FIXTURE + "/active-index.sql"):
        e.sql(database, file=e.root / path, label=Path(path).stem)
    load_current_dependencies(e, database)
    return database


def refusal(e, template, label, mutation, text, expected):
    database = e.database(template)
    if mutation:
        e.sql(database, mutation, label="fixture-only-" + label)
    data = e.snapshot(database, label + "-before-data")
    catalog = catalog_snapshot(e, database, label + "-before-catalog")
    code, _, stderr = e.sql(database, text, label=label, check=False)
    if code != 3 or stderr.count(expected) != 1:
        raise RuntimeError("exact activation refusal not proven: " + label)
    assert_unchanged(e, database, data, catalog, label + "-rollback")
    e.discard(database)
    e.report["migration_refusals"].append({"case": label, "error": expected, "exact_data_catalog_rollback": True})


def activate(e, database, label):
    before = e.snapshot(database, label + "-before-data")
    catalog = catalog_snapshot(e, database, label + "-before-catalog")
    e.sql(database, file=e.root / ACTIVATION, label=label)
    _, actual, _ = e.sql(database, "SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton;", label=label + "-readback")
    if actual.strip() != "unlimited-mtt-v2":
        raise RuntimeError("actual activation did not persist unlimited ABI")
    after = e.snapshot(database, label + "-after-data")
    if before.pop("public.ca_mtt_admission_contract") == after.pop("public.ca_mtt_admission_contract") or before != after:
        raise RuntimeError("activation must change only its singleton ABI row")
    if catalog != catalog_snapshot(e, database, label + "-after-catalog"):
        raise RuntimeError("activation changed catalog instead of only its ABI row")
    e.report.setdefault("activations", []).append({"label": label, "only_abi_row_changed": True, "catalog_unchanged": True})


def actual_satellite_races(e, template, catalog, binary):
    group = next(g for g in catalog["preparation_races"] if g["mode"] == "synthetic_future")
    fixture = (e.root / group["fixture"]["path"]).read_text()
    seam = "UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';\n"
    if fixture.count(seam) != 1:
        raise ValueError("retained satellite fixture activation seam changed")
    # Historical seed construction remains synthetic; the ABI no longer is.
    # Every case executes the unchanged production row-only transaction under
    # origin triggers before invoking its exact retained stock race.
    fixture = fixture.replace(seam, "")
    for entry in group["cases"]:
        database = e.database(template)
        label = "actual-activation-" + entry["case"]
        e.sql(database, fixture, label=label + "-historical-input")
        activate(e, database, label + "-activate")
        spec = (e.root / entry["path"]).read_text()
        code, stdout, stderr = e.run(label, [binary,
            f"host={e.socket} port={e.port} user=postgres dbname={database}"], text=spec, seconds=40, check=False)
        result = validate_case_result(entry, spec, stdout=stdout, stderr=stderr, returncode=code)
        e.discard(database)
        e.report["races"].append({"case": entry["case"], "mode": "actual_activation", "result": result,
                                  "row_only_activation": True, "database_removed": True})


def run_activation(e, driver):
    manifest = source_inputs(e)
    catalog = driver.preparation_inputs(e)
    e.report["fixture_limits"] = [
        "Only the new private socket PG17 cluster is mutated; no production activation or release occurs.",
        "Synthetic historical/roster inputs are identified; actual activation always runs origin triggers.",
        "Remote compatible engine publication and old-writer retirement remain release prerequisites outside SQL proof.",
    ]
    template = compose_template(e, catalog)
    guard = (e.root / GUARD).read_text()
    transaction = (e.root / ACTIVATION).read_text()
    refusal(e, template, "old-guard-refuses", None,
            "BEGIN; UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2'; COMMIT;",
            "MTT_ADMISSION_ACTIVATION_NOT_PREPARED")
    before_data = e.snapshot(template, "guard-preparation-before-data")
    before_catalog = catalog_snapshot(e, template, "guard-preparation-before-catalog")
    e.sql(template, file=e.root / GUARD, label="prepare-activation-guard")
    if before_data != e.snapshot(template, "guard-preparation-after-data"):
        raise RuntimeError("activation guard preparation rewrote existing rows")
    after_catalog = catalog_snapshot(e, template, "guard-preparation-after-catalog")
    before_functions = before_catalog.pop("functions")
    after_functions = after_catalog.pop("functions")
    guard_name = "fn_ca_guard_mtt_admission_contract()"
    if (before_catalog != after_catalog
            or [r for r in before_functions if r[1] != guard_name] != [r for r in after_functions if r[1] != guard_name]
            or len([r for r in after_functions if r[1] == guard_name]) != 1):
        raise RuntimeError("activation preparation changed authority beyond its existing guard")
    refusal(e, template, "authority-drift", "ALTER FUNCTION public.fn_ca_is_new_mtt(jsonb) SET statement_timeout='1s';", transaction,
            "MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_is_new_mtt(jsonb)")
    refusal(e, template, "acl-drift", "GRANT EXECUTE ON FUNCTION public.fn_ca_satellite_cohort_receipt(uuid,uuid[]) TO anon;", transaction,
            "MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_satellite_cohort_receipt(uuid,uuid[])")
    refusal(e, template, "trigger-drift", "ALTER TABLE public.tournaments DISABLE TRIGGER tournaments_rank_before_complete;", transaction,
            "MTT_ACTIVATION_TRIGGER_DRIFT: tournaments.tournaments_rank_before_complete")
    refusal(e, template, "constraint-drift", "ALTER TABLE public.tournament_satellite_settlements DROP CONSTRAINT tournament_satellite_settlements_receipt_version_check;", transaction,
            "MTT_ACTIVATION_CONSTRAINT_DRIFT: tournament_satellite_settlements.tournament_satellite_settlements_receipt_version_check")
    refusal(e, template, "guard-disabled", "ALTER TABLE public.ca_mtt_admission_contract DISABLE TRIGGER ca_mtt_admission_contract_immutable;", transaction,
            "MTT_ACTIVATION_GUARD_ATTACHMENT_DRIFT")
    refusal(e, template, "guard-security-drift", "ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() SECURITY INVOKER;", transaction,
            "MTT_ACTIVATION_GUARD_IDENTITY_DRIFT")
    refusal(e, template, "money-event-drift", "ALTER EVENT TRIGGER ab_ca_money_rpc_registered DISABLE;", transaction,
            "MTT_ACTIVATION_EVENT_GUARD_DRIFT: ab_ca_money_rpc_registered")
    refusal(e, template, "cohort-registry-drift", "UPDATE public.ca_money_rpc_registry SET status='system' WHERE proname='fn_ca_settle_satellite_cohort';", transaction,
            "MTT_ACTIVATION_COHORT_REGISTRY_DRIFT")
    refusal(e, template, "api-cannot-activate", None,
            "BEGIN; SET LOCAL ROLE service_role; UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2'; COMMIT;",
            "permission denied for table ca_mtt_admission_contract")
    refusal(e, template, "unknown-active-parent", """BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,status,start_time,buy_in_amount,buy_in_fee)
      VALUES('46468300-0000-4000-8000-000000000001','Unqualified historical parent','MTT','freezeout',100,3,'REGISTERING',now(),0,0);
      SET LOCAL session_replication_role=origin; COMMIT;""", transaction,
            "MTT_ACTIVATION_ACTIVE_FORMAT_UNQUALIFIED")
    refusal(e, template, "maintenance-freeze", """INSERT INTO public.engine_maintenance_break(id,phase,enforce_freeze,announced_at,ownership_token)
      VALUES(true,'last_hand',true,clock_timestamp(),'46468300-0000-4000-8000-000000000002');""", transaction,
            "MTT_ACTIVATION_MAINTENANCE_FROZEN")
    refusal(e, template, "missing-contract", """BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.ca_mtt_admission_contract; SET LOCAL session_replication_role=origin; COMMIT;""", transaction,
            "MTT_ACTIVATION_EXPECTED_EXACTLY_ONE_LEGACY_CONTRACT")
    database = e.database(template)
    activate(e, database, "actual-row-only-activation")
    for name, statement in (("reverse", "UPDATE public.ca_mtt_admission_contract SET abi='legacy-capacity-v1'"),
                            ("delete", "DELETE FROM public.ca_mtt_admission_contract"),
                            ("truncate", "TRUNCATE public.ca_mtt_admission_contract")):
        refusal(e, database, "immutable-" + name, None, "BEGIN;" + statement + ";COMMIT;", "MTT_ADMISSION_CONTRACT_IMMUTABLE")
    e.discard(database)
    binary = driver.stock_isolationtester(e.pg)
    e.report["isolationtester_sha256"] = digest(binary)
    actual_satellite_races(e, template, catalog, binary)
    actual_transition_races(e, template, catalog, binary)
    funded_hu_continuity(e, template)
    e.discard(template)
    for path, expected in e.report["source_sha256"].items():
        if digest(e.root / path) != expected:
            raise RuntimeError("activation input changed during execution: " + path)
    e.report["source_binding_verified_at_completion"] = True

TRANSITION_CASES = tuple(f"{operation}_{ordering}_{outcome}"
    for operation in ("creator", "admission")
    for ordering in ("legacy_first", "activation_first")
    for outcome in ("commit", "rollback"))


def transition_spec(case):
    if case not in TRANSITION_CASES:
        raise ValueError("unknown actual activation transition")
    op = "create_event" if case.startswith("creator_") else "enter_event"
    first = "activation_first" in case
    a = "activate()" if first else op + "('a')"
    b = op + "('b')" if first else "activate()"
    finish = "ROLLBACK" if case.endswith("rollback") else "COMMIT"
    result = "# Actual row-only activation versus an existing owning creator/admission.\n"
    result += "setup { SELECT r46_activation.pristine(); }\n"
    for actor, action, end in (("a", a, finish), ("b", b, "COMMIT")):
        result += f'''session "{actor}"
setup {{
 SET application_name='r46-mtt-{actor}';
 SET statement_timeout='8s';
 SET lock_timeout='3s';
 SET idle_in_transaction_session_timeout='15s';
 SET session_replication_role=origin;
 INSERT INTO r46_mtt_isolation.connections VALUES('{actor}',pg_backend_pid());
}}
step "{actor}_begin" {{ BEGIN ISOLATION LEVEL READ COMMITTED; }}
step "{actor}_action" {{ SELECT r46_activation.{action}; }}
step "{actor}_finish" {{ {end}; }}
teardown {{ ROLLBACK; }}
'''
    result += f'''session "observer"
setup {{ SET application_name='r46-mtt-observer'; SET statement_timeout='8s'; }}
step "observed_wait" {{ SELECT r46_activation.blocked('a','b'); }}
step "final_state" {{ SELECT r46_activation.verify_final('{case}'); }}
permutation "a_begin" "a_action" "b_begin" "b_action" "observed_wait" "a_finish" "b_finish" "final_state"
'''
    return result


def validate_transition(case, spec, code, stdout, stderr):
    # Same strict PG17 transcript semantics as the maintained six-case consumer.
    # No exit-zero-only, forced (*) wait, ignored SQL ERROR, or marker-only pass.
    import re
    from mtt_isolation_results import _Transcript
    if spec != transition_spec(case):
        raise ValueError("actual transition spec differs from its exact contract")
    if (type(code) is not int or code != 0 or stderr != "" or not stdout
            or len(stdout) > 1024 * 1024 or not stdout.endswith("\n")
            or any(ord(c) < 32 and c != "\n" or ord(c) == 127 for c in stdout)):
        raise ValueError("actual transition process did not produce complete clean output")
    steps = dict(re.findall(r'^step "([a-z_]+)" \{ (.*) \}$', spec, re.M))
    sequence = ["a_begin", "a_action", "b_begin", "b_action", "observed_wait", "a_finish", "b_finish", "final_state"]
    t = _Transcript(stdout)
    t.expect("Parsed test spec with 3 sessions")
    t.expect("starting permutation: " + " ".join(sequence))
    t.void_result("pristine")
    def complete(name, resumed=False):
        t.expect("step " + name + ": " + ("<... completed>" if resumed else steps[name]))
        if steps[name].startswith("SELECT "):
            t.void_result(steps[name].split(".")[1].split("(")[0])
    for name in sequence[:3]:
        complete(name)
    t.expect("step b_action: " + steps["b_action"] + " <waiting ...>")
    complete("observed_wait")
    complete("a_finish")
    complete("b_action", True)
    complete("b_finish")
    marker = "observer: NOTICE:  MTT ACTUAL ACTIVATION TRANSITION COMPLETE: " + case
    before = t.peek() == marker
    if before:
        t.expect(marker)
    t.expect("step final_state: " + steps["final_state"])
    if not before:
        t.expect(marker)
    t.void_result("verify_final")
    for actor in ("a", "b"):
        t.expect(actor + ": WARNING:  there is no transaction in progress")
    if t.peek() is not None:
        raise ValueError("unexpected trailing actual transition output")
    return {"case": case, "status": "transcript_accepted", "observed_wait": True,
            "spec_sha256": hashlib.sha256(spec.encode()).hexdigest(),
            "stdout_sha256": hashlib.sha256(stdout.encode()).hexdigest()}


def actual_transition_races(e, template, catalog, binary):
    group = next(g for g in catalog["preparation_races"] if g["mode"] == "legacy")
    base_fixture = (e.root / group["fixture"]["path"]).read_text()
    fixture = (e.root / FIXTURE / "transition.sql").read_text()
    activation = (e.root / ACTIVATION).read_text()
    begin, end = "DO $activate$", "END $activate$;"
    if activation.count(begin) != 1 or activation.count(end) != 1:
        raise ValueError("actual row-only activation body boundary changed")
    do = begin + activation.split(begin, 1)[1].split(end, 1)[0] + end
    # The isolation actor supplies the same READ COMMITTED transaction and
    # bounded lock/statement settings. This private fixture wrapper executes
    # the exact production DO statement after the same maintenance lock.
    wrapper = """CREATE FUNCTION r46_activation.activate() RETURNS void LANGUAGE plpgsql AS $wrapper$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 LOCK TABLE public.ca_mtt_admission_contract IN ROW EXCLUSIVE MODE;
 EXECUTE $actual$""" + do + """$actual$;
END $wrapper$;"""
    if fixture.count("-- @ACTUAL_ROW_ACTIVATION@") != 1 or fixture.count("@INITIAL_COUNT@") != 1:
        raise ValueError("actual transition fixture seams changed")
    for case in TRANSITION_CASES:
        database = e.database(template)
        e.sql(database, base_fixture, label=case + "-base-input")
        case_fixture = fixture.replace("-- @ACTUAL_ROW_ACTIVATION@", wrapper).replace(
            "@INITIAL_COUNT@", "3" if "activation_first" in case else "2")
        e.sql(database, case_fixture, label=case + "-input")
        path = e.root / "scripts/ci/probes/mtt-activation" / (case.replace("_", "-") + ".spec")
        spec = path.read_text()
        code, stdout, stderr = e.run(case, [binary,
            f"host={e.socket} port={e.port} user=postgres dbname={database}"], text=spec, seconds=35, check=False)
        result = validate_transition(case, spec, code, stdout, stderr)
        e.discard(database)
        e.report["races"].append({"case": case, "mode": "actual_activation_transition",
            "result": result, "database_removed": True})


def load_current_dependencies(e, database):
    import re
    path = e.root / FIXTURE / "current-dependencies-20260917.json"
    capture = json.loads(path.read_text())
    if {r["signature"] for r in capture["rows"]} != {
        "fn_entry_purchases_frozen()", "fn_active_maintenance_release_boundary()",
        "fn_accounting_terms_at(text,text,timestamp with time zone)",
        "fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)",
    }:
        raise ValueError("bounded current dependency capture changed")
    for row in capture["rows"]:
        definition = row["definition"]
        tag = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", definition)
        if tag is None:
            raise ValueError("current dependency has no source delimiter")
        body = definition[tag.end():definition.index(tag[1], tag.end())]
        if (hashlib.md5(definition.encode()).hexdigest() != row["definition_md5"]
                or hashlib.md5(body.encode()).hexdigest() != row["source_md5"]):
            raise ValueError("current dependency definition identity changed")
        expected = row["fixture_predecessor"]
        signature = "public." + row["signature"]
        _, actual, _ = e.sql(database, """SELECT jsonb_build_object('source_md5',md5(p.prosrc),
          'definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),
          'acl',(SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner)))a))
          FROM pg_proc p WHERE p.oid='""" + signature + "'::regprocedure;", label="current-dependency-preimage")
        if json.loads(actual) != expected:
            raise RuntimeError("exact current dependency fixture predecessor changed: " + signature)
        if expected["definition_md5"] != row["definition_md5"]:
            # CREATE OR REPLACE preserves the verified owner/ACL. Only these
            # two captured financial helpers have a newer installed body.
            if not signature.startswith("public.fn_accounting_"):
                raise RuntimeError("maintenance capture must already equal the native baseline")
            if expected["acl"] != sorted(g["grantee"] + "=X/" + g["grantor"] for g in row["grants"]):
                raise RuntimeError("current captured accounting helper rights changed")
            e.sql(database, definition + ";", label="actual-current-accounting-terms")
    assert_present_capture(e, database, capture, "current-dependency-readback")


def funded_hu_continuity(e, template):
    database = e.database(template)
    for phase in ("before", "after"):
        if phase == "after":
            activate(e, database, "funded-legacy-HU-actual-activation")
            before = e.snapshot(database, "funded-HU-before-replay-data")
            catalog = catalog_snapshot(e, database, "funded-HU-before-replay-catalog")
        code, stdout, stderr = e.sql(database, file=e.root / FIXTURE / ("funded-hu-" + phase + ".sql"),
                                    label="funded-HU-" + phase, check=False)
        marker = "MTT_ACTIVATION_FUNDED_HU_" + phase.upper() + "_PASS"
        if code != 0 or stdout.splitlines().count(marker) != 1 or stderr != "":
            raise RuntimeError("exact real funded legacy HU continuity not proven: " + phase)
        if phase == "after":
            assert_unchanged(e, database, before, catalog, "funded-HU-replay")
    e.discard(database)
    e.report["native"].append({"case": "funded_legacy_HU_launch_receipt_across_activation",
                               "real_treasury_overlay": 20, "exact_receipt_money_replay": True,
                               "database_removed": True})
