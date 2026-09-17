"""UNRUN protected-fixture input. No cluster creation, network DSN or live sends.

The protected owner supplies an isolated fairness_* database already loaded
with load.sql, a pinned psql executable and a Unix socket directory.
"""

import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--psql", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    if not Path(args.psql).is_absolute() or not Path(args.socket).is_absolute():
        raise ValueError("Protected fixture requires absolute executable/socket paths")
    if not args.database.startswith("fairness_") or not 1024 <= args.port <= 65535:
        raise ValueError("Only an isolated fairness_* fixture database is accepted")
    # Do not inherit production libpq connection/service/credential settings.
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    command = [args.psql, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1",
               "-h", args.socket, "-p", str(args.port), "-d", args.database]

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True,
                                env=env, timeout=30, check=True)
        return result.stdout.strip()

    baseline = query("SELECT jsonb_build_object('runs',(SELECT count(*) FROM union_accounting_runs),"
                     "'unions',(SELECT count(*) FROM unions),'fixture',"
                     "to_regprocedure('public.test_scheduler_money_snapshot()') IS NOT NULL);")
    if json.loads(baseline) != {"runs": 0, "unions": 9, "fixture": True}:
        raise AssertionError("Concurrency fixture must begin at untouched load.sql state")
    first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
    try:
        first.stdin.write("BEGIN;SET test.clock='2026-09-14T09:20:00Z';"
                          "SELECT fn_process_weekly_accounting(NULL);\n"
                          "\\echo scheduler_lock_held\n")
        first.stdin.flush()
        # The lock holder remains alive until the other connection has observed
        # its refusal. Bound every wait; never use a sleep as proof of a lock.
        selector = selectors.DefaultSelector()
        selector.register(first.stdout, selectors.EVENT_READ)
        lines = []
        pending = b""
        barrier_seen = False
        deadline = time.monotonic() + 30
        while not barrier_seen:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError("First coordinator did not reach its lock barrier")
            chunk = os.read(first.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError("First coordinator exited before lock barrier")
            pending += chunk
            while b"\n" in pending:
                raw_line, pending = pending.split(b"\n", 1)
                line = raw_line.decode("utf-8").strip()
                if line == "scheduler_lock_held":
                    barrier_seen = True
                    break
                if line:
                    lines.append(line)
        selector.close()
        result = json.loads(lines[-1])
        if result["checked"] != 8 or result["failed"] != 8:
            raise AssertionError("Initial blocked-union batch exceeded or lost its shared budget")
        competing = json.loads(query("SET test.clock='2026-09-14T09:20:30Z';"
                                     "SELECT fn_process_weekly_accounting(NULL);"))
        if competing.get("reason") != "already_running" or not competing.get("skipped"):
            raise AssertionError("Competing invocation entered an already-active scheduler")
        if query("SELECT count(*) FROM union_accounting_runs;") != "0":
            raise AssertionError("Competing call wrote journal entries before the holder committed")
        first.stdin.write("COMMIT;\n")
        first.stdin.close()
        first.wait(timeout=10)
        if first.returncode:
            raise AssertionError(first.stderr.read())
        resumed = json.loads(query("SET test.clock='2026-09-14T09:21:00Z';"
                                   "SELECT fn_process_weekly_accounting(NULL);"))
        if resumed["checked"] != 8 or resumed["failed"] != 7:
            raise AssertionError("Next invocation did not retain the shared eight-attempt budget")
        if resumed["detail"][1].get("club_id") != "00000000-0000-4000-8000-000000000011":
            raise AssertionError("Standalone book was starved after the original batch committed")
        evidence = json.loads(query("SELECT jsonb_build_object('treasury',(SELECT chip_treasury FROM clubs WHERE id=u(11)),"
                                    "'member_balance',(SELECT sum(chip_balance) FROM club_members WHERE club_id=u(11)),"
                                    "'club_attempts',(SELECT attempts FROM union_accounting_runs WHERE standalone_club_id=u(11)),"
                                    "'invoices',(SELECT count(*) FROM settlement_invoices),"
                                    "'notifications',(SELECT count(*) FROM notifications),"
                                    "'messages',(SELECT count(*) FROM social_messages));"))
        if evidence != {"treasury": 153.40, "member_balance": 46.60, "club_attempts": 1,
                        "invoices": 7, "notifications": 11, "messages": 11}:
            raise AssertionError(f"Concurrent retry lost or duplicated financial evidence: {evidence}")
        paid_snapshot = json.loads(query("SELECT test_scheduler_money_snapshot();"))
        query("SET test.clock='2026-09-14T09:22:00Z';SELECT fn_process_weekly_accounting(NULL);")
        if json.loads(query("SELECT test_scheduler_money_snapshot();")) != paid_snapshot:
            raise AssertionError("Post-commit retry duplicated money, invoices or notification receipts")
        print("PASS: competing call refuses; next call resumes fair scope order; real payout and receipt retry is unchanged")
    finally:
        if first.poll() is None:
            first.terminate()
            try:
                first.wait(timeout=5)
            except subprocess.TimeoutExpired:
                first.kill()
                first.wait(timeout=5)


if __name__ == "__main__":
    main()
