"""Two exact original accepted requests with a database-observed lock barrier."""
import select
import subprocess
import time


def line(process, deadline):
    buf = b''
    while not buf.endswith(b'\n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise TimeoutError('carry concurrency marker was not observed')
        byte = process.stdout.read(1)
        if not byte:
            raise RuntimeError('carry concurrency client exited before marker')
        buf += byte
    return buf.decode().strip()


def run(psql, db, env, output, sql_read):
    argv = psql + ['-At', '-d', db]
    setup = "BEGIN; SET LOCAL statement_timeout='12s'; SET LOCAL lock_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s';"
    call = "SELECT fixture_assert(fixture_carry_commit(1250001,(SELECT q FROM fixture_concurrent_carry_request))->>'success'='true','concurrent exact original hand returns accepted receipt');"
    a = b = None
    with (output / 'carry-race-A.stderr').open('wb') as err_a, (output / 'carry-race-B.stderr').open('wb') as err_b:
        try:
            a = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err_a, bufsize=0)
            a.stdin.write(("SELECT pg_backend_pid();" + setup + call + "SELECT 'A_ACCEPTED_HELD';\n").encode())
            a.stdin.flush()
            pid_a = int(line(a, time.monotonic() + 5))
            deadline = time.monotonic() + 10
            while line(a, deadline) != 'A_ACCEPTED_HELD':
                pass
            b = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err_b, bufsize=0)
            b.stdin.write(("SELECT pg_backend_pid();" + setup + call + "COMMIT;SELECT 'B_REPLAY_FINISHED';\n").encode())
            b.stdin.flush()
            pid_b = int(line(b, time.monotonic() + 5))
            observed = False
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                answer = sql_read("SELECT wait_event_type='Lock' AND %d=ANY(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=%d;" % (pid_a, pid_b)).strip()
                if answer == 't':
                    observed = True
                    break
            if not observed:
                raise RuntimeError('second accepted request never observed blocked by first owner')
            a.stdin.write(b'COMMIT;\\q\n')
            a.stdin.flush()
            a.communicate(timeout=5)
            if a.returncode:
                raise RuntimeError('first accepted request did not commit')
            deadline = time.monotonic() + 10
            while line(b, deadline) != 'B_REPLAY_FINISHED':
                pass
            b.stdin.write(b'\\q\n')
            b.stdin.flush()
            b.communicate(timeout=5)
            if b.returncode:
                raise RuntimeError('second original request did not return accepted replay')
            print('PASS: actual concurrent original requests observed Lock wait on first owner before one commit and accepted replay', flush=True)
        finally:
            for process in (a, b):
                if process is not None and process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
