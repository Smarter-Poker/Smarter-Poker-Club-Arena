"""Actual keepalive/fold transactions on the existing isolated Lightning fixture."""
import json
import subprocess
import time
from pathlib import Path


def qualify(root, pg, port, sql):
    here = Path(__file__).parent
    migration = root / 'supabase/migrations/20261020145913_lightning_keepalive_does_not_lock_an_already_covered_deadline.sql'
    sql('ALTER TABLE lightning_instance ADD COLUMN deadline_at timestamptz, ADD COLUMN hand_id uuid')
    sql((here / 'keepalive-before.sql').read_text())
    signature = 'fn_lightning_instance_keepalive(uuid,interval,timestamptz)'
    assert sql(f"SELECT md5(pg_get_functiondef('{signature}'::regprocedure))") == '5f1ffb62c357ce54e781c9a068eec1b3'
    metadata = sql(f"SELECT ROW(proowner,proacl,prosecdef,proconfig)::text FROM pg_proc WHERE oid='{signature}'::regprocedure")
    instance = '00000000-0000-0000-0000-000000000001'
    hand = '00000000-0000-0000-0000-000000000002'
    cmd = [str(pg / 'psql'), '-X', '-q', '-h', '127.0.0.1', '-p', port,
           '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1']

    def query(statement):
        result = subprocess.run(cmd, input=statement, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    def keepalive(args="interval '45 seconds',clock_timestamp()"):
        return f"SELECT fn_lightning_instance_keepalive('{instance}',{args})"

    def reset(window='10 minutes'):
        query(f"UPDATE lightning_instance SET state='dealing',hand_id='{hand}',deadline_at=clock_timestamp()+interval '{window}' WHERE id='{instance}'; UPDATE lightning_hand_player SET folded_at=NULL,fold_type=NULL; UPDATE lightning_reservation SET state='committed'; DELETE FROM cash_cluster_events")

    def hold(statement, name):
        child = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        child.stdin.write(f"SET application_name='{name}';BEGIN;{statement};SELECT pg_sleep(2);COMMIT;\n")
        child.stdin.close()
        for _ in range(150):
            if query(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='PgSleep'") == '1':
                return child
            time.sleep(.01)
        child.kill()
        child.wait()
        raise AssertionError(f'{name} did not reach its held transaction')

    def finish(child):
        child.wait(timeout=8)
        assert child.returncode == 0, child.stderr.read()
        child.stdout.close()
        child.stderr.close()

    def blocked(statement):
        try:
            query("SET lock_timeout='200ms';" + statement)
        except RuntimeError as error:
            assert 'lock timeout' in str(error), str(error)
        else:
            raise AssertionError('exclusive state custody did not exclude the contender')

    fold = f"SELECT fn_lightning_fast_fold('{hand}',lpad('12',32,'0')::uuid,gen_random_uuid(),'normal',1)"

    def covered(patched):
        reset()
        child = hold(keepalive(), 'keepalive-covered-proof')
        try:
            if not patched:
                blocked(fold)
            else:
                result = json.loads(query("SET lock_timeout='250ms';" + fold))
                assert result['ok'] is True and result['released'] is True
                # The answer is an observation at its MVCC read, not a new
                # promise: a terminal transition may follow it immediately.
                query(f"SET lock_timeout='250ms';UPDATE lightning_instance SET state='completed' WHERE id='{instance}'")
                assert json.loads(query(keepalive()))['reason'] == 'wrong_state'
        finally:
            finish(child)
        print('PASS: covered heartbeat ' + ('does not lock a fold or terminal transition; cannot revive completed state' if patched else 'reproduces unnecessary exclusive lock blocking a fold'))

    covered(False)
    sql(migration.read_text())
    assert sql(f"SELECT ROW(proowner,proacl,prosecdef,proconfig)::text FROM pg_proc WHERE oid='{signature}'::regprocedure") == metadata
    covered(True)

    reset()
    before = query(f"SELECT ROW(xmin,ctid,deadline_at)::text FROM lightning_instance WHERE id='{instance}'")
    result = query('BEGIN;' + keepalive() + ';SELECT txid_current_if_assigned() IS NULL;COMMIT').splitlines()
    assert json.loads(result[0])['alive'] is True and result[1] == 't'
    assert query(f"SELECT ROW(xmin,ctid,deadline_at)::text FROM lightning_instance WHERE id='{instance}'") == before
    print('PASS: covered deadline preserves tuple identity/deadline and assigns no writing transaction ID')

    reset('5 seconds')
    child = hold(keepalive("interval '2 minutes',clock_timestamp()"), 'keepalive-extension-proof')
    try:
        blocked(fold)
        blocked(f"UPDATE lightning_instance SET state='abandoned' WHERE id='{instance}'")
    finally:
        finish(child)
    assert query(f"SELECT deadline_at>clock_timestamp()+interval '100 seconds' FROM lightning_instance WHERE id='{instance}'") == 't'
    deadline = query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'")
    assert json.loads(query(keepalive("interval '30 seconds',clock_timestamp()")))['alive'] is True
    assert query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'") == deadline

    # Terminal writer wins first: the fallback must re-read after the lock,
    # refusing rather than granting an extension from an old snapshot.
    reset('5 seconds')
    child = hold(f"UPDATE lightning_instance SET state='abandoned' WHERE id='{instance}'", 'keepalive-terminal-proof')
    waiter = None
    try:
        blocked(keepalive("interval '2 minutes',clock_timestamp()"))
        waiter = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        waiter.stdin.write("SET application_name='keepalive-reread-proof';" + keepalive() + ';\n')
        waiter.stdin.close()
        for _ in range(100):
            if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='keepalive-reread-proof' AND wait_event_type='Lock'") == '1':
                break
            time.sleep(.01)
        else:
            raise AssertionError('keepalive did not wait behind terminal custody')
    finally:
        finish(child)
        if waiter is not None:
            waiter.wait(timeout=8)
            assert waiter.returncode == 0, waiter.stderr.read()
            assert json.loads(waiter.stdout.read())['reason'] == 'wrong_state'
            waiter.stdout.close()
            waiter.stderr.close()
    deadline = query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'")
    assert json.loads(query(keepalive()))['reason'] == 'wrong_state'
    assert query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'") == deadline

    reset('-1 second')
    deadline = query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'")
    assert json.loads(query(keepalive()))['reason'] == 'past_deadline'
    assert query(f"SELECT deadline_at FROM lightning_instance WHERE id='{instance}'") == deadline
    assert json.loads(query("SELECT fn_lightning_instance_keepalive(gen_random_uuid())"))['reason'] == 'not_found'

    for extension, minimum, maximum, clock in [
        ("interval '0 seconds'", 29, 31, 'clock_timestamp()'),
        ('NULL', 119, 121, 'NULL'),
        ("interval '1 day'", 899, 901, 'clock_timestamp()'),
        ("interval '45 seconds'", 44, 46, "clock_timestamp()+interval '1 day'"),
    ]:
        reset('5 seconds')
        assert json.loads(query(keepalive(f'{extension},{clock}')))['alive'] is True
        assert query(f"SELECT extract(epoch FROM deadline_at-clock_timestamp()) BETWEEN {minimum} AND {maximum} FROM lightning_instance WHERE id='{instance}'") == 't'
    reset()
    query(f"UPDATE lightning_instance SET state='settling' WHERE id='{instance}'")
    assert json.loads(query(keepalive()))['alive'] is True
    reset('5 seconds')
    query(f"UPDATE lightning_instance SET state='reserved' WHERE id='{instance}'")
    assert json.loads(query(keepalive()))['reason'] == 'wrong_state'
    try:
        sql(migration.read_text())
    except RuntimeError as error:
        assert 'preimage changed' in str(error)
    else:
        raise AssertionError('keepalive migration replay accepted')
    print('PASS: real extensions retain exclusive custody; terminal/expired/missing refuse; forward-only, future clamp, null defaults and interval bounds hold; metadata preserved and replay refused')
