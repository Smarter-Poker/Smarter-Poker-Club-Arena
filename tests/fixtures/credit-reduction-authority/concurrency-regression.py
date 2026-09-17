"""SOURCE ONLY / UNRUN. Protected finite actual-session fixture payload.

Requires admitted public PG17 psql, fresh marked Unix-socket postgres database,
actual original catalog + full36 + complete credit successor + setup. No package
installation, credential lookup, financial replacement or execution permission.
Includes actual apply/replay/conflict/absolute-ABA/retire orderings, all seven
guarded entrypoints, nested ensure-agent creation, and payment/debt interleavings.
No result here may be claimed until the protected runner actually executes it.
"""
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
from decimal import Decimal
from pathlib import Path


def main(password_file):
    if len(sys.argv) != 5:
        raise SystemExit("qualified psql, isolated socket, port, postgres required")
    psql, socket, port, database = sys.argv[1:]
    if not Path(psql).is_absolute() or not Path(socket).is_absolute() or database != "postgres":
        raise SystemExit("invalid isolated endpoint")
    if not port.isdecimal() or not 1024 <= int(port) <= 65535:
        raise SystemExit("invalid isolated port")
    command = [psql, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", socket,
               "-p", port, "-U", "postgres", "-d", database]
    environment = {"PATH": os.environ.get("PATH", ""), "LC_ALL": "C",
                   "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": password_file}
    setup = Path(__file__).with_name("concurrency-session.sql").read_text()
    config = "SET statement_timeout='25s';SET lock_timeout='20s';SET TimeZone='UTC';SET DateStyle='ISO,YMD';\n"
    run_id = None
    active = []

    def prefix():
        pin = "" if run_id is None else (
            "DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.credit_reduction_fixture_marker "
            f"WHERE run_id='{run_id}'::uuid) THEN RAISE EXCEPTION 'original fixture identity changed';END IF;END$pin$;\n")
        return config + setup + pin

    def query(sql):
        try:
            completed = subprocess.run(command, input=prefix() + sql, text=True, capture_output=True,
                                       env=environment, timeout=30, check=False)
        except subprocess.TimeoutExpired as error:
            print(json.dumps({"query_timed_out": sql, "timeout_seconds": error.timeout,
                              "partial_stdout": diagnostic_text(error.stdout),
                              "partial_stderr": diagnostic_text(error.stderr)}), file=sys.stderr)
            raise
        if completed.returncode:
            print(json.dumps({"query_failed": sql, "returncode": completed.returncode,
                              "stdout": completed.stdout, "stderr": completed.stderr}), file=sys.stderr)
            raise subprocess.CalledProcessError(completed.returncode, command,
                                                output=completed.stdout, stderr=completed.stderr)
        if completed.stderr.strip():
            # Retain every diagnostic; notices are not silently treated as proof.
            print(completed.stderr, file=sys.stderr, end="")
        return completed.stdout.strip()

    def diagnostic_text(value):
        return value.decode(errors="replace") if isinstance(value, bytes) else value

    def send(p, sql):
        p.stdin.write(sql.encode())
        p.stdin.flush()

    def barrier(p, marker):
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)
        pending = b""
        lines = []
        deadline = time.monotonic() + 30
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    print(json.dumps({"barrier_timed_out": marker, "lines": lines,
                                      "pending": diagnostic_text(pending), "returncode": p.poll()}), file=sys.stderr)
                    raise TimeoutError(f"missing actual barrier {marker}")
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk:
                    print(json.dumps({"barrier_ended": marker, "lines": lines,
                                      "pending": diagnostic_text(pending), "returncode": p.poll()}), file=sys.stderr)
                    raise AssertionError(f"process ended before {marker}: {lines}")
                pending += chunk
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    line = raw.decode().strip()
                    if line == marker:
                        if pending.strip():
                            print(json.dumps({"barrier_extra_bytes": marker, "lines": lines,
                                              "pending": diagnostic_text(pending)}), file=sys.stderr)
                            raise AssertionError("unexpected bytes after actual barrier")
                        return lines
                    if line:
                        lines.append(line)
        finally:
            selector.close()

    def session(actor=1, role="authenticated"):
        if actor not in (1, 3, 6, 28) or role not in ("authenticated", "service_role"):
            raise AssertionError("unlisted fixture actor")
        p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=environment, bufsize=0)
        active.append(p)
        send(p, prefix() + "BEGIN;SELECT pg_backend_pid();\n\\echo identified\n")
        rows = barrier(p, "identified")
        if len(rows) != 1 or not rows[0].isdigit():
            raise AssertionError(f"unconfirmed session identity: {rows}")
        send(p, f"SELECT pg_temp.cr_actor({actor},'{role}');SET LOCAL ROLE {role};\n")
        return p, int(rows[0])

    def blocked(waiter, holder):
        deadline = time.monotonic() + 10
        while query(f"SELECT {holder}=ANY(pg_blocking_pids({waiter}));") != "t":
            if time.monotonic() >= deadline:
                raise AssertionError("expected actual writer did not block on the exact holder")
            time.sleep(0.05)

    def result(p, sql, marker):
        send(p, sql + f";\n\\echo {marker}\n")
        return received(p, marker)

    def received(p, marker):
        rows = barrier(p, marker)
        if len(rows) != 1:
            raise AssertionError(f"ambiguous actual result: {rows}")
        return json.loads(rows[0])

    def commit(p):
        send(p, "COMMIT;\n\\echo committed\n")
        rows = barrier(p, "committed")
        if rows:
            raise AssertionError(f"unexpected commit diagnostics: {rows}")

    def close(p):
        send(p, "\\quit\n")
        p.wait(timeout=5)
        if p.returncode:
            raise AssertionError("session did not finish cleanly")

    def chain(op, target, limit_after, revision, expected_operations=1):
        evidence = json.loads(query("SELECT jsonb_build_object("
            f"'operations',(SELECT count(*) FROM accounting_credit_reduction_operations_v1 WHERE actor_user_id=pg_temp.cr_id(1) AND operation_id=pg_temp.cr_id({op})),"
            f"'limit',(SELECT credit_limit::text FROM agents WHERE id=pg_temp.cr_id({200 + target})),"
            f"'revision',(SELECT credit_control_revision::text FROM agents WHERE id=pg_temp.cr_id({200 + target})),"
            "'complete',(SELECT count(*) FROM accounting_credit_reduction_operations_v1 o "
            "JOIN credit_assignments a ON a.id=o.assignment_id AND a.agent_id=o.agent_id AND a.old_limit=o.before_limit AND a.new_limit=o.after_limit "
            "JOIN accounting_credit_change_documents_v1 d ON d.operation_receipt_id=o.id AND d.id=o.document_id AND d.invoice_id=o.invoice_id "
            "JOIN settlement_invoices i ON i.id=d.invoice_id AND i.invoice_type='credit_limit_change' AND i.status='generated' "
            f"WHERE o.actor_user_id=pg_temp.cr_id(1) AND o.operation_id=pg_temp.cr_id({op}) "
            "AND fn_accounting_credit_reduction_assert_document(o.id) IS NOT NULL "
            "AND (SELECT count(*) FROM accounting_invoice_deliveries v WHERE v.invoice_id=i.id)=2));"))
        expected = {"operations": expected_operations, "limit": limit_after, "revision": str(revision), "complete": expected_operations}
        if evidence != expected:
            raise AssertionError(f"committed exact chain mismatch: {evidence} != {expected}")
        print(json.dumps({"operation": op, "committed_chain": evidence}, sort_keys=True))

    def recorded(e, replayed, amount="10.00"):
        r = e.get("receipt") or {}
        if e.get("state") != "recorded" or e.get("replayed") is not replayed or r.get("applied_reduction") != amount:
            raise AssertionError(f"unverified receipt: {e}")
        if r.get("payment_proven") is not False or r.get("chip_movement_claimed") is not False:
            raise AssertionError("receipt claimed payment")
        return e

    def failed(e, name):
        if e != {"fixture_error_state": "23514", "fixture_error_message": name}:
            raise AssertionError(f"wrong refusal: {e}")

    def book():
        return query("SELECT pg_temp.cr_book();")

    def unchanged(before):
        if book() != before:
            raise AssertionError("losing/replayed operation changed full committed source or money rows")

    def actor_query(sql, actor=1, role="authenticated"):
        p, _ = session(actor, role)
        value = result(p, sql, "single_result")
        commit(p); close(p)
        return value

    def early_entry(label, operation, actor, role, sql, ensure=False):
        # A real reduction owns the common club mutex. B must block before
        # acquiring any club/member/agent row lock. A then obtains those rows;
        # the former row→agreement inversion would deadlock this ordering.
        a, aid = session(); b, bid = session(actor, role)
        holder = recorded(result(a,
            "SELECT fn_reduce_agent_credit_v1(pg_temp.cr_id(1),"
            f"pg_temp.cr_id({operation}),pg_temp.cr_id(101),pg_temp.cr_id(201),pg_temp.cr_id(2),1,"
            "(s->>'credit_limit')::numeric,(s->>'credit_used')::numeric,(s->>'is_prepaid')::boolean,"
            "(s->>'control_revision')::bigint,'Real reduction holds original club authority') "
            "FROM (SELECT fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(2)) s) q",
            "holder_recorded"), False, "1.00")
        send(b, sql + ";\n\\echo guarded_entry\n")
        blocked(bid, aid)
        observation = json.loads(query(f"SELECT jsonb_build_object('holder',{aid},'waiter',{bid},"
            f"'blocked',{aid}=ANY(pg_blocking_pids({bid})),'wait_type',wait_event_type,'wait_event',wait_event) "
            f"FROM pg_stat_activity WHERE pid={bid};"))
        if observation.get("blocked") is not True or observation.get("wait_type") != "Lock" or observation.get("wait_event") != "advisory":
            raise AssertionError(f"entrypoint did not wait on shared authority: {observation}")
        send(a, "RESET ROLE;SET LOCAL lock_timeout='2s';\n")
        rows = result(a,"WITH c AS(SELECT id FROM clubs WHERE id=pg_temp.cr_id(101) FOR UPDATE),"
            "m AS(SELECT id FROM club_members WHERE club_id=pg_temp.cr_id(101) ORDER BY id FOR UPDATE),"
            "g AS(SELECT id FROM agents WHERE club_id=pg_temp.cr_id(101) ORDER BY id FOR UPDATE) "
            "SELECT jsonb_build_object('club',(SELECT count(*) FROM c),'members',(SELECT count(*) FROM m),'agents',(SELECT count(*) FROM g))",
            "holder_rows_available")
        if rows.get("club") != 1 or rows.get("members") != 40 or rows.get("agents", 0) < 30:
            raise AssertionError(f"holder could not confirm original row inventory: {rows}")
        commit(a); value = received(b,"guarded_entry")
        if ensure:
            if not isinstance(value,str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",value):
                raise AssertionError(f"ensure did not return actual row identity: {value}")
        elif not isinstance(value,dict) or value.get("success") is not True:
            raise AssertionError(f"actual guarded entry refused: {label}: {value}")
        commit(b); close(a); close(b)
        observed = actor_query(f"SELECT fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id({operation}),pg_temp.cr_id(101))")
        if observed != dict(holder,replayed=True):
            raise AssertionError("other completed writer changed original reduction receipt")
        print(json.dumps({"entrypoint":label,"lock_observation":observation,"holder_rows":rows,
                          "holder_receipt":holder,"other_result":value},sort_keys=True))
        return value

    try:
        run_id = query("SELECT run_id FROM credit_reduction_fixture_marker;")
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", run_id):
            raise AssertionError("exact fixture identity unavailable")
        # Same intent: second real session is blocked until complete first commit.
        a, aid = session(); b, bid = session()
        first = recorded(result(a, "SELECT pg_temp.cr_apply(1601,23,10,100,0)", "first"), False)
        send(b, "SELECT pg_temp.cr_try_apply(1601,23,10,100,0);\n\\echo second\n")
        blocked(bid, aid); commit(a); original_book = book()
        replay = received(b, "second"); recorded(replay, True)
        if replay != dict(first, replayed=True):
            raise AssertionError("same operation did not return exact frozen receipt")
        commit(b); unchanged(original_book); close(a); close(b); chain(1601,23,"90.00",1)
        # Same key, conflicting amount: refusal after the original commit.
        a, aid = session(); b, bid = session()
        recorded(result(a,"SELECT pg_temp.cr_apply(1602,24,10,100,0)","first"),False)
        send(b,"SELECT pg_temp.cr_try_apply(1602,24,11,100,0);\n\\echo second\n")
        blocked(bid,aid); commit(a); original_book=book(); failed(received(b,"second"),"credit_reduction_operation_conflict")
        commit(b); unchanged(original_book); close(a); close(b); chain(1602,24,"90.00",1)
        # Existing absolute writer really changes A→B→A while stale apply waits.
        a, aid = session(); b, bid = session()
        first = result(a,"SELECT fn_admin_update_agent(pg_temp.cr_id(225),p_credit_limit=>120,p_credit_reason=>'Concurrent first change')","absolute1")
        second = result(a,"SELECT fn_admin_update_agent(pg_temp.cr_id(225),p_credit_limit=>100,p_credit_reason=>'Concurrent return change')","absolute2")
        if first.get("success") is not True or second.get("success") is not True:
            raise AssertionError("actual predecessor writer refused ABA setup")
        send(b,"SELECT pg_temp.cr_try_apply(1603,25,10,100,0);\n\\echo second\n")
        blocked(bid,aid); commit(a); original_book=book(); failed(received(b,"second"),"credit_reduction_state_changed")
        commit(b); unchanged(original_book); close(a); close(b); chain(1603,25,"100.00",2,0)
        # Retirement wins: late apply cannot move capacity after explicit close.
        a, aid = session(); b, bid = session()
        retired = result(a,"SELECT fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1604),pg_temp.cr_id(101))","retired")
        if retired.get("state") != "retired" or retired.get("replayed") is not False:
            raise AssertionError("retirement was not recorded")
        send(b,"SELECT pg_temp.cr_try_apply(1604,26,10,100,0);\n\\echo second\n")
        blocked(bid,aid); commit(a); original_book=book(); failed(received(b,"second"),"credit_reduction_operation_retired")
        commit(b); unchanged(original_book); close(a); close(b); chain(1604,26,"100.00",0,0)
        if query("SELECT count(*) FROM accounting_credit_reduction_retirements_v1 WHERE actor_user_id=pg_temp.cr_id(1) AND operation_id=pg_temp.cr_id(1604);") != "1":
            raise AssertionError("original retirement receipt not persisted exactly once")
        # Apply wins: waiting retirement returns original financial receipt.
        a, aid = session(); b, bid = session()
        first = recorded(result(a,"SELECT pg_temp.cr_apply(1605,27,10,100,0)","first"),False)
        send(b,"SELECT fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1605),pg_temp.cr_id(101));\n\\echo second\n")
        blocked(bid,aid); commit(a); original_book=book(); replay=received(b,"second"); recorded(replay,True)
        if replay != dict(first,replayed=True):
            raise AssertionError("retirement altered completed operation")
        commit(b); unchanged(original_book); close(a); close(b); chain(1605,27,"90.00",1)
        early_entry("role setter",1701,1,"authenticated",
            "SELECT fn_club_set_member_role(pg_temp.cr_id(101),pg_temp.cr_id(29),'sub_agent',pg_temp.cr_id(1),0,0,false,100)")
        early_entry("assign-to-super",1702,1,"service_role",
            "SELECT fn_assign_agent_to_super_agent(pg_temp.cr_id(30),pg_temp.cr_id(17),pg_temp.cr_id(101))")
        ensured=early_entry("ensure-agent",1703,1,"service_role",
            "SELECT to_jsonb(fn_ensure_agent_row(pg_temp.cr_id(101),pg_temp.cr_id(9),'agent'))",ensure=True)
        if query(f"SELECT count(*) FROM agents WHERE id='{ensured}'::uuid AND club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(9) AND is_prepaid AND credit_limit=0 AND credit_used=0;") != "1":
            raise AssertionError("ensure inserted unintended borrowing state")
        for i, (function, role) in enumerate([
                ("fn_agent_wallet_send","authenticated"),
                ("fn_agent_wallet_send_phase2_core_20260831","service_role"),
                ("fn_agent_wallet_send_core_20260830","service_role")],start=1):
            sent=early_entry(function,1703+i,28,role,
                f"SELECT {function}(pg_temp.cr_id(101),pg_temp.cr_id(6),10,'player_wallet','Actual credit draw fixture',pg_temp.cr_id({1800+i}))")
            if Decimal(str(sent.get("credit_drawn"))) != Decimal(10) or Decimal(str(sent.get("credit_used_after"))) != Decimal(i*10):
                raise AssertionError(f"actual credit draw amount changed: {sent}")
            evidence=json.loads(query(f"SELECT jsonb_build_object('used',(SELECT credit_used::text FROM agents WHERE id=pg_temp.cr_id(228)),"
                "'player',(SELECT chip_balance::text FROM club_members WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(6)),"
                f"'draw',(SELECT count(*) FROM chip_ledger WHERE idempotency_key='agent_send:credit:'||pg_temp.cr_id({1800+i})::text AND category='credit_draw' AND amount=10),"
                f"'send',(SELECT count(*) FROM chip_ledger WHERE idempotency_key='agent_send:'||pg_temp.cr_id({1800+i})::text AND category='agent_send' AND amount=10));"))
            if evidence["used"] != f"{i*10}.00" or Decimal(evidence["player"]) != Decimal(i*10) or evidence["draw"] != 1 or evidence["send"] != 1:
                raise AssertionError(f"actual credit draw/send source chain incomplete: {evidence}")
        # Public send creates the recipient agent row through the real nested
        # ensure path, rather than calling a stub or merely ensuring an old row.
        if query("SELECT count(*) FROM agents WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(8);") != "0":
            raise AssertionError("nested ensure target was not originally absent")
        early_entry("public send with nested ensure INSERT",1707,28,"authenticated",
            "SELECT fn_agent_wallet_send(pg_temp.cr_id(101),pg_temp.cr_id(8),5,'agent_wallet','Nested ensure insertion',pg_temp.cr_id(1804))")
        if query("SELECT count(*) FROM agents WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(8) AND is_prepaid AND credit_limit=0 AND credit_used=0 AND agent_wallet_balance=5;") != "1":
            raise AssertionError("nested ensure did not retain exact nonborrowing recipient wallet")
        # Canonical hold first; approval uses the seventh entry's real wrapper
        # and creates the owner's previously absent agent wallet via ensure.
        hold=actor_query("SELECT fn_cashout_request_v2(pg_temp.cr_id(101),5,pg_temp.cr_id(6),pg_temp.cr_id(1850),'Canonical concurrent hold')",6)
        if hold.get("contract_version") != 1 or hold.get("success") is not True or hold.get("event_kind") != "hold" or hold.get("request_status") != "pending":
            raise AssertionError(f"unverified canonical hold: {hold}")
        cashout=hold.get("cashout_id")
        if not isinstance(cashout,str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",cashout):
            raise AssertionError("invalid canonical cashout identity")
        if query("SELECT count(*) FROM agents WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(1);") != "0":
            raise AssertionError("approval nested ensure owner already existed")
        approval=early_entry("cashier approval with nested ensure INSERT",1708,1,"authenticated",
            f"SELECT fn_cashout_approve_v2('{cashout}'::uuid,pg_temp.cr_id(101),5,pg_temp.cr_id(1),pg_temp.cr_id(1851),'Canonical concurrent approval')")
        if approval.get("event_kind") != "approval" or approval.get("cashout_id") != cashout or approval.get("hold_event_id") != hold.get("event_id") or approval.get("hold_invoice_id") != hold.get("invoice_id") or approval.get("request_status") != "approved" or approval.get("cashout_completed") is not True:
            raise AssertionError(f"approval did not retain original hold authority: {approval}")
        if query("SELECT count(*) FROM agents WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(1) AND is_prepaid AND credit_limit=0 AND credit_used=0 AND agent_wallet_balance=5;") != "1":
            raise AssertionError("approval did not retain exact owner wallet")
        # Invoice actual recorded drawn debt through its existing generator.
        invoice=actor_query("SELECT fn_generate_credit_invoice(pg_temp.cr_id(228),now()-interval '2 days',now()-interval '1 day',35,now()+interval '1 day')")
        invoice_id=(invoice.get("invoice") or {}).get("id")
        if invoice.get("success") is not True or not isinstance(invoice_id,str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",invoice_id):
            raise AssertionError(f"actual invoice generation did not confirm: {invoice}")
        a,aid=session();b,bid=session()
        paid=result(a,f"SELECT fn_process_credit_invoice_payment('{invoice_id}'::uuid,5,'external',pg_temp.cr_id(1860),'Synthetic external payment reference 1860')","payment")
        if paid.get("success") is not True or paid.get("credit_used_after") != 30:
            raise AssertionError(f"actual payment failed: {paid}")
        send(b,"SELECT pg_temp.cr_try_apply(1861,28,10,100,4,35);\n\\echo payment_waiter\n")
        blocked(bid,aid);commit(a);original_book=book();failed(received(b,"payment_waiter"),"credit_reduction_state_changed")
        commit(b);unchanged(original_book);close(a);close(b)
        # Reverse order: a real reduction preserves debt, then the waiting real
        # external-payment record reduces it without rewriting that receipt.
        a,aid=session();b,bid=session()
        reduced=recorded(result(a,"SELECT pg_temp.cr_apply(1862,28,10,100,5,30)","reduced"),False)
        send(b,f"SELECT fn_process_credit_invoice_payment('{invoice_id}'::uuid,5,'external',pg_temp.cr_id(1863),'Synthetic external payment reference 1863');\n\\echo payment_after_reduction\n")
        blocked(bid,aid);commit(a);paid=received(b,"payment_after_reduction")
        if paid.get("success") is not True or paid.get("credit_used_after") != 25:
            raise AssertionError(f"waiting payment lost the reduction/debt order: {paid}")
        commit(b);close(a);close(b)
        debt=json.loads(query("SELECT jsonb_build_object('limit',credit_limit::text,'used',credit_used::text,'revision',credit_control_revision::text) FROM agents WHERE id=pg_temp.cr_id(228);"))
        if debt != {"limit":"90.00","used":"25.00","revision":"7"}:
            raise AssertionError(f"exact debt/limit conservation failed: {debt}")
        replay=actor_query("SELECT fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id(1862),pg_temp.cr_id(101))")
        if replay != dict(reduced,replayed=True):
            raise AssertionError("payment rewrote the original reduction receipt")
        # An actual existing invoice replay holds the target agent row without
        # changing it. The new manager helper must hold membership SHARE before
        # waiting there, so a later direct disable cannot overtake the decision.
        h,hid=session();a,aid=session(3);m,mid=session()
        duplicate=result(h,f"SELECT fn_generate_credit_invoice(agent_id,period_start,period_end,debt_owed,due_date) FROM credit_invoices WHERE id='{invoice_id}'::uuid","existing_invoice")
        if duplicate.get("success") is not True or duplicate.get("duplicate") is not True:
            raise AssertionError("existing invoice replay did not establish actual agent lock")
        send(a,"SELECT pg_temp.cr_try_apply(1870,28,1,90,7,25,3);\n\\echo manager_decision\n")
        blocked(aid,hid)
        send(m,"RESET ROLE;WITH changed AS(UPDATE club_members SET is_active=false WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(3) RETURNING user_id,is_active) SELECT jsonb_agg(to_jsonb(changed)) FROM changed;\n\\echo manager_disabled\n")
        blocked(mid,aid);commit(h)
        manager_result=received(a,"manager_decision");recorded(manager_result,False,"1.00")
        blocked(mid,aid);commit(a)
        disabled=received(m,"manager_disabled")
        if disabled != [{"user_id":"e6371000-0000-4000-8000-000000000003","is_active":False}]:
            raise AssertionError(f"exact later manager disable not retained: {disabled}")
        commit(m);close(h);close(a);close(m)
        before=book()
        denied=actor_query("SELECT pg_temp.cr_try_apply(1871,35,1,100,0,0,3)",3)
        if denied != {"fixture_error_state":"42501","fixture_error_message":"credit_reduction_not_authorized"}:
            raise AssertionError(f"new operation after committed disable was admitted: {denied}")
        unchanged(before)
        historical=actor_query("SELECT fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(3),pg_temp.cr_id(1870),pg_temp.cr_id(101))",3)
        if historical != dict(manager_result,replayed=True):
            raise AssertionError("demotion removed access to original own receipt")
        unchanged(before)
        print(json.dumps({"source_catalog":"credit-reduction-concurrency-v1","actual_interleavings":16,
                          "checks_are_runtime_results_only_when_this_payload_executes":True}))
    finally:
        for p in active:
            if p.poll() is None:
                try:
                    send(p,"ROLLBACK;\n\\quit\n"); p.wait(timeout=5)
                except (BrokenPipeError,subprocess.TimeoutExpired):
                    p.terminate()
                    try:
                        p.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        p.kill(); p.wait(timeout=5)


if __name__ == "__main__":
    # libpq requires a regular private file; /dev/null emits a warning into the
    # strict backend-identity stream. Never read an ambient credential file.
    with tempfile.NamedTemporaryFile(prefix="credit-fixture-pgpass-") as password_file:
        os.fchmod(password_file.fileno(), 0o600)
        main(password_file.name)
