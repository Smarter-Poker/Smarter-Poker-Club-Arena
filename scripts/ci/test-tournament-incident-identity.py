"""Actual PostgreSQL17 incident trigger and raiser; isolated reporting rows, no money operation."""
import argparse
import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
fixture = root / 'scripts/ci/probes/tournament-incident-identity'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=root / 'artifacts/tournament-incident-identity')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='incident-entity-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
psql = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', '55770', '-U', 'postgres', '-d', 'postgres']
installer = (root / 'supabase/migrations/20260914092500_tournament_finish_incident_identity.sql').read_text()
checks = []
source = 'Tournament.atomic_finish_refused'


def cmd(argv, sql=None):
    result = subprocess.run(list(map(str, argv)), input=sql, text=True, capture_output=True, env=env, timeout=25)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return cmd(psql, sql)


def check(name, passed):
    checks.append({'name': name, 'passed': bool(passed)})
    if not passed:
        raise AssertionError(name)


def quote(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def tournament(index):
    return '00000000-0000-0000-0000-' + format(index, '012x')


def alert(index, name=source, severity='critical', error=None, upper=False):
    entity = tournament(index) if index is not None else None
    if entity and upper:
        entity = entity.upper()
    context = {'error': error or '[Tournament.atomic_finish_refused] tournament ' + str(entity) + ' has no complete durable elimination sequence (1/1 of 2)', 'proven_refusal': True, 'outcome_unknown': False}
    if entity:
        context['tournament_id'] = entity
    sql = 'SET ROLE service_role; SELECT fn_raise_server_financial_alert(' + ','.join(map(quote, [severity, name, 'Tournament completion was definitively refused before commit and remains eligible for a corrected retry.', json.dumps(context)])) + ');'
    return run(sql)


def incidents():
    return json.loads(run("SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY created_at,id),'[]') FROM ca_drift_incidents i"))


try:
    check('native-postgres17', 'PostgreSQL) 17.' in cmd([pg / 'postgres', '--version']))
    cmd([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    cmd([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-o', f"-k {sock} -p 55770 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=10 -c statement_timeout=10000", '-w', 'start'])
    run((fixture / 'schema.sql').read_text())
    run((fixture / 'dependencies.sql').read_text())
    run((fixture / 'guard-declaration.sql').read_text())
    baseline = (fixture / 'baseline.sql').read_text()
    run(baseline)
    run('''CREATE TRIGGER financial_incident AFTER INSERT ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_financial_alert_to_incident();
      CREATE TRIGGER financial_resolution AFTER UPDATE ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident();
      REVOKE ALL ON FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb,text,text) TO service_role;
      REVOKE ALL ON FUNCTION fn_ca_financial_alert_to_incident() FROM PUBLIC,anon,authenticated,service_role;''')
    digest_sql = "SELECT md5(pg_get_functiondef('fn_ca_financial_alert_to_incident()'::regprocedure))"
    check('exact-live-trigger', run(digest_sql) == '591d71ae6e8a7572640e531d247b13bc')
    run("SELECT fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','native baseline')")
    old_a, old_b = alert(101), alert(102)
    before = incidents()
    check('baseline-folds-distinct-tournaments', len(before) == 1 and before[0]['occurrences'] == 2)
    check('baseline-columns-disagree-with-metadata', before[0]['tournament_id'] == tournament(101) and before[0]['metadata']['tournament_id'] == tournament(102))
    run('UPDATE financial_alerts SET resolved=true,resolution=\'native source closure\',resolved_at=now() WHERE id=' + quote(old_b))
    check('baseline-latest-alert-closes-other-entity', incidents()[0]['status'] == 'resolved')
    run('TRUNCATE financial_alerts,ca_incident_events,ca_drift_incidents,ca_detector_registry,ca_incident_file_failures RESTART IDENTITY CASCADE;')
    run('BEGIN;' + installer + 'COMMIT;')
    candidate_md5 = run(digest_sql)
    guard_sql = "SELECT def_hash,declared_ref FROM ca_guard_defs WHERE proname='fn_ca_financial_alert_to_incident'"
    candidate_guard = candidate_md5 + '|migration 20260914092500_tournament_finish_incident_identity'
    check('declaration-records-installed-body-and-migration', run(guard_sql) == candidate_guard)
    history_sql = "SELECT count(*) FROM ca_guard_def_history WHERE proname='fn_ca_financial_alert_to_incident' AND def_hash=" + quote(candidate_md5)
    check('declaration-preserves-exact-definition-history', run(history_sql + " AND def_text=pg_get_functiondef('fn_ca_financial_alert_to_incident()'::regprocedure)") == '1')
    (out / 'candidate-md5.txt').write_text(candidate_md5 + '\n')
    new_a, new_b = alert(101), alert(102)
    current = incidents()
    check('candidate-separates-tournaments', len(current) == 2)
    check('candidate-keeps-every-entity-consistent', all(row['tournament_id'] == row['metadata']['tournament_id'] for row in current))
    repeat_a = alert(101)
    current = incidents()
    a, b = [next(row for row in current if row['tournament_id'] == tournament(i)) for i in (101, 102)]
    check('same-tournament-recurs-on-one-incident', len(current) == 2 and a['occurrences'] == 2 and b['occurrences'] == 1)
    check('same-tournament-retains-original-and-latest-alerts', a['metadata']['alert_id'] == repeat_a and run('SELECT count(*) FROM financial_alerts WHERE id IN (' + ','.join(map(quote, [new_a, repeat_a])) + ')') == '2')
    run('UPDATE financial_alerts SET resolved=true,resolution=\'native source closure\',resolved_at=now() WHERE id=' + quote(repeat_a))
    current = incidents()
    check('source-resolution-is-entity-local', next(row for row in current if row['id'] == a['id'])['status'] == 'resolved' and next(row for row in current if row['id'] == b['id'])['status'] == 'open')
    alert(102)
    current = incidents()
    check('resolved-echo-does-not-absorb-other-tournament', next(row for row in current if row['id'] == a['id'])['occurrences'] == 2 and next(row for row in current if row['id'] == b['id'])['occurrences'] == 2)
    for i in (103, 104, 105):
        alert(i)
    current = incidents()
    check('five-different-tournaments-retain-five-identities', len(current) == 5 and len({row['tournament_id'] for row in current}) == 5)
    alert(102, error='A different terminal receipt is missing')
    check('same-tournament-distinct-cause-is-retained', len(incidents()) == 6)
    alert(106)
    alert(106, upper=True)
    check('uuid-case-replays-one-entity', run('SELECT count(*),sum(occurrences) FROM ca_drift_incidents WHERE tournament_id=' + quote(tournament(106))) == '1|2')
    unknown_a, unknown_b = alert(None), alert(None)
    unknown = [row for row in incidents() if row['tournament_id'] is None]
    check('unknown-entities-retain-individual-alerts', len(unknown) == 2 and {row['metadata']['alert_id'] for row in unknown} == {unknown_a, unknown_b})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        concurrent_ids = list(pool.map(alert, [107, 107]))
    check('concurrent-recurrence-keeps-one-entity', run('SELECT count(*),sum(occurrences) FROM ca_drift_incidents WHERE tournament_id=' + quote(tournament(107))) == '1|2')
    check('concurrent-original-alerts-retained', run('SELECT count(*) FROM financial_alerts WHERE id IN (' + ','.join(map(quote, concurrent_ids)) + ')') == '2')
    count_before = len(incidents())
    alert(108, severity='warning')
    alert(108, name='ServerTableEngine.authoritative_hand_semantic_refusal')
    check('unchanged-source-exclusions', len(incidents()) == count_before)
    alert(108, name='prize_credit_failed')
    alert(108, name='prize_credit_failed')
    check('existing-prize-identity-rule-retained', run("SELECT count(*),sum(occurrences) FROM ca_drift_incidents WHERE dedupe_key=" + quote('fa:prize_credit_failed:' + tournament(108))) == '1|2')
    check('real-notifier-takes-zero-money-withheld-path', int(run("SELECT count(*) FROM ca_incident_events WHERE kind='notify_withheld' AND detail->>'reason'='nothing is unaccounted for (0.00)'")) > 0)
    check('no-caught-filing-failures', run('SELECT count(*) FROM ca_incident_file_failures') == '0')
    check('no-notification-failures', run("SELECT count(*) FROM ca_incident_events WHERE kind='notify_failed'") == '0')
    check('service-does-not-gain-direct-table-writes', run("SELECT NOT has_table_privilege('service_role','financial_alerts','INSERT')") == 't')
    check('trigger-acl-stays-closed', run("SELECT NOT has_function_privilege('anon','fn_ca_financial_alert_to_incident()','EXECUTE') AND NOT has_function_privilege('authenticated','fn_ca_financial_alert_to_incident()','EXECUTE')") == 't')
    run('BEGIN;' + installer + 'COMMIT;')
    check('migration-replay-preserves-candidate', run(digest_sql) == candidate_md5)
    check('replay-keeps-one-history-row-and-declared-baseline', run(history_sql) == '1' and run(guard_sql) == candidate_guard)
    drift = baseline.replace('v_shape text;', 'v_shape text; -- unreviewed drift')
    run(drift)
    result = subprocess.run(psql, input='BEGIN;' + installer + 'COMMIT;', text=True, capture_output=True, env=env, timeout=10)
    check('migration-refuses-unreviewed-trigger', result.returncode != 0 and 'definition drift' in result.stderr)
    check('refusal-leaves-body-unchanged', run(digest_sql) not in ('591d71ae6e8a7572640e531d247b13bc', candidate_md5))
    check('refusal-does-not-declare-unreviewed-drift', run(guard_sql) == candidate_guard and run(history_sql) == '1')
    results = {'passed': True, 'checks': checks, 'baseline': before, 'candidate_md5': candidate_md5, 'scope': 'Actual incident trigger, raiser, source alert writer, scope, normalization, zero-discrepancy notification-withheld branch and resolution propagation. Isolated schema snapshots include actual columns and constraints. Other production triggers and financial execution are outside this reporting qualification; no external notification or production request.'}
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': True, 'checks': len(checks), 'candidate_md5': candidate_md5}))
finally:
    subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster / 'data'), '-m', 'immediate', '-w', 'stop'], capture_output=True, env=env, timeout=15)
    shutil.rmtree(cluster)
