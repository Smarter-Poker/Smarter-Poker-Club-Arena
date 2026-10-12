from pathlib import Path
import select
import os
import subprocess
import sys
import time

pgbin, socket, migration = sys.argv[1:]
command = [str(Path(pgbin) / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '56436', '-U', 'postgres', '-d', 'postgres']
sql = Path(migration).read_text()
frozen = """BEGIN;
INSERT INTO engine_maintenance_break VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes','native freeze refusal',NULL,clock_timestamp(),true,'00000000-0000-0000-0000-000000000001');
""" + sql.replace('BEGIN;', '', 1)
result = subprocess.run(command, input=frozen, text=True, capture_output=True, timeout=15)
if result.returncode == 0 or 'POSTHAND_ESCROW_INSTALLATION_REQUIRES_THAW' not in result.stderr:
    raise SystemExit('frozen installation did not refuse for its exact reason: ' + result.stderr)
print('PASS actual maintenance freeze refuses installation and disconnect rolls back originals')
owner = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
try:
    owner.stdin.write(b"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo ORIGINAL_OWNER_READY\n")
    owner.stdin.flush()
    deadline = time.monotonic() + 10
    ready = False
    output = b''
    while time.monotonic() < deadline:
        if select.select([owner.stdout], [], [], max(0, deadline-time.monotonic()))[0]:
            output += os.read(owner.stdout.fileno(), 65536)
            if b'ORIGINAL_OWNER_READY' in output:
                ready = True
                break
        if owner.poll() is not None:
            break
    if not ready:
        raise SystemExit('original scheduler owner readiness missing')
    result = subprocess.run(command + ['-f', migration], text=True, capture_output=True, timeout=15)
    if result.returncode == 0 or 'POSTHAND_ESCROW_ORIGINAL_READER_OPERATION_OWNED' not in result.stderr:
        raise SystemExit('active original scheduler admission was not refused: ' + result.stderr)
    print('PASS controlled active original scheduler transaction refuses competing installation')
finally:
    if owner.poll() is None:
        try:
            owner.stdin.write(b'ROLLBACK;\n\\q\n')
            owner.stdin.flush()
            owner.wait(timeout=5)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            owner.kill()
            owner.wait(timeout=5)
