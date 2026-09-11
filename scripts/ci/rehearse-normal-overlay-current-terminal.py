#!/usr/bin/env python3
"""Exercise actual normal overlay funding and sparse/zero cash through terminal completion."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--variant", choices=("overlay", "zero"), action="append")
    args = parser.parse_args()
    root = args.root.resolve()
    native = module(root / "scripts/ci/rehearse-final-deal-current-terminal.py", "current_terminal")
    cash = module(root / "scripts/ci/rehearse-stage-b-cash-payers.py", "cash_tables")
    baseline = native.read_sql("SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())")
    if baseline != "full_stage1|postgres|true|15|12|0":
        raise RuntimeError("owned baseline differs: " + baseline)
    tables = list(cash.TABLES) + [
        "public.tournament_terminal_settlements", "public.tournament_finish_receipts",
        "public.tournament_seat_exit_authorizations", "public.tournament_rake_settlements",
        "public.rake_records", "public.rake_attributions", "public.agent_commissions",
        "public.club_wallets", "public.union_wallets", "public.unions", "public.hand_atomic_commits",
        "public.player_stats", "public.vip_points_carry", "public.engine_tournament_leases",
        "public.tournament_seat_move_receipts",
        "public.managed_game_contract_versions", "public.tournament_guarantee_overlays",
        "public.union_wallet_transactions",
    ]
    before = native.snapshot(tables)
    output = Path(tempfile.mkdtemp(prefix="codex-normal-overlay-"))
    probe = root / "scripts/ci/probes/normal-overlay-current-terminal-native.sql"
    evidence = {"recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "baseline": baseline, "production_mutations": False, "whole_stage_b_executed": False,
        "synthetic_opening_fixture_only": True, "guards_enabled": list(native.GUARDS),
        "before": before, "variants": [], "output_directory": str(output)}
    variants = args.variant or ("overlay", "zero")
    source_paths = (Path(__file__).resolve(), probe,
        root / "scripts/ci/rehearse-final-deal-current-terminal.py",
        root / "scripts/ci/rehearse-stage-b-cash-payers.py",
        root / "scripts/dev/build-versioned-final-deal-probe.py",
        root / "scripts/deploy/phase-three-final-deal-terminal-v2.sql",
        root / "scripts/deploy/phase-three-strict-tournament-cutover.sql",
        root / "docs/audits/2026-09-10-native-current-money-authorities.json",
        root / "docs/audits/2026-09-10-native-current-seat-authority.json")
    source_before = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_paths}
    evidence["source_sha256"] = source_before
    for variant in variants:
        sql = native.compose(root, "paid", probe)
        sql = native.once(sql, "@NORMAL_VARIANT@", variant)
        if (len(re.findall(r"^BEGIN;$", sql, re.M)) != 1
                or re.search(r"^COMMIT;$", sql, re.M)
                or len(re.findall(r"^ROLLBACK;$", sql, re.M)) != 1
                or "@NORMAL_VARIANT@" in sql):
            raise RuntimeError("normal acceptance must remain one explicit rollback-only transaction")
        path = output / (variant + ".sql")
        path.write_text(sql)
        run = subprocess.run([native.PSQL, "-X", "-h", native.SOCKET, "-p", "55473",
            "-U", "postgres", "-d", native.DB, "-At", "-v", "ON_ERROR_STOP=1", "-f", str(path)],
            text=True, capture_output=True)
        log = run.stdout + run.stderr
        (output / (variant + ".log")).write_text(log)
        after = native.snapshot(tables)
        rows = [line.removeprefix("NORMAL_OVERLAY_NATIVE_EVIDENCE=") for line in run.stdout.splitlines()
                if line.startswith("NORMAL_OVERLAY_NATIVE_EVIDENCE=")]
        composition = [line.removeprefix("FINAL_DEAL_NATIVE_COMPOSITION=") for line in run.stdout.splitlines()
                       if line.startswith("FINAL_DEAL_NATIVE_COMPOSITION=")]
        item = {"variant": variant, "exit_code": run.returncode,
            "assertion_notices": len(re.findall(r"NOTICE:\s+PASS ", log)),
            "exact_rollback": before == after,
            "snapshot_changes": [k for k in before if before[k] != after.get(k)],
            "sql_sha256": native.digest(sql),
            "terminal_evidence": json.loads(rows[0]) if len(rows)==1 else None,
            "runtime_composition": json.loads(composition[0]) if len(composition)==1 else None}
        item["passed"] = (run.returncode == 0 and before == after
            and item["terminal_evidence"] is not None
            and item["runtime_composition"] is not None
            and item["terminal_evidence"]["variant"] == variant
            and item["terminal_evidence"]["receipt"].get("status") == "COMPLETED"
            and item["terminal_evidence"]["deferred_constraints_checked"] is True)
        evidence["variants"].append(item)
        evidence["after"] = after
        if not item["passed"]:
            item["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-30:]
        print(json.dumps({k:v for k,v in item.items() if k not in ("terminal_evidence","runtime_composition")}),flush=True)
        if not item["passed"]:
            break
    source_after = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_paths}
    evidence["source_unchanged_during_run"] = source_before == source_after
    evidence["source_changes"] = [key for key in source_before if source_before[key] != source_after[key]]
    final_baseline = native.read_sql("SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())")
    evidence["final_baseline"] = final_baseline
    evidence["status"] = "passed" if (len(evidence["variants"]) == len(variants)
        and all(x["passed"] for x in evidence["variants"])
        and evidence["source_unchanged_during_run"]
        and final_baseline == baseline) else "failed"
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    if evidence["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
