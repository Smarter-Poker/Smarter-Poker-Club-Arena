"""L03 cases for the existing MTT PostgreSQL Execution and real compose() fixture.

The caller owns cluster start, deadlines, evidence and unconditional close(). This
module owns only disposable case databases; it has no CLI or production route.
"""

from collections import Counter
import hashlib
import json
from pathlib import Path


FIXTURE = "scripts/ci/fixtures/mtt-break-authoring"
MIGRATION = "supabase/migrations/20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql"
PROBE = "scripts/dev/fixtures/mtt-blind-contract/authoring-native.sql"
ASSETS = {
    f"{FIXTURE}/authority-capture-0002.json",
    f"{FIXTURE}/authority-catalog-0002.json",
    f"{FIXTURE}/catalog-supplement.sql",
    f"{FIXTURE}/scope-authority.json",
    MIGRATION,
    PROBE,
}


def _literal(value):
    return "'" + value.replace("'", "''") + "'"


def authoring_inputs(root):
    root = Path(root).resolve()
    manifest_path = root / FIXTURE / "source-binding.json"
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("version") != 1 or set(manifest.get("files", {})) != ASSETS
            or manifest.get("native_assertions") != 25
            or manifest.get("marker") != "MTT_AUTHORING_BREAK_NATIVE_PASS"):
        raise ValueError("L03 authoring source binding shape changed")
    hashes = {str(manifest_path.relative_to(root)): hashlib.sha256(manifest_path.read_bytes()).hexdigest()}
    for relative, expected in manifest["files"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("L03 authoring source binding changed: " + relative)
        hashes[relative] = expected
    module = root / "scripts/ci/mtt_break_authoring_native.py"
    hashes[str(module.relative_to(root))] = hashlib.sha256(module.read_bytes()).hexdigest()
    return root, manifest, hashes


def _assert_capture(execution, database, root):
    raw = json.loads((root / FIXTURE / "authority-capture-0002.json").read_text())
    expected = json.loads((root / FIXTURE / "authority-catalog-0002.json").read_text())
    _, actual, _ = execution.sql(database, raw["query"], label="authoring-capture-readback")
    if json.loads(actual) != expected:
        raise RuntimeError("L03 actual table/function catalog differs from its captured authority")
    _assert_scope(execution, database, root)


def _assert_scope(execution, database, root):
    scope = json.loads((root / FIXTURE / "scope-authority.json").read_text())["row"]
    # Definition includes language, volatility, security and configuration. Rights
    # are compared independently, including grantor and grant option.
    grants = json.dumps(scope["grants"])
    query = """
SELECT pg_get_userbyid(p.proowner)=%s AND md5(p.prosrc)=%s
 AND md5(pg_get_functiondef(p.oid))=%s AND p.prosecdef
 AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=public']::text[]
 AND (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
   'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
   ORDER BY a.grantee::regrole::text,a.privilege_type)
   FROM aclexplode(p.proacl) a)=%s::jsonb
 FROM pg_proc p WHERE p.oid='public.fn_club_scope_ids(uuid)'::regprocedure;
""" % tuple(_literal(v) for v in (scope["owner"], scope["source_md5"], scope["definition_md5"], grants))
    _, actual, _ = execution.sql(database, query, label="authoring-scope-readback")
    if actual.strip() != "t":
        raise RuntimeError("L03 scope dependency authority differs from its capture")


def _unchanged(execution, database, before, catalog, label):
    if (before != execution.snapshot(database, label + "-data")
            or catalog != execution.catalog_snapshot(database, label + "-catalog")):
        raise RuntimeError("L03 data/catalog rollback mismatch: " + label)


def _preserved_catalog(execution, database, before):
    after = execution.catalog_snapshot(database, "authoring-supplement-preservation")
    for kind, rows in before.items():
        old = Counter(json.dumps(row, sort_keys=True) for row in (rows or []))
        new = Counter(json.dumps(row, sort_keys=True) for row in (after[kind] or []))
        if old - new:
            raise RuntimeError("L03 supplement overwrote an existing authority: " + kind)


def run_authoring_native(execution, source_root, composition, *, prepared_template,
                         preparation_sources):
    """Run original red, migration guards and 25 actual RPC checks.

    The existing caller applies all eight bound preparation migrations to its
    own template, then supplies that template and source pins. The authoring guard
    depends on the prepared pure raw-target classifier, never ABI activation.
    This module clones it; it never replaces its governed creator or replays prep.
    Existing Execution must already be started; its caller must close in finally.
    """
    root, manifest, hashes = authoring_inputs(source_root)
    if not prepared_template or not preparation_sources:
        raise ValueError("prepared authoring template requires source identities")
    receipt = {"status": "failed", "source_sha256": hashes, "limits": manifest["limits"],
               "composition_sha256": composition["source_sha256"], "refusals": [],
               "prepared_template": True}
    execution.report["break_authoring_prepared"] = receipt
    execution.report["source_sha256"].update(hashes)
    database = execution.database(template=prepared_template)
    supplement = (root / FIXTURE / "catalog-supplement.sql").read_text()
    receipt["preparation_sha256"] = dict(preparation_sources)
    # The projection preparation already contains the same captured scope
    # helper. Read it exactly and omit only its source-bound creation block;
    # never CREATE OR REPLACE a prepared function to satisfy an old fixture.
    _assert_scope(execution, database, root)
    marker = "DO $$ BEGIN IF to_regprocedure('public.fn_club_scope_ids(uuid)') IS NOT NULL"
    if supplement.count(marker) != 1 or not supplement.endswith("COMMIT;\n"):
        raise ValueError("source-bound scope supplement boundary changed")
    supplement = supplement.partition(marker)[0] + "COMMIT;\n"
    _, actual, _ = execution.sql(database, """
SELECT (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
   ='legacy-capacity-v1'
 AND (SELECT md5(prosrc) FROM pg_proc
  WHERE oid='public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure)
   ='9ff1b6c1c1396145d62face4867fbf0f';
""", label="authoring-prepared-creator-identity")
    if actual.strip() != "t":
        raise RuntimeError("L03 requires exact prepared legacy ABI and governed creator")
    original_catalog = execution.catalog_snapshot(database, "authoring-existing-authorities")
    execution.sql(database, supplement, label="authoring-real-dependencies")
    _preserved_catalog(execution, database, original_catalog)
    _assert_capture(execution, database, root)
    receipt["existing_authorities_preserved"] = True
    before = execution.snapshot(database, "authoring-before")
    catalog = execution.catalog_snapshot(database, "authoring-before-catalog")
    code, _, stderr = execution.sql(database, file=root / PROBE, label="authoring-original-red", check=False)
    expected_red = "AUTHORING FAIL: new manual MTT refuses ignored break rows"
    if code != 3 or stderr.count(expected_red) != 1:
        raise RuntimeError("L03 original acceptance defect was not reproduced")
    _unchanged(execution, database, before, catalog, "authoring-after-red")
    receipt["original_red"] = expected_red

    migration = (root / MIGRATION).read_text()
    capture = json.loads((root / FIXTURE / "authority-catalog-0002.json").read_text())
    schedule = next(f for f in capture["functions"] if f["signature"] == "fn_upsert_tournament_schedule(jsonb)")
    # Drift in the SECOND authority proves the first cannot be replaced before
    # validation completes. A postimage mismatch proves both replacements roll back.
    body = schedule["definition"]
    closing = "END; $function$"
    if body.count(closing) != 1:
        raise ValueError("captured schedule body delimiter changed")
    post_hash = "b8dd7cc8e0996889a936affdc732b664"
    if migration.count(post_hash) != 1:
        raise ValueError("L03 schedule postimage identity changed")
    cases = [
        ("target-classifier", """DO $fault$ DECLARE d text; b text; BEGIN
          SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
          WHERE oid='public.fn_ca_is_new_mtt(jsonb)'::regprocedure;
          EXECUTE replace(d,b,E'\\n-- isolated target classifier drift\\n'||b);
        END $fault$;""", migration, "MTT_AUTHORING_TARGET_CLASSIFIER_DRIFT"),
        ("body", body.replace(closing, "-- local source drift counterexample\n" + closing) + ";",
         migration, "MTT_AUTHORING_PREIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)"),
        ("acl", "GRANT EXECUTE ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) TO anon;",
         migration, "MTT_AUTHORING_PREIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)"),
        ("postimage", None, migration.replace(post_hash, "0" * 32),
         "MTT_AUTHORING_POSTIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)"),
    ]
    for name, drift, candidate, expected in cases:
        case = execution.database(template=database)
        if drift:
            execution.sql(case, drift, label="authoring-drift-" + name)
        case_data = execution.snapshot(case, "authoring-" + name + "-before")
        case_catalog = execution.catalog_snapshot(case, "authoring-" + name + "-before-catalog")
        code, _, stderr = execution.sql(case, candidate, label="authoring-refusal-" + name, check=False)
        if code != 3 or stderr.count(expected) != 1:
            raise RuntimeError("L03 migration did not refuse exact " + name + " drift")
        _unchanged(execution, case, case_data, case_catalog, "authoring-refused-" + name)
        execution.discard(case)
        receipt["refusals"].append({"case": name, "error": expected, "rollback": True})

    execution.sql(database, file=root / MIGRATION, label="authoring-candidate-migration")
    post_catalog = execution.catalog_snapshot(database, "authoring-candidate-catalog")
    _, stdout, stderr = execution.sql(database, file=root / PROBE, label="authoring-candidate-green")
    if stdout.splitlines().count(manifest["marker"]) != 1 or stderr.count("AUTHORING PASS:") != 25:
        raise RuntimeError("L03 authoring success marker or assertion count mismatch")
    _unchanged(execution, database, before, post_catalog, "authoring-after-green")
    execution.discard(database)
    if authoring_inputs(root)[2] != hashes:
        raise RuntimeError("L03 authoring input changed during execution")
    receipt.update(status="passed", native_assertions=25, rollback=True)
    return receipt
