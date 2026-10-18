"""Qualify actual trigger replacement under live reader/writer table locks."""
import contextlib
import select
import subprocess
import sys

psql, socket, port, migration = sys.argv[1:]
base = [psql, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port,
        '-U', 'fixture_admin', '-d', 'member_record_context_locks']


def run(sql=None, file=None):
    args = base + (['-f', file] if file else ['-c', sql])
    return subprocess.run(args, capture_output=True, text=True, timeout=15)


def scalar(sql):
    result = run(sql)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


@contextlib.contextmanager
def hold(mode, relations, label):
    proc = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1)
    try:
        proc.stdin.write("SET application_name='" + label + "'; BEGIN; LOCK TABLE " +
                         relations + ' IN ' + mode + " MODE;\n\\echo LOCK_READY\n")
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 10)
        assert ready and proc.stdout.readline().strip() == 'LOCK_READY', 'lock holder not ready'
        yield
    finally:
        if proc.poll() is None:
            proc.stdin.write('ROLLBACK;\n\\q\n')
            proc.stdin.flush()
        proc.communicate(timeout=10)
        assert proc.returncode == 0, 'fixture lock holder did not exit cleanly'


# Real writers still win: preserve the production two-second lock deadline.
with hold('ROW EXCLUSIVE', 'public.profiles', 'member_record_fixture_writer'):
    blocked = run(file=migration)
    assert blocked.returncode != 0 and 'lock timeout' in blocked.stderr, blocked.stderr
    assert scalar("SELECT to_regprocedure('public.fn_publish_member_record_context()') IS NULL") == 't'
    assert scalar("SELECT pg_get_triggerdef(oid) NOT LIKE '%player_number%' FROM pg_trigger WHERE tgname='member_record_profile'") == 't'

relations = ','.join('public.' + name for name in (
    'profiles', 'club_members', 'clubs', 'agents', 'tables', 'chip_transactions',
    'ca_club_rake_daily_user', 'ca_club_member_tournament_fee_daily'))
with hold('ACCESS SHARE', relations, 'member_record_fixture_reader'):
    # Exact failed operation from production: DROP requires ACCESS EXCLUSIVE.
    before = run("BEGIN; SET LOCAL lock_timeout='250ms'; DROP TRIGGER member_record_profile ON public.profiles; COMMIT;")
    assert before.returncode != 0 and 'lock timeout' in before.stderr, before.stderr
    fixed = run(file=migration)
    assert fixed.returncode == 0, fixed.stderr
    assert scalar("SELECT count(*) FROM pg_stat_activity WHERE application_name='member_record_fixture_reader' AND state='idle in transaction'") == '1'
    assert scalar("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'member_record%' AND tgenabled='O'") == '15'
print('MEMBER_RECORD_TRIGGER_LOCKS PASS: DROP blocked by readers, replacement succeeds, writer deadline preserved')
