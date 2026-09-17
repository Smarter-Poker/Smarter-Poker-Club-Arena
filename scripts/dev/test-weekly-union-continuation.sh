#!/usr/bin/env bash
# Protected executor payload only. UNRUN; not a direct pipeline fallback.
# Qualifies the documented unit seams, not a real financial book or activation.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd -P)
work="$root/tests/fixtures/weekly-union-continuation"
: "${PG_BIN:?Protected plan must supply its admitted PostgreSQL 17 provider}"
: "${ACCOUNTING_FIXTURE_PARENT:?Protected plan must supply reserved scratch storage}"
: "${ACCOUNTING_TEST_OUTPUT_DIR:?Protected plan must supply reserved durable output storage}"
: "${ACCOUNTING_EXECUTION_ID:?Protected plan must supply its public execution UUID}"
pgbin="$PG_BIN"
# Never let inherited libpq settings redirect this disposable local connection
# or read an ambient password/service file. No credential values are logged.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS
export PGPASSFILE=/dev/null
export PGCONNECT_TIMEOUT=10

python3 - "$root" "$pgbin" "$ACCOUNTING_FIXTURE_PARENT" "$ACCOUNTING_TEST_OUTPUT_DIR" "$ACCOUNTING_EXECUTION_ID" <<'PY'
from pathlib import Path
import re, sys
root, provider, scratch, output = (Path(p) for p in sys.argv[1:5])
if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', sys.argv[5]):
    raise SystemExit('A public execution UUID is required; it is not an authorization token')
for label, path in [('provider', provider), ('scratch', scratch), ('output', output)]:
    if not path.is_absolute() or not path.is_dir() or path.resolve() != path:
        raise SystemExit(f'{label} must be an existing canonical absolute admitted directory')
for path in (scratch, output):
    if path == root or root in path.parents or path in root.parents:
        raise SystemExit('Scratch and artifacts must be outside the source checkout and its ancestors')
if scratch == output or scratch in output.parents or output in scratch.parents:
    raise SystemExit('Scratch and durable output must be separate non-nested directories')
if not re.fullmatch(r'[A-Za-z0-9_./-]+', str(scratch)):
    raise SystemExit('Use an admitted short ASCII scratch path without whitespace')
if len(str(scratch / 'union-continuation.XXXXXX' / 'socket' / '.s.PGSQL.55508').encode()) > 100:
    raise SystemExit('Reserved scratch directory is too long for a portable Unix socket')
PY
for binary in postgres initdb pg_ctl psql pg_dump pg_config; do
  [ -x "$pgbin/$binary" ] || { echo "Missing admitted provider executable: $binary" >&2; exit 1; }
done

# A previously used output identity is never overwritten or appended to.
artifacts="$ACCOUNTING_TEST_OUTPUT_DIR/weekly-union-continuation-$ACCOUNTING_EXECUTION_ID"
mkdir "$artifacts"
fixture=''
start_attempted=0
checks_passed=0
phase=preflight
dump_stopped=1
# Bound only the dump process group created here. Provider/kernel filesystem
# stalls still require the protected owner's independent overall supervisor.
capture_schema() {
  local name=$1 dump_rc=0
  python3 - "$pgbin/pg_dump" "$fixture" "$name" <<'PY' || dump_rc=$?
from pathlib import Path
import json, os, signal, subprocess, sys
binary, scratch, name = sys.argv[1:]
scratch = Path(scratch)
with (scratch / (name + '.sql')).open('wb') as output, (scratch / (name + '.log')).open('wb') as errors:
    proc = subprocess.Popen([binary, '-w', '--schema-only', '--lock-wait-timeout=5s',
        '-U', 'postgres', '-h', str(scratch / 'socket'), '-p', '55508', '-d', 'postgres'],
        stdout=output, stderr=errors, start_new_session=True)
    timed_out = False
    try:
        code = proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            raise SystemExit(125)
        try:
            code = proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                raise SystemExit(125)
            try:
                code = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                errors.write(b'Owned dump did not reap after TERM/KILL deadlines; retain scratch.\n')
                raise SystemExit(125)
    receipt = dict(owned_pid=proc.pid, reaped=True,
        timed_out=timed_out, returncode=code, deadline_seconds=20,
        terminate_grace_seconds=3, kill_grace_seconds=2)
    (scratch / (name + '.process.json')).write_text(json.dumps(receipt) + '\n')
    errors.write((json.dumps(receipt) + '\n').encode())
    raise SystemExit(124 if timed_out else (0 if code == 0 else 1))
PY
  if ! python3 - "$fixture/$name.process.json" <<'PY'
from pathlib import Path
import json, sys
record = json.loads(Path(sys.argv[1]).read_text())
if record.get('reaped') is not True or not isinstance(record.get('owned_pid'), int):
    raise SystemExit('No completed owned-dump reap receipt')
PY
  then dump_stopped=0; fi
  return "$dump_rc"
}
cleanup() {
  local result=$? stop_ok=1 archive_ok=1 status_rc=0 retained='' finalized=0
  trap - EXIT INT TERM
  set +e
  if [ -n "$fixture" ]; then
    if [ "$start_attempted" = 1 ]; then
      "$pgbin/pg_ctl" -D "$fixture/data" status > "$fixture/status-before-stop.log" 2>&1
      status_rc=$?
      if [ "$status_rc" = 0 ] && [ "$checks_passed" != 1 ]; then
        # Diagnostic timeout/failure returns to the owned shutdown step. An
        # unreaped diagnostic is a separate reason to preserve this fixture.
        capture_schema failure-schema
      fi
      if [ "$status_rc" = 0 ] || [ -f "$fixture/data/postmaster.pid" ]; then
        "$pgbin/pg_ctl" -D "$fixture/data" -w -t 30 -m immediate stop > "$fixture/stop.log" 2>&1 || stop_ok=0
      elif [ "$status_rc" != 3 ]; then
        stop_ok=0
      fi
      "$pgbin/pg_ctl" -D "$fixture/data" status > "$fixture/status-after-stop.log" 2>&1
      status_rc=$?
      if [ "$status_rc" != 3 ] || [ -f "$fixture/data/postmaster.pid" ]; then stop_ok=0; fi
    fi
    # Copy every top-level evidence file, including partial logs after failure.
    # Never copy the live database or provider. Failed archival preserves scratch.
    for file in "$fixture"/*; do
      [ -f "$file" ] || continue
      cp "$file" "$artifacts/" || archive_ok=0
    done
    if [ "$stop_ok" != 1 ] || [ "$archive_ok" != 1 ] || [ "$dump_stopped" != 1 ]; then
      retained="$fixture"
      result=1
    fi
  fi
  if [ "$checks_passed" != 1 ]; then result=1; fi
  # No successful outcome is authoritative while this durable marker exists.
  # Publish the complete, fsynced pair as one directory before deleting scratch.
  if python3 - "$artifacts" "$ACCOUNTING_EXECUTION_ID" "$result" "$phase" "$stop_ok" "$archive_ok" "$retained" "$checks_passed" "$fixture" "$dump_stopped" <<'PY'
from pathlib import Path
import datetime, hashlib, json, os, sys
out, execution, result, phase, stopped, archived, retained, checked, scratch, dump_stopped = sys.argv[1:]
out = Path(out)
def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
def write_synced(path, value):
    with path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
write_synced(out / 'cleanup-pending.json', dict(execution_id=execution,
    scratch_path=scratch or None, state='terminal_not_committed'))
sync_directory(out)
stage = out / '.terminal-staging'
stage.mkdir()
record = dict(format_version=2, execution_id=execution, exit_code=int(result), last_phase=phase,
    fixture_checks_completed=checked == '1', local_shutdown_check_passed=stopped == '1',
    archival_completed=archived == '1', retained_scratch=retained or None,
    owned_dump_reaped=dump_stopped == '1', scratch_path=scratch or None,
    scratch_removal_authorized=bool(scratch) and not retained,
    full_book_qualified=False, activation_qualified=False, independent_cleanup_receipt_required=True,
    recorded_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
hashes = {}
for path in sorted(out.iterdir()):
    if path.is_file() and path.name != 'cleanup-pending.json':
        with path.open('r+b') as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
            hashes[path.name] = digest.hexdigest()
            os.fsync(stream.fileno())
write_synced(stage / 'outcome.json', record)
hashes['terminal/outcome.json'] = hashlib.sha256((stage / 'outcome.json').read_bytes()).hexdigest()
write_synced(stage / 'artifact-sha256.json', dict(format_version=2,
    execution_id=execution, files=hashes))
sync_directory(stage)
os.rename(stage, out / 'terminal')
sync_directory(out)
PY
  then finalized=1; else result=1; retained="$fixture"; fi
  if [ "$finalized" = 1 ]; then
    if [ -n "$fixture" ] && [ -z "$retained" ]; then
      if ! rm -rf -- "$fixture"; then retained="$fixture"; result=1; finalized=0; fi
    fi
    if [ "$finalized" = 1 ]; then
      # Positive commit plus pending-marker removal makes the pair eligible
      # for intake. The independent protected exit/cleanup receipt is required.
      if ! python3 - "$artifacts" "$result" <<'PY'
from pathlib import Path
import hashlib, json, os, sys
out = Path(sys.argv[1])
descriptor = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
try:
    manifest = out / 'terminal/artifact-sha256.json'
    commit = dict(format_version=2, exit_code=int(sys.argv[2]),
        manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest())
    with (out / '.terminal-commit-staging').open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(commit, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.rename(out / '.terminal-commit-staging', out / 'terminal-commit.json')
    os.fsync(descriptor)
    (out / 'cleanup-pending.json').unlink()
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
      then result=1; finalized=0; fi
    fi
  fi
  if [ "$finalized" != 1 ]; then
    echo 'ERROR: terminal evidence is uncommitted; reject any provisional outcome and preserve available artifacts/scratch.' >&2
  fi
  [ -z "$retained" ] || echo "ERROR: fixture retained for protected cleanup/evidence recovery: $retained" >&2
  echo "Continuation unit payload exit=$result; artifacts: $artifacts"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$pgbin/postgres" --version > "$artifacts/provider-version.txt" 2>&1
"$pgbin/pg_config" --version >> "$artifacts/provider-version.txt" 2>&1
python3 - "$root" "$pgbin" "$artifacts" "$ACCOUNTING_EXECUTION_ID" <<'PY'
from pathlib import Path
import hashlib, json, re, sys
root, provider, out = map(Path, sys.argv[1:4])
versions = (out / 'provider-version.txt').read_text().splitlines()
if len(versions) != 2 or any(not re.search(r'\bPostgreSQL\)? 17(?:\.|\b)', v) for v in versions):
    raise SystemExit('Admitted server and pg_config must both identify PostgreSQL 17')
entry = root / 'tests/fixtures/weekly-union-continuation/load.sql'
base = root / 'tests/fixtures/weekly-scheduler-fairness/load.sql'
pending = [entry, root / 'tests/fixtures/weekly-union-continuation/regression.sql',
           root / 'tests/fixtures/weekly-union-continuation/README.md',
           root / 'tests/fixtures/weekly-union-continuation/RUNNER.md',
           root / 'tests/fixtures/weekly-scheduler-fairness/pg-cron-prerequisites.sql',
           root / 'scripts/dev/test-weekly-union-continuation.sh']
files = {}
while pending:
    path = pending.pop().resolve()
    if root not in path.parents or not path.is_file():
        raise SystemExit('Fixture include escaped or is absent: ' + str(path))
    name = str(path.relative_to(root))
    if name in files:
        continue
    data = path.read_bytes()
    files[name] = hashlib.sha256(data).hexdigest()
    if path.suffix == '.sql':
        for command, target in re.findall(r'^\s*\\(ir|i)\s+([^\r\n]+)$', data.decode(), re.M):
            if target == ':base_load' and path == entry:
                pending.append(base)
            elif target.startswith(':') or command != 'ir':
                raise SystemExit('Unreviewed dynamic fixture include: ' + target)
            else:
                pending.append(path.parent / target)
(out / 'source-observation.json').write_text(json.dumps(dict(execution_id=sys.argv[4],
    source_root=str(root), files=dict(sorted(files.items())),
    boundary='Observed bytes only; protected owner must match its separately admitted binding'), indent=2) + '\n')
(out / 'provider-observation.json').write_text(json.dumps(dict(provider_root=str(provider),
    binaries={n: hashlib.sha256((provider / n).read_bytes()).hexdigest()
              for n in ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_config']}), indent=2) + '\n')
PY

phase=cluster-start
fixture=$(mktemp -d "$ACCOUNTING_FIXTURE_PARENT/union-continuation.XXXXXX")
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -U postgres -A trust --no-locale -E UTF8 > "$fixture/initdb.log" 2>&1
start_attempted=1
"$pgbin/pg_ctl" -D "$fixture/data" -w -t 30 -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55508 -h '' -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c statement_timeout=120s -c lock_timeout=5s" \
  start > "$fixture/start.log" 2>&1
psql=("$pgbin/psql" -X -w -v ON_ERROR_STOP=1 -U postgres -h "$fixture/socket" -p 55508 -d postgres)
phase=provider-prerequisites
"${psql[@]}" -f "$root/tests/fixtures/weekly-scheduler-fairness/pg-cron-prerequisites.sql" \
  > "$fixture/prerequisites.log" 2>&1
"${psql[@]}" -q -A -t > "$fixture/runtime.json" 2> "$fixture/runtime.log" <<'SQL'
DO $$BEGIN
 IF now()<'2026-09-14 07:00Z'::timestamptz THEN RAISE EXCEPTION 'fixture real closed-week prerequisite not reached';END IF;
 IF current_setting('listen_addresses')<>'' OR current_setting('cron.launch_active_jobs')<>'off' THEN
  RAISE EXCEPTION 'fixture must be socket-only with job launch disabled';END IF;
END$$;
SELECT jsonb_build_object('server_version',version(),'server_version_num',current_setting('server_version_num'),
 'database',current_database(),'user',current_user,'observed_at',clock_timestamp(),
 'cron_launch_active_jobs',current_setting('cron.launch_active_jobs'),
 'cron_database',current_setting('cron.database_name'),'listen_addresses',current_setting('listen_addresses'),
 'pg_cron_version',(SELECT extversion FROM pg_extension WHERE extname='pg_cron'));
SQL

# One session is required: load.sql sets the fixture clock and attempt budget.
# The baseline and final captures run in that same session around the regression.
cat > "$fixture/before.sql" <<SQL
\o $fixture/before-state.json
SELECT public.test_union_continuation_snapshot(public.u(1001));
\o
\echo CONTINUATION_REGRESSION_BEGIN
SQL
cat > "$fixture/after.sql" <<SQL
\echo CONTINUATION_REGRESSION_END
\o $fixture/after-state.json
SELECT public.test_union_continuation_snapshot(public.u(1001));
\o
\o $fixture/accepted-authority.json
SELECT jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
 'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f';
\o
\o $fixture/roles.json
SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rolname) FROM pg_roles r),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m));
\o
\o $fixture/cron-state.json
SELECT jsonb_build_object('launch_active_jobs',current_setting('cron.launch_active_jobs'),
 'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j),
 'runs',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.runid) FROM cron.job_run_details d));
\o
DO \$\$BEGIN IF current_setting('cron.launch_active_jobs')<>'off'
 OR EXISTS(SELECT 1 FROM cron.job_run_details) THEN RAISE EXCEPTION 'fixture cron execution was not disabled';END IF;END\$\$;
SQL
phase=unit-regression
"${psql[@]}" -q -A -t -v accounting_source_root="$root" \
  -f "$work/load.sql" -f "$fixture/before.sql" -f "$work/regression.sql" -f "$fixture/after.sql" \
  > "$fixture/assertions.log" 2>&1
phase=evidence-checks
python3 - "$fixture" "$root" "$artifacts/source-observation.json" <<'PY'
from pathlib import Path
import hashlib, json, re, sys
fixture, root, manifest = map(Path, sys.argv[1:])
log = (fixture / 'assertions.log').read_text()
if log.count('CONTINUATION_REGRESSION_BEGIN') != 1 or log.count('CONTINUATION_REGRESSION_END') != 1:
    raise SystemExit('Regression did not reach both observed boundaries')
body = log.split('CONTINUATION_REGRESSION_BEGIN', 1)[1].split('CONTINUATION_REGRESSION_END', 1)[0]
count = len(re.findall(r'NOTICE:\s+PASS: ', body))
if count != 20:
    raise SystemExit(f'Continuation assertion executions changed: expected 20, observed {count}')
if re.search(r'(?:ERROR|FATAL|PANIC):', log):
    raise SystemExit('Unexpected database error in the successful fixture transcript')
before = json.loads((fixture / 'before-state.json').read_text())
after = json.loads((fixture / 'after-state.json').read_text())
if before != after:
    raise SystemExit('Rollback-isolated scenarios did not restore the exact common fixture state')
for name, expected in json.loads(manifest.read_text())['files'].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Source changed during protected execution: ' + name)
(fixture / 'assertion-count.json').write_text(json.dumps(dict(observed=count, expected=20,
    baseline_restored=True, source_bytes_stable=True, scope='unit fixture with declared seams')) + '\n')
PY
capture_schema accepted-schema
checks_passed=1
phase=unit-checks-complete
# EXIT always performs shutdown, archival and the final outcome record. Its
# local shutdown observation still needs independent protected cleanup intake.
