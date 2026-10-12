"""Focused successor of the existing pg_cron job; no new schedule owner."""
from pathlib import Path
import json, subprocess, time
from satellite_qualifier_fixture import sha, lit

MIGRATION = Path('supabase/migrations/20261012195926_existing_horse_retention_uses_a_supported_thirty_second_interval.sql')

def qualify(e):
    migration = MIGRATION
    assert migration is not None
    root = e.root; db = 'postgres'; passed = []
    e.report['source_sha256'].update({str(migration): sha(root/migration),
        'scripts/verification-harness/horse-retention-subminute-cadence.py': sha(Path(__file__))})
    def read(q, label): return e.sql(db, q, label='subminute-'+label)[1].strip()
    def yes(q, label):
        assert read(q, label) == 't', label
        passed.append(label)
    def admin(q, label):
        return e.run('subminute-admin-'+label, [e.pg/'psql', '-X', '-qAt', '-h', str(e.socket),
            '-p', e.port, '-U', 'supabase_admin', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', q])
    original = json.loads(read('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;', 'original-rows'))
    yes("SELECT schedule='* * * * *' AND active AND md5(command)='96244362bf46b39e75ef1100b1372203' FROM cron.job WHERE jobid=117;", 'before-original-owner-still-once-per-minute')
    body = (root/migration).read_text().replace('BEGIN;', '', 1).rsplit('COMMIT;', 1)[0]
    yes("BEGIN;SELECT cron.alter_job(117,active:=false);"+body+
        "SELECT NOT active AND schedule='30 seconds' FROM cron.job WHERE jobid=117;ROLLBACK;", 'held-original-remains-held')
    e.sql(db, 'BEGIN;'+body+'ROLLBACK;', label='subminute-migration-rollback')
    assert json.loads(read('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;', 'rollback-rows')) == original
    passed.append('rollback-preserves-every-original-job-field')
    for column, value in [('command', "'SELECT 1'"), ('username', "'supabase_admin'"),
                          ('schedule', "'*/5 * * * *'"), ('database', "'template1'")]:
        admin('SELECT cron.alter_job(117,'+column+':='+value+');', 'drift-'+column)
        code, _, err = e.sql(db, file=root/migration, label='subminute-refuse-'+column, check=False)
        assert code and 'HORSE_RETENTION_SUBMINUTE_SOURCE_CHANGED' in err
        passed.append(column+'-drift-refused')
        admin('SELECT cron.alter_job(117,'+column+':='+lit(original[0][column])+');', 'restore-'+column)
    # The real C API parser rejects unsupported intervals without altering the
    # original row. Acceptance of our exact source later proves 30 seconds.
    code, _, _ = e.sql(db, "SELECT cron.alter_job(117,schedule:='60 seconds');", label='subminute-invalid-interval', check=False)
    assert code
    assert json.loads(read('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;', 'parser-refusal-rows')) == original
    passed.append('actual-interval-parser-refusal-is-atomic')
    argv = [str(e.pg/'psql'), '-X', '-qAt', '-h', str(e.socket), '-p', e.port, '-d', db, '-v', 'ON_ERROR_STOP=1']
    holder = subprocess.Popen(argv+['-U', 'supabase_admin'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    racer = None
    changed = original[0]['command']+'\n-- Native competing owner\n'
    try:
        holder.stdin.write("BEGIN;SELECT jobid FROM cron.job WHERE jobid=117 FOR UPDATE;SELECT 'held';\n"); holder.stdin.flush()
        assert holder.stdout.readline().strip() == '117' and holder.stdout.readline().strip() == 'held'
        racer = subprocess.Popen(argv+['-U', 'postgres', '-c', "SET application_name='horse_subminute_cadence_race';"+(root/migration).read_text()], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        waited = False
        for _ in range(100):
            if read("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='horse_subminute_cadence_race' AND wait_event_type='Lock');", 'observe-original-api-lock') == 't':
                waited = True; break
            time.sleep(.025)
        assert waited
        holder.stdin.write('UPDATE cron.job SET command='+lit(changed)+' WHERE jobid=117;COMMIT;\n'); holder.stdin.close()
        holder.wait(timeout=10); _, err = racer.communicate(timeout=10)
        assert holder.returncode == 0 and racer.returncode and 'HORSE_RETENTION_SUBMINUTE_POSTIMAGE_CHANGED' in err
        yes('SELECT command='+lit(changed)+" AND schedule='* * * * *' FROM cron.job WHERE jobid=117;", 'race-keeps-foreign-field-and-rolls-back-own-schedule')
    finally:
        for process in [holder, racer]:
            if process is not None and process.poll() is None: process.terminate(); process.wait(timeout=10)
    admin('SELECT cron.alter_job(117,command:='+lit(original[0]['command'])+');', 'restore-native-original-command')
    e.sql(db, file=root/migration, label='subminute-exact-supported-api-install')
    actual = json.loads(read('SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;', 'installed-rows'))
    assert actual[0]['schedule'] == '30 seconds'
    expected = json.loads(json.dumps(original)); expected[0]['schedule'] = '30 seconds'
    assert actual == expected
    passed.extend(['real-native-c-api-accepts-exact-thirty-second-interval', 'only-original-schedule-changes-no-new-job', 'original-activation-command-and-foreign-job-exact'])
    code, _, err = e.sql(db, file=root/migration, label='subminute-replay-refusal', check=False)
    assert code and 'HORSE_RETENTION_SUBMINUTE_SOURCE_CHANGED' in err
    passed.append('installed-successor-replay-refused')
    # Exercise the unchanged command's own no-overlap branch at its final
    # schedule. No alternate financial/prune function or extra job is created.
    holder = subprocess.Popen(argv+['-U', 'postgres'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        holder.stdin.write("SELECT pg_advisory_lock(hashtext('sp-prune-hand-history'));SELECT 'held';\n"); holder.stdin.flush()
        holder.stdout.readline(); assert holder.stdout.readline().strip() == 'held'
        assert read(original[0]['command'], 'unchanged-original-owner-overlap') == 'skipped: previous run still in progress'
        passed.append('unchanged-original-command-refuses-overlap')
    finally:
        if holder.poll() is None: holder.terminate(); holder.wait(timeout=10)
    yes("SELECT NOT rolsuper AND NOT has_table_privilege('cron.job','UPDATE') AND has_table_privilege('cron.job','SELECT') FROM pg_roles WHERE rolname=current_user;", 'provider-least-privilege-unexpanded')
    e.report['retention_subminute_proven'] = passed
    e.report['retention_subminute_native'] = {'existing_job':117, 'before_schedule':'* * * * *',
        'after_schedule':'30 seconds', 'actual_C_API_interval_parser':True,
        'scheduler_execution_disabled':True, 'production_capacity_verified':False,
        'limit':'Two nominal opportunities per minute, not a measured production throughput guarantee; unchanged serial owner and original advisory refusal prevent overlapping prune transactions.',
        'one_instance_contract_source':'https://github.com/citusdata/pg_cron#how-pg_cron-works'}
    return passed
