"""UNRUN protected multi-session payload, never direct execution authorization.

Requires actual captured baseline + catalog-bootstrap.sql + full36 candidate,
then concurrency-setup.sql in postgres in a NEW disposable cluster. Existing
cron/candidate guards require that database name. An owner-only run marker pins
the database OID and current postmaster identity before every connection.
No patched writer, fake locks, invented historical intent or output goldens.
Committed synthetic race evidence is retained until the admitted harness archives
and destroys this disposable database. Root wires this as a separate14th phase
after the prior13 phases; it never reuses the acceptance connection or database.
"""
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main(password_file):
    if len(sys.argv) != 5:
        raise SystemExit("qualified psql, isolated Unix socket, port and postgres database required")
    psql, socket_path, port, database = sys.argv[1:]
    if not Path(psql).is_absolute() or not Path(socket_path).is_absolute():
        raise SystemExit("absolute qualified executable/socket paths required")
    if not port.isdecimal() or not 1024 <= int(port) <= 65535 or database != "postgres":
        raise SystemExit("invalid isolated endpoint")
    command = [psql, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
               "-h", socket_path, "-p", port, "-U", "postgres", "-d", database]
    environment = {"PATH": os.environ.get("PATH", ""), "LC_ALL": "C",
                   "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": password_file}
    helpers = Path(__file__).with_name("concurrency-session.sql").read_text()
    config = "SET statement_timeout='25s';SET lock_timeout='20s';SET TimeZone='UTC';SET DateStyle='ISO,YMD';\n"
    expected_run_id = None

    def run_pin():
        if expected_run_id is None:
            return ""
        # Local validated UUID, not caller SQL. Every subsequent connection
        # remains bound to the exact marker observed by this original run.
        return ("DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.correction_writer_fixture_marker "
                f"WHERE run_id='{expected_run_id}'::uuid) THEN RAISE EXCEPTION 'fixture run changed';END IF;END$pin$;\n")

    def query(sql):
        result = subprocess.run(command, input=helpers + config + run_pin() + sql, text=True,
                                capture_output=True, env=environment, timeout=30, check=True)
        return result.stdout.strip()

    def spawn():
        p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=environment, bufsize=0)
        send(p, helpers + config + run_pin())
        return p

    def send(p, sql):
        p.stdin.write(sql.encode())
        p.stdin.flush()

    def barrier(p, marker, timeout=30):
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        pending = b""
        lines = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError(f"missing actual process barrier {marker}")
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError(f"session exited before {marker}: {lines}")
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    line = line.decode().strip()
                    if line == marker:
                        if pending.strip():
                            raise AssertionError("unexpected bytes after barrier")
                        return lines
                    if line:
                        lines.append(line)
        finally:
            selector.close()

    def stop(p):
        if p is not None and p.poll() is None:
            try:
                send(p, "ROLLBACK;\n\\quit\n")
                p.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)

    def finish(p):
        send(p, "\\quit\n")
        p.wait(timeout=5)
        if p.returncode:
            raise AssertionError("fixture session did not finish cleanly")

    def begin_actor(p):
        send(p, "BEGIN;SELECT pg_backend_pid();\n\\echo actor_pid\n")
        rows = barrier(p, "actor_pid")
        if len(rows) != 1 or not rows[0].isdigit():
            raise AssertionError(f"unconfirmed backend identity: {rows}")
        send(p, "SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');SET LOCAL ROLE service_role;\n")
        return int(rows[0])

    def observed_block(waiter_pid, holder_pid):
        deadline = time.monotonic() + 10
        while True:
            if query(f"SELECT {holder_pid}=ANY(pg_blocking_pids({waiter_pid}));") == "t":
                return
            if time.monotonic() >= deadline:
                raise AssertionError("actual waiter never demonstrably blocked on this holder")
            time.sleep(0.05)  # Throttle inspection; server blocker identity is proof.

    def request(incident, amount="4.25", overlay=False):
        # Every interpolated value comes from these local finite constants.
        return ("jsonb_build_object('from_type','club_treasury','from_entity',pg_temp.cw_id(101),"
                f"'to_type','{'prize_liability' if overlay else 'player_wallet'}',"
                f"'to_entity',pg_temp.cw_id({401 if overlay else 2}),'amount','{amount}',"
                "'reason','Concurrent original correction intent is retained exactly',"
                f"'incident_id',pg_temp.cw_id({incident}),'write_failure_id',NULL,"
                "'club_id',pg_temp.cw_id(101),'union_id',NULL,'metadata_sql_null',false,'metadata','{}'::jsonb)")

    def state():
        return query("SELECT pg_temp.cw_book();")

    def actor_query(sql):
        output = query("BEGIN;SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');"
                       "SET LOCAL ROLE service_role;" + sql + ";COMMIT;")
        return json.loads(output)

    def assert_one(incident, ledger, document=True):
        evidence = json.loads(query("SELECT jsonb_build_object("
            f"'ledger',(SELECT count(*) FROM chip_ledger WHERE idempotency_key='correction:inc:'||pg_temp.cw_id({incident})),"
            f"'idem',(SELECT count(*) FROM chip_ledger_idem WHERE idempotency_key='correction:inc:'||pg_temp.cw_id({incident}) AND leg_id='{ledger}'),"
            f"'intent',(SELECT count(*) FROM ca_correction_request_intents_v1 WHERE linkage_key='correction:inc:'||pg_temp.cw_id({incident}) AND ledger_id='{ledger}'),"
            f"'document',(SELECT count(*) FROM accounting_correction_documents WHERE source_ledger_id='{ledger}'),"
            f"'invoice',(SELECT count(*) FROM settlement_invoices WHERE source_ledger_id='{ledger}'),"
            f"'delivery',(SELECT count(*) FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id='{ledger}'));"))
        if evidence != {"ledger": 1, "idem": 1, "intent": 1, "document": int(document), "invoice": int(document), "delivery": int(document)}:
            raise AssertionError(f"race did not retain one complete authority chain: {evidence}")

    def receipt(lines):
        if len(lines) != 1:
            raise AssertionError(f"ambiguous receipt output: {lines}")
        result = json.loads(lines[0])
        if result.get("ok") is not True or result.get("replayed") is not False or not re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", str(result.get("ledger_id", ""))):
            raise AssertionError(f"unconfirmed original receipt: {result}")
        if set(result) != {"ok", "replayed", "ledger_id"}:
            raise AssertionError("unexpected writer receipt fields")
        return result

    setup = json.loads(query("SELECT jsonb_build_object('identities',(SELECT count(*) FROM auth.users WHERE id=pg_temp.cw_id(1)),"
                        "'club',(SELECT count(*) FROM clubs WHERE id=pg_temp.cw_id(101) AND owner_id=pg_temp.cw_id(1) AND chip_treasury=1000),"
                        "'incidents',(SELECT count(*) FROM ca_drift_incidents WHERE id IN(pg_temp.cw_id(321),pg_temp.cw_id(322),pg_temp.cw_id(323),pg_temp.cw_id(324)) AND correction_ref IS NULL),"
                        "'escrow',(SELECT count(*) FROM tournament_escrow WHERE tournament_id=pg_temp.cw_id(401) AND overlay_in=0 AND prize_balance=10),"
                        "'existing',(SELECT count(*) FROM chip_ledger WHERE idempotency_key IN("
                        "'correction:inc:'||pg_temp.cw_id(321),'correction:inc:'||pg_temp.cw_id(322),"
                        "'correction:inc:'||pg_temp.cw_id(323),'correction:inc:'||pg_temp.cw_id(324))),"
                        "'fixture_run_id',(SELECT run_id FROM correction_writer_fixture_marker));"))
    run_id = setup.get("fixture_run_id")
    if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", run_id) or setup != {
            "identities": 1, "club": 1, "incidents": 4, "escrow": 1, "existing": 0, "fixture_run_id": run_id}:
        raise AssertionError("fresh race setup required; never replay a partially completed harness")
    expected_run_id = run_id
    print(json.dumps({"fixture_run_id": run_id, "database": database, "status": "fresh_setup_confirmed"}), flush=True)

    for incident, conflicting in [(321, False), (322, True)]:
        holder = waiter = None
        try:
            holder, waiter = spawn(), spawn()
            hp, wp = begin_actor(holder), begin_actor(waiter)
            send(holder, f"SELECT pg_temp.cw_call({request(incident)});SET CONSTRAINTS ALL IMMEDIATE;SELECT pg_temp.cw_book();\n\\echo original_ready\n")
            original_rows = barrier(holder, "original_ready")
            if len(original_rows) != 2:
                raise AssertionError("original receipt and full state required")
            original, original_state = receipt(original_rows[:1]), original_rows[1]
            # The losing call may hit the actual existing uniqueness authority;
            # that refusal is not relabeled as either success or cancellation.
            send(waiter, "CREATE TEMP TABLE outcome(value jsonb);DO $race$ DECLARE r jsonb;c text;BEGIN "
                 f"BEGIN r:=pg_temp.cw_call({request(incident, '5.25' if conflicting else '4.25')});"
                 "EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;"
                 "r:=jsonb_build_object('refused','23505','constraint',c);END;INSERT INTO outcome VALUES(r);END$race$;"
                 "SELECT value FROM outcome;\n\\echo contender_ready\n")
            observed_block(wp, hp)
            send(holder, "COMMIT;\n\\echo original_committed\n")
            if barrier(holder, "original_committed"):
                raise AssertionError("unexpected commit output")
            output = barrier(waiter, "contender_ready")
            if len(output) != 1:
                raise AssertionError(f"unconfirmed contender: {output}")
            result = json.loads(output[0])
            allowed = [{"refused": "23505", "constraint": name} for name in
                       ("chip_ledger_idem_pkey", "ux_chip_ledger_idempotency_key")]
            allowed.append({"ok": False, "reason": "correction_intent_conflict"} if conflicting else
                           {"ok": True, "replayed": True, "ledger_id": original["ledger_id"]})
            if result not in allowed:
                raise AssertionError(f"unexpected concurrent outcome: {result}")
            send(waiter, "COMMIT;\n\\echo contender_committed\n")
            if barrier(waiter, "contender_committed"):
                raise AssertionError("unexpected contender commit output")
            finish(holder);finish(waiter)
            assert_one(incident, original["ledger_id"])
            if state() != original_state:
                raise AssertionError("contender changed original full committed state")
            before = state()
            replay = actor_query(f"SELECT pg_temp.cw_call({request(incident)})")
            conflict = actor_query(f"SELECT pg_temp.cw_call({request(incident, '5.25')})")
            if replay != {"ok": True, "replayed": True, "ledger_id": original["ledger_id"]} or conflict != {
                    "ok": False, "reason": "correction_intent_conflict"} or state() != before:
                raise AssertionError("post-race exact recovery or full-state equality failed")
            print(json.dumps({"case": "different_intent" if conflicting else "same_intent", "original": original,
                              "contender": result, "post_commit_replay": replay, "status": "passed"}))
        finally:
            stop(waiter);stop(holder)

    for incident, overlay in [(323, False), (324, True)]:
        holder = waiter = None
        try:
            holder, waiter = spawn(), spawn()
            send(holder, "BEGIN;SELECT pg_backend_pid();\n\\echo holder_pid\n")
            rows = barrier(holder, "holder_pid")
            if len(rows) != 1 or not rows[0].isdigit():
                raise AssertionError("unconfirmed lock holder")
            hp, wp = int(rows[0]), begin_actor(waiter)
            mutation = ("UPDATE tournament_escrow SET overlay_in=overlay_in+1,prize_balance=prize_balance+1 "
                        "WHERE tournament_id=pg_temp.cw_id(401)" if overlay else
                        f"UPDATE ca_drift_incidents SET correction_ref='concurrent existing reference' WHERE id=pg_temp.cw_id({incident})")
            send(holder, mutation + ";\n\\echo actual_row_held\n")
            if barrier(holder, "actual_row_held"):
                raise AssertionError("unexpected row-holder output")
            send(waiter, f"SELECT pg_temp.cw_call({request(incident, overlay=overlay)});"
                         "SET CONSTRAINTS ALL IMMEDIATE;SELECT pg_temp.cw_book();\n\\echo writer_ready\n")
            observed_block(wp, hp)
            send(holder, "COMMIT;\n\\echo holder_committed\n")
            if barrier(holder, "holder_committed"):
                raise AssertionError("unexpected holder commit output")
            original_rows = barrier(waiter, "writer_ready")
            if len(original_rows) != 2:
                raise AssertionError("lock case receipt and full state required")
            original, original_state = receipt(original_rows[:1]), original_rows[1]
            send(waiter, "COMMIT;\n\\echo writer_committed\n")
            if barrier(waiter, "writer_committed"):
                raise AssertionError("unexpected writer commit output")
            finish(holder);finish(waiter)
            assert_one(incident, original["ledger_id"], document=not overlay)
            if state() != original_state:
                raise AssertionError("committed lock case differs from original completed writer state")
            observed = query("SELECT overlay_in=5.25 AND prize_balance=15.25 FROM tournament_escrow WHERE tournament_id=pg_temp.cw_id(401);"
                             if overlay else f"SELECT correction_ref='concurrent existing reference' FROM ca_drift_incidents WHERE id=pg_temp.cw_id({incident});")
            before = state()
            replay = actor_query(f"SELECT pg_temp.cw_call({request(incident, overlay=overlay)})")
            if observed != "t" or replay != {"ok": True, "replayed": True, "ledger_id": original["ledger_id"]} or state() != before:
                raise AssertionError("real incident/escrow lock did not preserve the committed prior effect exactly once")
            print(json.dumps({"case": "escrow_lock" if overlay else "incident_lock", "original": original, "status": "passed"}))
        finally:
            stop(waiter);stop(holder)


if __name__ == "__main__":
    # libpq requires a regular private file; /dev/null emits a warning into the
    # strict backend-identity stream. Never read an ambient credential file.
    with tempfile.NamedTemporaryFile(prefix="correction-fixture-pgpass-") as password_file:
        os.fchmod(password_file.fileno(), 0o600)
        main(password_file.name)
