#!/usr/bin/env python3
"""Execute only the reviewed current-thaw candidate on disposable full_stage1."""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

WHOLE_SHA = "9aba08c670f152e9d1e01a8aa67ddf15a187fccf6d75db43da888eaab54cb908"
INPUTS = [
    "scripts/ci/rehearse-whole-phase-three-cutover.py",
    "scripts/ci/rehearse-phase-three-current-thaw-native.py",
    "scripts/ci/prepare-phase-three-current-thaw-native.py",
    "scripts/ci/probes/phase-three-current-clock-thaw-native.sql",
    "scripts/ci/fixtures/phase-three-current-thaw-authority.sql",
    "scripts/ci/fixtures/phase-three-current-thaw-authority.json",
    "supabase/tests/reconnect_allowance_maintenance.sql",
]

def sha(value):
    return hashlib.sha256(value).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    ap.add_argument("--output-dir", type=Path, required=True)
    ap.add_argument("--frozen-seconds", type=int, choices=(300, 1200), required=True)
    args = ap.parse_args()
    root = args.root.resolve()
    out = args.output_dir.resolve()
    if not str(out).startswith(("/private/tmp/", "/tmp/")):
        raise SystemExit("Native output must be a new disposable /tmp directory")
    out.mkdir(parents=True, exist_ok=False)
    def fingerprints():
        return {name: sha((root / name).read_bytes()) for name in INPUTS}
    before_inputs = fingerprints()
    if before_inputs[INPUTS[0]] != WHOLE_SHA:
        raise SystemExit("The reviewed snapshot helper changed")
    sql_path = out / "rehearsal.sql"
    prepared = subprocess.run([sys.executable, str(root / INPUTS[2]), "--root", str(root),
        "--output", str(sql_path), "--frozen-seconds", str(args.frozen_seconds)],
        capture_output=True, text=True)
    if prepared.returncode:
        raise SystemExit("Source composition failed: " + prepared.stderr[-1000:])
    sql = sql_path.read_text()
    if "session_replication_role" in sql or "DISABLE TRIGGER" in sql.upper():
        raise SystemExit("The reviewed candidate must keep every fixture guard enabled")
    whole_path = root / INPUTS[0]
    spec = importlib.util.spec_from_file_location("ca09_reviewed_whole_snapshot", whole_path)
    whole = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(whole)
    if whole.DB != "full_stage1" or whole.SOCKET != "/tmp/codex-chip-drift-cutover-e2iav203/socket":
        raise SystemExit("Disposable database identity changed")
    # Obtain only the static catalog list count; no database definitions are exported.
    tree = ast.parse(whole_path.read_text())
    catalog_count = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "catalogs" for t in node.targets):
            catalog_count = len(ast.literal_eval(node.value))
    if catalog_count != 15:
        raise SystemExit("Expected the reviewed 15-catalog snapshot")
    before = whole.snapshot()
    (out / "before.snapshot.json").write_text(json.dumps(before, sort_keys=True, indent=2) + "\n")
    command = [whole.PSQL, "-X", "-h", whole.SOCKET, "-p", "55473", "-U", "postgres",
        "-d", whole.DB, "-At", "-v", "ON_ERROR_STOP=1", "-f", str(sql_path)]
    timeout = False
    try:
        executed = subprocess.run(command, capture_output=True, text=True, timeout=120)
        returncode = executed.returncode
        stdout, stderr = executed.stdout, executed.stderr
    except subprocess.TimeoutExpired as error:
        timeout = True
        returncode = 124
        stdout = error.stdout or b""
        stderr = error.stderr or b""
        if isinstance(stdout, bytes): stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes): stderr = stderr.decode(errors="replace")
    # ON_ERROR_STOP terminates the connection on error; its outer transaction rolls back.
    after = whole.snapshot()
    (out / "after.snapshot.json").write_text(json.dumps(after, sort_keys=True, indent=2) + "\n")
    (out / "psql.stdout.log").write_text(stdout)
    (out / "psql.stderr.log").write_text(stderr)
    after_inputs = fingerprints()
    evidence = [json.loads(line.split("=", 1)[1]) for line in stdout.splitlines()
        if line.startswith("CA09_NATIVE_EVIDENCE=")]
    rollback_seen = "ROLLBACK" in stdout.splitlines()
    result = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if returncode == 0 and len(evidence) == 1 and rollback_seen
            and before == after and before_inputs == after_inputs else "FAIL",
        "native_executed": True, "psql_exit_code": returncode, "timeout": timeout,
        "catalogs_checked": catalog_count, "snapshot_entries": len(before),
        "full_snapshot_equal": before == after,
        "snapshot_changed_entry_count": sum(before.get(k) != after.get(k) for k in set(before) | set(after)),
        "before_snapshot_sha256": sha(json.dumps(before, sort_keys=True).encode()),
        "after_snapshot_sha256": sha(json.dumps(after, sort_keys=True).encode()),
        "input_hashes_stable": before_inputs == after_inputs,
        "inputs": before_inputs, "composed_sql_sha256": sha(sql.encode()),
        "frozen_seconds_scenario": args.frozen_seconds,
        "outer_rollback_command_observed": rollback_seen,
        "native_evidence_rows": len(evidence), "evidence": evidence,
        "errors": [line for line in stderr.splitlines() if "ERROR:" in line or "FATAL:" in line],
        "phase_three_complete": False,
        "runtime_transport_or_adoption_proved": False,
        "separate_committed_installment_transactions_proved": False,
        "all_fourteen_deadline_families_nonempty_proved": False,
    }
    (out / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    summary = {key: result[key] for key in ("status", "psql_exit_code", "catalogs_checked",
        "snapshot_entries", "full_snapshot_equal", "snapshot_changed_entry_count",
        "input_hashes_stable", "composed_sql_sha256", "frozen_seconds_scenario",
        "outer_rollback_command_observed", "native_evidence_rows", "errors")}
    summary["output_dir"] = str(out)
    print(json.dumps(summary))
    raise SystemExit(0 if result["status"] == "PASS" else 1)

if __name__ == "__main__":
    main()
