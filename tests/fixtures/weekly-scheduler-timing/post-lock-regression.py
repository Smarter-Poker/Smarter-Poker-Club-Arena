"""UNRUN protected fixture payload; no direct execution authorization.

Requires load.sql + post-lock-setup.sql in a fresh timing_* database. Uses
actual PostgreSQL advisory-lock waiting, followed by three separate changes:
minute cutoff, total deadline, and freeze. No production credentials or jobs.
"""
import json
import os
import re
import selectors
import subprocess
import sys
import time
from pathlib import Path


def main():
    if len(sys.argv) != 5:
        raise SystemExit("qualified psql, Unix socket, port and timing_* database required")
    psql, socket_path, port, database = sys.argv[1:]
    if not Path(psql).is_absolute() or not Path(socket_path).is_absolute():
        raise SystemExit("qualified absolute executable and Unix socket paths required")
    if not port.isdecimal() or not 1024 <= int(port) <= 65535 or not re.fullmatch(r"timing_[a-z0-9_]+", database):
        raise SystemExit("invalid disposable fixture endpoint")
    command = [psql, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
               "-h", socket_path, "-p", port, "-U", "postgres", "-d", database]
    environment = {"PATH": os.environ.get("PATH", ""), "LC_ALL": "C",
                   "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": os.devnull}

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True,
                                env=environment, timeout=15, check=True)
        return result.stdout.strip()

    def spawn():
        return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, env=environment, bufsize=0)

    def send(process, sql):
        process.stdin.write(sql.encode("utf-8"))
        process.stdin.flush()

    def barrier(process, marker, timeout=15):
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        pending = b""
        lines = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError(f"missing actual process barrier {marker}")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError(f"fixture exited before {marker}: {lines}")
                pending += chunk
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    line = raw.decode("utf-8").strip()
                    if line == marker:
                        if pending.strip():
                            raise AssertionError("unexpected output following fixture barrier")
                        return lines
                    if line:
                        lines.append(line)
        finally:
            selector.close()

    def stop(process):
        if process is not None and process.poll() is None:
            try:
                send(process, "ROLLBACK;\n\\quit\n")
                process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    baseline = json.loads(query("SELECT jsonb_build_object('runs',(SELECT count(*) FROM union_accounting_runs),"
                                "'controls',(SELECT count(*) FROM test_scheduler_timing_control),"
                                "'owner',current_user);"))
    if baseline != {"runs": 3, "controls": 1, "owner": "postgres"}:
        raise AssertionError("post-lock fixture must start from its untouched synthetic setup")

    cases = [(12, "minute", "2026-09-14 09:44:00Z", "2026-09-14 09:45:00Z", False),
             (13, "deadline", "2026-09-14 09:29:00Z", "2026-09-14 09:44:01Z", False),
             (14, "freeze", "2026-09-14 09:20:00Z", "2026-09-14 09:20:00Z", True)]
    for club_number, reason, before_clock, after_clock, frozen in cases:
        query(f"UPDATE test_scheduler_timing_control SET clock_at='{before_clock}',frozen=false;")
        original_run = query(f"SELECT to_jsonb(q) FROM union_accounting_runs q WHERE standalone_club_id=u({club_number});")
        original_state = query("SELECT test_scheduler_timing_snapshot(true);")
        lock_expression = (f"hashtextextended('club-accounting:'||u({club_number})::text||':'||"
                           "extract(epoch FROM '2026-09-07 07:00Z'::timestamptz)::text||':'||"
                           "extract(epoch FROM '2026-09-14 07:00Z'::timestamptz)::text,0)")
        holder = waiter = None
        try:
            holder = spawn()
            send(holder, f"BEGIN;SELECT pg_backend_pid();SELECT pg_advisory_xact_lock({lock_expression});\n"
                         "\\echo timing_lock_held\n")
            holder_lines = barrier(holder, "timing_lock_held")
            if len(holder_lines) != 1 or not holder_lines[0].isdigit():
                raise AssertionError(f"unexpected holder identity: {holder_lines}")
            holder_pid = int(holder_lines[0])
            waiter = spawn()
            send(waiter, "SET statement_timeout='20s';SET app.weekly_accounting_attempt_budget='1';"
                         "SELECT pg_backend_pid();\n\\echo timing_actor_ready\n")
            waiter_lines = barrier(waiter, "timing_actor_ready")
            if len(waiter_lines) != 1 or not waiter_lines[0].isdigit():
                raise AssertionError(f"unexpected waiter identity: {waiter_lines}")
            waiter_pid = int(waiter_lines[0])
            send(waiter, f"SELECT fn_process_weekly_accounting_scope(NULL,u({club_number}));\n"
                         "\\echo timing_result_ready\n")
            deadline = time.monotonic() + 10
            while True:
                observed = query("SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h ON "
                                 "(w.locktype,w.database,w.classid,w.objid,w.objsubid)="
                                 "(h.locktype,h.database,h.classid,h.objid,h.objsubid) "
                                 f"WHERE w.pid={waiter_pid} AND h.pid={holder_pid} "
                                 "AND w.locktype='advisory' AND NOT w.granted AND h.granted);")
                if observed == "t":
                    break
                if waiter.poll() is not None or time.monotonic() >= deadline:
                    raise AssertionError("coordinator never demonstrably waited on the exact held period lock")
                time.sleep(0.05)  # Throttle inspection; the catalog match is the proof.
            # Commit the changed gate dependency and release the period lock
            # together. The actor must observe the post-wait clock/freeze.
            send(holder, f"UPDATE test_scheduler_timing_control SET clock_at='{after_clock}',"
                         f"frozen={'true' if frozen else 'false'};COMMIT;\n\\quit\n")
            holder.wait(timeout=10)
            if holder.returncode:
                raise AssertionError("period holder did not commit its controlled gate change")
            lines = barrier(waiter, "timing_result_ready")
            result = json.loads(lines[-1])
            if result.get("success") is not True or result.get("checked") != 0 or result.get("failed") != 0 \
                    or result.get("detail") != [] or result.get("more_remaining") is not True:
                raise AssertionError(f"post-lock {reason} boundary started or misreported work: {result}")
            send(waiter, "\\quit\n")
            waiter.wait(timeout=5)
            if waiter.returncode:
                raise AssertionError("coordinator session did not finish cleanly")
            if query(f"SELECT to_jsonb(q) FROM union_accounting_runs q WHERE standalone_club_id=u({club_number});") != original_run:
                raise AssertionError(f"post-lock {reason} pause changed the original attempt")
            if query("SELECT test_scheduler_timing_snapshot(true);") != original_state:
                raise AssertionError(f"post-lock {reason} pause changed captured mixed-scope accounting state")
            query("UPDATE test_scheduler_timing_control SET clock_at='2026-09-14 09:20Z',frozen=false;")
            resumed = json.loads(query("SET app.weekly_accounting_attempt_budget='1';"
                                       f"SELECT fn_process_weekly_accounting_scope(NULL,u({club_number}));"))
            if resumed.get("checked") != 1 or resumed.get("failed") != 0:
                raise AssertionError(f"qualified retry did not complete the untouched book: {resumed}")
            evidence = json.loads(query("SELECT jsonb_build_object('attempts',q.attempts,'status',q.status,"
                                        "'routes',(SELECT count(*) FROM accounting_routed_settlement_runs r "
                                        f"WHERE r.scope_kind='club' AND r.scope_id=u({club_number})),"
                                        f"'treasury',(SELECT chip_treasury FROM clubs WHERE id=u({club_number}))) "
                                        f"FROM union_accounting_runs q WHERE standalone_club_id=u({club_number});"))
            if evidence != {"attempts": 2, "status": "complete", "routes": 2, "treasury": 100}:
                raise AssertionError(f"retry lost actual empty-book completion evidence: {evidence}")
            completed_state = query("SELECT test_scheduler_timing_snapshot();")
            replay = json.loads(query(f"SELECT fn_process_weekly_accounting_scope(NULL,u({club_number}));"))
            if replay.get("success") is not True or replay.get("checked") != 0 \
                    or replay.get("failed") != 0 or replay.get("detail") != [] \
                    or query("SELECT test_scheduler_timing_snapshot();") != completed_state:
                raise AssertionError("post-commit replay changed captured runs, periods, rounds, closes, wallets or inherited financial artifacts")
            print(f"PASS: real period-lock wait respects {reason}; subsequent retry completes once")
        finally:
            stop(waiter)
            stop(holder)


if __name__ == "__main__":
    main()
