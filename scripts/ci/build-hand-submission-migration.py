"""Render the guarded journal installation from exact current authorities."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20260918092329_retained_hand_submission_atomic_acknowledgement.sql"
CAPTURE = ROOT / "scripts/ci/fixtures/hand-submission/current-authorities-20260918.json"
AUTHORITY = ROOT / "scripts/ci/probes/hand-submission-authority.sql"

def lit(s):
    return "'" + s.replace("'", "''") + "'"

def render():
    rows = json.loads(CAPTURE.read_text())["capture"]["functions"]
    current = next(r for r in rows if r["signature"].startswith("fn_ca_commit_hand_settlement("))
    signature = "public." + current["signature"]
    definition = current["definition"]
    anchor = "  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);"
    assert definition.count(anchor) == 1
    keys = ["table_id","hand_number","stacks","rake","bbj","ref","inflow","hand_row","units","instance_id","lease_generation","post_commit_obligations"]
    expression = "jsonb_build_object(" + ",".join(lit("p_"+k)+",p_"+k for k in keys) + ")"
    successor = definition.replace(anchor, anchor+"\n  PERFORM smarter_private.assert_retained_hand_submission("+expression+");")
    result = """-- Preserve the original protocol-2 settlement request before dispatch.
-- The 2026-09-18 Spin refusal exposed a completed preflop snapshot but no
-- durable original request after a canonical XX000 rollback and engine kill.
-- New receipt-only continuation uses existing exact lease and financial owners.
-- Snapshot completion and accepted receipt commit together. No old hand is
-- reconstructed. A positive canonical failure can delegate the unchanged
-- original once to a verified successor; accepted postcommit remains replayable.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
"""
    result += "SELECT pg_advisory_xact_lock_shared(530090,1);\nDO $$ BEGIN IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'HAND_SUBMISSION_INSTALL_FROZEN'; END IF; END $$;\n"
    result += "LOCK TABLE smarter_private.f06_hand_permits,public.hand_state_snapshots IN SHARE ROW EXCLUSIVE MODE;\n"
    dependencies = {}
    for path in sorted((ROOT / "scripts/ci/fixtures/hand-submission").glob("*.json")):
        if path.name == "current-no-start-successor-20260918.json":
            continue
        for r in json.loads(path.read_text())["capture"].get("functions", []):
            old = dependencies.setdefault(r["signature"], r)
            if old != r:
                assert old["definition"] == r["definition"] and old["acl"] == r["acl"]
    # Preserve the predecessor capture; the independently read-back installed
    # no-start authority is the only declared successor of these two bodies.
    successor_capture = json.loads((ROOT / "scripts/ci/fixtures/hand-submission/current-no-start-successor-20260918.json").read_text())
    assert successor_capture["installedVersion"] == "20260918123246"
    allowed = {"smarter_private.f06_immutable_identity()", "smarter_private.f06_cancelled_preparation_writer_guard()"}
    replaced = set()
    for r in successor_capture["capture"]["functions"]:
        if r["signature"] in dependencies:
            assert r["signature"] in allowed
            assert dependencies[r["signature"]]["acl"] == r["acl"]
            replaced.add(r["signature"])
        dependencies[r["signature"]] = r
    assert replaced == allowed
    for r in dependencies.values():
        sig = r["signature"] if "." in r["signature"].split("(")[0] else "public."+r["signature"]
        result += "DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+lit(sig)+"::regprocedure AND md5(pg_get_functiondef(oid))="+lit(r["definition_md5"])+" AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM "+lit(r["acl"])+") THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %',"+lit(sig)+"; END IF; END $pin$;\n"
    for filename, key in [("current-f06-20260918.json", "permit_triggers"), ("current-maintenance-boundary-20260918.json", "triggers")]:
        capture = json.loads((ROOT / "scripts/ci/fixtures/hand-submission" / filename).read_text())["capture"]
        for trigger in capture[key]:
            definition = trigger["definition"]
            result += "DO $binding$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND pg_get_triggerdef(oid)="+lit(definition)+" AND tgenabled="+lit(trigger["enabled"])+") THEN RAISE EXCEPTION 'HAND_SUBMISSION_TRIGGER_DRIFT'; END IF; END $binding$;\n"
    result += "DO $absent$ BEGIN IF to_regclass('smarter_private.hand_submissions') IS NOT NULL OR to_regclass('smarter_private.hand_submission_dispositions') IS NOT NULL OR to_regprocedure('public.fn_ca_commit_hand_submission(uuid,text,uuid)') IS NOT NULL OR to_regprocedure('public.fn_ca_retain_hand_submission(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'HAND_SUBMISSION_ALREADY_INSTALLED'; END IF; END $absent$;\n"
    result += AUTHORITY.read_text()+"\n"+(ROOT/"scripts/ci/probes/hand-submission-successor.sql").read_text()+"\n"+successor.rstrip().rstrip(";")+";\n"
    result += "REVOKE ALL ON FUNCTION "+signature+" FROM PUBLIC,anon,authenticated;\nGRANT EXECUTE ON FUNCTION "+signature+" TO service_role;\nCOMMIT;\n"
    return result

if __name__ == "__main__":
    MIGRATION.write_text(render())
