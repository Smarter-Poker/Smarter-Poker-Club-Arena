"""Prove a source commit during the real initialization snapshot counts once."""
import os
import subprocess
import sys
import time

psql, socket, port, migration = sys.argv[1:]
base = [psql, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-U', 'fixture_admin', '-d', 'member_record_concurrency']
def query(sql):
    return subprocess.check_output(base + ['-c', sql], text=True).strip()

query("""
CREATE FUNCTION test_projection_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('test.seed',true)='true' THEN PERFORM pg_advisory_xact_lock(61718); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER test_projection_barrier BEFORE INSERT ON member_record_daily_facts
FOR EACH ROW EXECUTE FUNCTION test_projection_barrier();
""")
blocker = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
seed = None
try:
    blocker.stdin.write("SELECT pg_advisory_lock(61718); SELECT 'locked';\n")
    blocker.stdin.flush()
    while blocker.stdout.readline().strip() != 'locked':
        if blocker.poll() is not None:
            raise RuntimeError('Barrier session exited')
    seed = subprocess.Popen(base + ['-c', "SET test.seed='true'", '-f', migration],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, 'PGAPPNAME': 'member-record-seed-fixture'})
    deadline = time.monotonic() + 15
    while query("SELECT count(*) FROM pg_stat_activity WHERE application_name='member-record-seed-fixture' AND wait_event='advisory'") != '1':
        if seed.poll() is not None:
            raise RuntimeError('Seed exited before barrier: ' + seed.stderr.read())
        if time.monotonic() >= deadline:
            raise RuntimeError('Seed did not reach snapshot barrier')
        time.sleep(0.03)
    query("""INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid)
    VALUES('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',now(),'nlh',-10,1)""")
    blocker.stdin.write("SELECT pg_advisory_unlock(61718);\n\\q\n")
    blocker.stdin.flush()
    out, err = seed.communicate(timeout=15)
    if seed.returncode:
        raise RuntimeError(err)
    result = query("SELECT sum(hands)||':'||sum(net) FROM member_record_daily_facts WHERE club_id='00000000-0000-0000-0000-000000000001'")
    assert result == '13:-130', result
    print('MEMBER_RECORD_CONCURRENCY PASS: concurrent fact counted exactly once')
finally:
    if seed and seed.poll() is None:
        seed.kill()
    if blocker.poll() is None:
        blocker.terminate()
