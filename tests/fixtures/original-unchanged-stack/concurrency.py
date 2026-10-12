"""Two actual sessions: observe the second writer blocked on the first's lock."""
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

pgbin, socket = sys.argv[1:]
cmd = [str(Path(pgbin) / 'psql'), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '56435', '-U', 'postgres', '-d', 'real_originals']
first = second = None
try:
    first = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    first.stdin.write("BEGIN; SELECT fn_union_pnl_resolve_original_unchanged_stack('a8798e10-ccca-40ac-b7b1-d9741af5e98f',26114212,'Native first concurrent original continuity writer')->>'status';\n")
    first.stdin.flush()
    with selectors.DefaultSelector() as selector:
        selector.register(first.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            raise RuntimeError('first writer did not reach lock barrier')
        if first.stdout.readline().strip() != 'resolved':
            raise RuntimeError('first writer did not resolve original certificate')
    app = 'original-unchanged-second-' + str(os.getpid())
    env = dict(os.environ, PGAPPNAME=app)
    second = subprocess.Popen(cmd + ['-c', "SELECT fn_union_pnl_resolve_original_unchanged_stack('a8798e10-ccca-40ac-b7b1-d9741af5e98f',26114212,'Native second concurrent original continuity writer')->>'status';"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    deadline = time.monotonic() + 10
    while True:
        wait = subprocess.run(cmd + ['-c', "SELECT count(*) FROM pg_stat_activity WHERE application_name='" + app + "' AND wait_event_type='Lock' AND lower(wait_event)='advisory';"], capture_output=True, text=True, check=True, timeout=5).stdout.strip()
        if wait == '1':
            break
        if second.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError('second writer did not block on first advisory admission')
        time.sleep(0.02)  # Observation cadence only; admission is proved by pg_stat_activity.
    first.stdin.write('COMMIT;\n')
    first.stdin.close()
    first.stdin = None
    out, err = first.communicate(timeout=10)
    if first.returncode:
        raise RuntimeError(err)
    out, err = second.communicate(timeout=10)
    if second.returncode or out.strip() != 'already_resolved':
        raise RuntimeError('second writer did not consume first receipt: ' + out + err)
    result = subprocess.run(cmd + ['-c', 'SELECT count(*) FROM union_pnl_cash_outcome_resolutions;'], capture_output=True, text=True, check=True, timeout=5)
    if result.stdout.strip() != '1':
        raise RuntimeError('concurrency created duplicate certificates')
    print('PASS concurrent same-hand writer observed waiting on advisory lock, then consumes one immutable certificate')
finally:
    for process in (first, second):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
