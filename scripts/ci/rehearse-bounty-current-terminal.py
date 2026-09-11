#!/usr/bin/env python3
"""Compose real current bounty generation and terminal acceptance in owned PG17.

The existing final-deal composer supplies the owned 15-user/12-event baseline
check, narrow current terminal runtime and one outer rollback transaction. Its
extra 87-prefixed event is an unused synthetic dependency fixture, not a played
or completed event in this test. The existing bounty composer supplies its
five previously reviewed rebuy/payment cases. No broad M5/M6 migration runs.
Only main() executes SQL. --compose-only performs source composition only.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

PROBE = "scripts/ci/probes/bounty-current-terminal-native.sql"
BOUNTY_RUNNER = "scripts/ci/rehearse-current-bounty-mystery-lifecycle.py"
FINAL_RUNNER = "scripts/ci/rehearse-final-deal-current-terminal.py"
M7 = "supabase/migrations/20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql"
ROLLING = "supabase/migrations/20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql"
SWEEP = "supabase/migrations/20260910174349_the_bounty_sweep_takes_one_tournament_lane_per_call.sql"
FELT = "supabase/migrations/20260910002804_the_felt_decides_who_busted.sql"
LEDGER = "supabase/migrations/20260910130421_a_revealed_mystery_bounty_may_name_its_own_obligation.sql"
EXACT_SOURCES = {
    FELT: "d3182320e289a832f8aeb2804e6cd8cd9314d8d20bfbf7c862338261fce4868e",
    LEDGER: "2236fdbd5ce9f765dba5e9e5dc2cdb5ae5590f6e3b1f5e5180145b9918b9d400",
    M7: "27cf35a8b9cb3c7322265b755d0ec42f0d3feceb12dd4917e14589375b4c7036",
    ROLLING: "bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b",
    SWEEP: "0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17",
}
CLAIM_ARGS = "uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean"
OWNED_BOUNTY_GUARD = """DO $owned_baseline$ BEGIN
 IF current_database()<>'full_stage1' OR current_user<>'postgres'
    OR inet_server_addr() IS NOT NULL
    OR (SELECT count(*) FROM auth.users)<>15
    OR (SELECT count(*) FROM public.tournaments)<>12
    OR EXISTS(SELECT 1 FROM public.tournaments WHERE id::text LIKE 'b7200000-%')
 THEN RAISE EXCEPTION 'requires the retained exclusively owned full_stage1 baseline'; END IF;
END; $owned_baseline$;
"""
PROBE_HEADER = "-- Run as postgres only on a disposable production-shape PostgreSQL 17 clone"
EXTRA_TABLES = (
    "public.tournament_terminal_settlements", "public.tournament_finish_receipts",
    "public.tournament_bounty_completion_receipts",
    "public.tournament_mystery_activation_receipts", "public.tournament_rake_settlements",
    "public.tournament_guarantee_overlays", "public.unions",
)


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("expected one exact composition marker: " + old[:100])
    return source.replace(old, new, 1)


def section(text, name):
    start = "-- BEGIN BOUNTY TERMINAL " + name
    end = "-- END BOUNTY TERMINAL " + name
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError("terminal probe sections changed: " + name)
    return text.split(start, 1)[1].split(end, 1)[0]


def narrow_authorities(root, bounty):
    sources = {}
    for relative, expected in EXACT_SOURCES.items():
        text = (root / relative).read_text()
        if digest(text) != expected:
            raise ValueError("reviewed narrow source changed: " + relative)
        sources[relative] = text
    m5 = bounty.source(root, bounty.M5)
    claimant_name = "fn_claim_tournament_bounty_elimination"
    private_name = claimant_name + "_pre_seat_guard"
    private = bounty.definition(m5, claimant_name)
    if bounty.body_hash(private) != "876456f79250a307292dc6f2ae1564f3":
        raise ValueError("reviewed exact-hand claimant source changed")
    # Header-only substitution mirrors M7's private authority expansion while
    # retaining every exact-hand and entry-generation check in the body.
    private = once(private, "FUNCTION public." + claimant_name + "(",
                   "FUNCTION public." + private_name + "(")
    wrapper = bounty.definition(sources[M7], claimant_name)
    if bounty.body_hash(wrapper) != "b9e73a0752c87b13b2261542ae9fa2e3":
        raise ValueError("reviewed M7 seat-authorized claimant source changed")
    sql = private + "\n" + wrapper + "\n"
    for name in (private_name, claimant_name):
        sql += ("REVOKE ALL ON FUNCTION public." + name + "(" + CLAIM_ARGS +
                ") FROM PUBLIC,anon,authenticated,service_role;\n")
    sql += ("GRANT EXECUTE ON FUNCTION public." + claimant_name + "(" + CLAIM_ARGS +
            ") TO service_role;\n")
    expected_bodies = {
        claimant_name + "(" + CLAIM_ARGS + ")": "b9e73a0752c87b13b2261542ae9fa2e3",
        private_name + "(" + CLAIM_ARGS + ")": "876456f79250a307292dc6f2ae1564f3",
    }
    # The rolling helper takes G shared and T(id) exclusive. These exact
    # current trigger bodies accept that event-local proof. No trigger is
    # disabled and no authorization condition is removed for the test.
    for name, expected in (
        ("fn_tournament_live_seat_acquisition_requires_authority", "5a60bdd761aaaaad4b3bf982a3c50f6e"),
        ("fn_satellite_target_player_provenance_is_immutable", "266a6b06f5cc44bc953ca4c31933d7db"),
        ("fn_tournament_payouts_are_append_only", "6cfe150a2a360d878c9c389499e7b196"),
    ):
        text = bounty.definition(sources[ROLLING], name)
        if bounty.body_hash(text) != expected:
            raise ValueError("reviewed current rolling guard changed: " + name)
        sql += text + "\n"
        expected_bodies[name + "()"] = expected
    name = "fn_sweep_pending_tournament_bounties"
    sweep = bounty.definition(sources[SWEEP], name)
    if bounty.body_hash(sweep) != "9a16c59eb58695facd75a2d7406b7c28":
        raise ValueError("reviewed current per-event bounty sweep changed")
    sql += sweep + "\n"
    sql += "REVOKE ALL ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;\n"
    sql += "GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) TO service_role;\n"
    expected_bodies[name + "(uuid,integer)"] = "9a16c59eb58695facd75a2d7406b7c28"
    # Retain the actual current ledger and felt-first assignment after the
    # imported generation composer expands its older M6 dependencies.
    ledger = bounty.definition(sources[LEDGER], "fn_attach_bounty_ledger_obligation")
    if bounty.body_hash(ledger) != "e2028269240a041e38fdc1cb0853e64f":
        raise ValueError("reviewed current bounty ledger changed")
    sql += ledger + "\n"
    expected_bodies["fn_attach_bounty_ledger_obligation()"] = "e2028269240a041e38fdc1cb0853e64f"

    def felt_expression(name):
        match = re.search(r"\b" + name + r" := (.*?);\n", sources[FELT], re.S)
        if match is None:
            raise ValueError("reviewed felt assignment expression changed: " + name)
        value = match.group(1)
        tokens = list(re.finditer(r"(E?)'((?:''|[^'])*)'", value))
        remainder = re.sub(r"E?'(?:''|[^'])*'", "", value)
        if not re.fullmatch(r"[\s|]*", remainder):
            raise ValueError("felt assignment is no longer literal composition")
        return "".join(token.group(2).replace("''", "'").replace("\\n", "\n")
                       if token.group(1) else token.group(2).replace("''", "'")
                       for token in tokens)

    assignment = bounty.definition(bounty.helper_sql(root), "fn_ca_assign_tournament_player_seat_locked")
    for old, new in (("v_da", "v_db"), ("v_a", "v_b")):
        assignment = once(assignment, felt_expression(old), felt_expression(new))
    if bounty.body_hash(assignment) != "16a587f7567336fe4379135f22e3fb41":
        raise ValueError("reviewed current felt-first assignment differs")
    sql += assignment + "\n"
    expected_bodies["fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)"] = "16a587f7567336fe4379135f22e3fb41"
    for identity, expected in expected_bodies.items():
        # The tracked payout append-only trigger intentionally runs as invoker.
        # Match its actual authority instead of assuming every trigger is a
        # definer. The full source file and exact body remain pinned above.
        definer = identity != "fn_tournament_payouts_are_append_only()"
        sql += ("DO $bounty_runtime_source$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc"
                " WHERE oid=to_regprocedure('public." + identity + "')"
                " AND md5(prosrc)='" + expected + "' AND proowner='postgres'::regrole"
                " AND prosecdef IS " + ("TRUE" if definer else "FALSE") +
                ") THEN RAISE EXCEPTION 'reviewed bounty authority differs: "
                + identity + "'; END IF; END $bounty_runtime_source$;\n")
    return sql


def compose(root):
    bounty = module(root / BOUNTY_RUNNER, "bounty_terminal_generation")
    native = module(root / FINAL_RUNNER, "bounty_terminal_runtime")
    companion = (root / PROBE).read_text()
    fixture = section(companion, "FIXTURE")
    exercise = section(companion, "EXERCISE")
    sql = bounty.compose(root)
    # The final composer owns the original baseline check before its synthetic
    # extra event. Remove only this exact duplicate 12-event check, not an
    # arbitrary DO block or any financial/source precondition.
    sql = once(sql, OWNED_BOUNTY_GUARD, "")
    if not sql.startswith("BEGIN;\n") or not sql.endswith("ROLLBACK;\n"):
        raise ValueError("bounty source lost its exact outer transaction")
    sql = sql[len("BEGIN;\n"):-len("ROLLBACK;\n")]
    if sql.count(PROBE_HEADER) != 1:
        raise ValueError("original generation fixture header changed")
    dependencies, original_probe = sql.split(PROBE_HEADER, 1)
    original_probe = PROBE_HEADER + original_probe
    generation_path = "supabase/migrations/20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation.sql"
    original_generation = bounty.source(root, generation_path)
    original_generation = once(once(original_generation, "BEGIN;", ""), "COMMIT;", "")
    candidate = (root / "scripts/deploy/phase-three-bounty-rebuy-generation.sql").read_text()
    candidate = once(once(candidate, "\nBEGIN;\n", "\n"), "\nCOMMIT;\n", "\n")
    lane = json.loads((root / "docs/audits/2026-09-10-native-current-settlement-lane.json").read_text())
    if lane["signature"] != "fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)" or bounty.body_hash(lane["definition"]) != "3acb4c1d763181905cf5b64287f8f28f":
        raise ValueError("reviewed current rolling lane capture changed")
    current_lane = lane["definition"] + ";\n" + """
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) TO service_role;
DO $generation_first_install$ BEGIN
 IF to_regprocedure('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'first-install bounty generation proof requires the absent-helper native baseline';
 END IF;
END $generation_first_install$;
"""
    # Exercise the actual bounded deployment from the absent-helper baseline,
    # and immediately repeat it to prove metadata-preserving installation.
    # The current ledger and felt stack definition precede both applications.
    dependencies = once(dependencies, original_generation,
                        narrow_authorities(root, bounty) + current_lane + candidate + candidate)
    original_probe = once(original_probe, "SET LOCAL session_replication_role=origin;",
                          fixture + "\nSET LOCAL session_replication_role=origin;")
    evidence_marker = "SELECT 'BOUNTY_LIFECYCLE_EVIDENCE='"
    if original_probe.count(evidence_marker) != 1:
        raise ValueError("original generation evidence marker changed")
    # Preserve the original five-case evidence at its real pre-terminal point;
    # it intentionally says terminal_completed=false there. Terminal evidence
    # follows and proves true completion independently.
    original_probe += "\n" + exercise + "\nROLLBACK;\n"
    # Generation composition installs old current-core inputs. Run it before
    # the terminal runtime, whose imported deployment bundle must be last so
    # newly reviewed obligation-core fixes and their pins remain authoritative.
    probe = (dependencies + "\n-- @FINAL_DEAL_RUNTIME@\n" + original_probe)
    with tempfile.TemporaryDirectory(prefix="codex-bounty-terminal-compose-") as directory:
        path = Path(directory) / "probe.sql"
        path.write_text(probe)
        result = native.compose(root, "paid", path)
    if (len(re.findall(r"^BEGIN;$", result, re.M)) != 1
            or len(re.findall(r"^ROLLBACK;$", result, re.M)) != 1
            or re.search(r"^COMMIT;$", result, re.M)):
        raise ValueError("terminal acceptance must remain one rollback-only outer transaction")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--compose-only", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    sql = compose(root)
    if args.compose_only:
        print(sql)
        return
    if args.evidence is None:
        parser.error("--evidence is required for execution")
    native = module(root / FINAL_RUNNER, "bounty_terminal_snapshot")
    bounty = module(root / BOUNTY_RUNNER, "bounty_terminal_snapshot_tables")
    cash = module(root / "scripts/ci/rehearse-stage-b-cash-payers.py", "bounty_terminal_cash_tables")
    baseline = native.read_sql(
        "SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()"
        " AND pid<>pg_backend_pid())")
    if baseline != "full_stage1|postgres|true|15|12|0":
        raise RuntimeError("retained exclusive native database baseline differs: " + baseline)
    tables = list(dict.fromkeys(list(cash.TABLES) + list(bounty.EXTRA_TABLES) + list(EXTRA_TABLES)))
    before = native.snapshot(tables)
    output = Path(tempfile.mkdtemp(prefix="codex-bounty-current-terminal-"))
    sql_path = output / "terminal.sql"
    sql_path.write_text(sql)
    run = subprocess.run([native.PSQL, "-X", "-h", native.SOCKET, "-p", "55473", "-U", "postgres",
                          "-d", native.DB, "-At", "-v", "ON_ERROR_STOP=1", "-f", str(sql_path)],
                         text=True, capture_output=True)
    log = run.stdout + run.stderr
    (output / "terminal.log").write_text(log)
    after = native.snapshot(tables)
    parsed = {}
    for key, prefix in (("generation", "BOUNTY_LIFECYCLE_EVIDENCE="),
                        ("terminal", "BOUNTY_TERMINAL_NATIVE_EVIDENCE="),
                        ("runtime", "FINAL_DEAL_NATIVE_COMPOSITION=")):
        rows = [line[len(prefix):] for line in run.stdout.splitlines() if line.startswith(prefix)]
        parsed[key] = json.loads(rows[0]) if len(rows) == 1 else None
    original_cases = [case for case in re.findall(r"NOTICE:\s+PASS ([a-z_]+)(?:\n|$)", log)
                      if case in bounty.CASE_MARKERS]
    terminal = parsed["terminal"]
    passed = (run.returncode == 0 and before == after and parsed["generation"] is not None
              and parsed["runtime"] is not None and terminal is not None
              and original_cases == list(bounty.CASE_MARKERS)
              and terminal.get("terminal_completed") is True
              and terminal.get("native_replication_role") == "origin"
              and terminal.get("deferred_constraints_checked") is True
              and len(terminal.get("cases", [])) == 3)
    sources = set(EXACT_SOURCES) | set(bounty.SOURCES) | set(bounty.EXTRA_SOURCES) | {
        PROBE, BOUNTY_RUNNER, FINAL_RUNNER, "scripts/ci/rehearse-bounty-current-terminal.py",
        "scripts/deploy/phase-three-final-deal-terminal-v2.sql",
        "scripts/deploy/phase-three-bounty-rebuy-generation.sql",
        "scripts/deploy/phase-three-strict-tournament-cutover.sql",
        "scripts/dev/build-versioned-final-deal-probe.py",
        "docs/audits/2026-09-10-native-current-money-authorities.json",
        "docs/audits/2026-09-10-native-current-seat-authority.json",
        "docs/audits/2026-09-10-native-current-settlement-lane.json",
    }
    evidence = {
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "passed" if passed else "failed", "baseline": baseline,
        "production_mutations": False, "broad_m5_or_m6_executed": False,
        "whole_stage_b_executed": False, "unused_final_deal_dependency_fixture": True,
        "accepted_hand_evidence_is_synthetic": True,
        "synthetic_mystery_scheduling_deadline_aged_for_next_rpc": True,
        "bounded_generation_first_install_and_replay_executed": True,
        "terminal_completed": passed, "exit_code": run.returncode,
        "original_generation_cases": original_cases,
        "terminal_assertions": terminal.get("checks") if terminal else None,
        "exact_rollback": before == after, "sql_sha256": digest(sql),
        "source_sha256": {relative: digest((root / relative).read_text()) for relative in sorted(sources)},
        "output_directory": str(output), "before": before, "after": after,
        "native_evidence": parsed,
    }
    if not passed:
        evidence["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-36:]
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({key: evidence[key] for key in (
        "status", "exit_code", "original_generation_cases", "terminal_assertions",
        "terminal_completed", "exact_rollback", "output_directory")}), flush=True)
    if not passed:
        print("\n".join(evidence["failure_tail"]), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
