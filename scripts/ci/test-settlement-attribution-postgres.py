#!/usr/bin/env python3
"""Qualify the exact C1 migration and real query results on socket-only PG17."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
cluster = Path(tempfile.mkdtemp(prefix='ca-attribution-', dir=args.scratch))
data = cluster / 'data'
socket = Path(tempfile.mkdtemp(prefix='ca-at-', dir=tempfile.gettempdir()))
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
started = False

def run(argv, sql=None, refusal=None):
    result = subprocess.run([str(x) for x in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=60)
    if refusal:
        assert result.returncode != 0 and refusal in result.stderr, result.stderr + result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()

def query(sql, refusal=None):
    return run([pg/'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At',
                '-h', socket, '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql, refusal)

signature = 'public.fn_ca_settlement_correctness_check()'
catalog = "SELECT json_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) FROM pg_proc WHERE oid='" + signature + "'::regprocedure;"
baseline = (ROOT/'scripts/ci/fixtures/settlement-attribution/baseline.sql').read_text().rstrip() + '\n'
migrations = list((ROOT/'supabase/migrations').glob('*_bound_settlement_attribution_scan_before_result_limit.sql'))
assert len(migrations) == 1
migration = migrations[0].read_text()
old = re.search(r'\$old\$(.*?)\$old\$', migration, re.S).group(1)
new = re.search(r'\$new\$(.*?)\$new\$', migration, re.S).group(1)
assert hashlib.md5(baseline.encode()).hexdigest() == '6592ae7ce48565652dd101a85ecd8172'
assert baseline.count(old) == 1
assert new.count('LIMIT 20') == 1 and new.endswith('SELECT * FROM attributed LIMIT 20')
assert new[new.index('(\n') + 2:new.rindex('\n    )')].replace('\n  ', '\n').lstrip() == old.removesuffix('\n    LIMIT 20').lstrip()

try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    assert json.loads(query("SELECT json_build_object('address',inet_server_addr(),'data',current_setting('data_directory'),'listen',current_setting('listen_addresses'));")) == {'address': None, 'data': str(data), 'listen': ''}
    query('CREATE ROLE service_role;')
    query(baseline + ';\nREVOKE ALL ON FUNCTION ' + signature + ' FROM PUBLIC; GRANT EXECUTE ON FUNCTION ' + signature + ' TO service_role;')
    before = query(catalog)
    assert query("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure));") == '6592ae7ce48565652dd101a85ecd8172'
    query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    assert query(catalog) == before
    assert query("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure));") == '6592ae7ce48565652dd101a85ecd8172'
    query('ALTER FUNCTION ' + signature + ' SET search_path=public,pg_temp;')
    query(migration, 'SETTLEMENT_ATTRIBUTION_SOURCE_CHANGED')
    query(baseline)
    query(migration)
    assert query(catalog) == before
    installed = query("SELECT pg_get_functiondef('"+signature+"'::regprocedure);") + '\n'
    assert installed == baseline.replace(old, new), 'The migration changed another detector section'
    query(migration, 'SETTLEMENT_ATTRIBUTION_SOURCE_CHANGED')
    query('''CREATE TABLE rake_records(id uuid PRIMARY KEY,club_id uuid,rake_amount numeric,created_at timestamptz);
CREATE TABLE rake_attributions(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,rake_record_id uuid,rake_amount numeric);
CREATE INDEX fixture_records_date ON rake_records(created_at);
CREATE INDEX fixture_attribution_record ON rake_attributions(rake_record_id);''')
    def rows(q):
        return json.loads(query('SELECT coalesce(json_agg(row_to_json(t) ORDER BY record_id),\'[]\'::json) FROM (' + q + ') t;'))
    assert rows(old) == rows(new) == []
    query('''INSERT INTO rake_records SELECT md5(i::text)::uuid,md5('club')::uuid,
CASE i WHEN 4 THEN NULL WHEN 9 THEN -10 ELSE 10 END,
now()-CASE i WHEN 7 THEN interval '25 hours' WHEN 8 THEN interval '24 hours' ELSE interval '1 hour' END
FROM generate_series(1,10) i;
INSERT INTO rake_attributions(rake_record_id,rake_amount) SELECT md5(i::text)::uuid,a FROM
(VALUES(1,6::numeric),(1,5),(2,10.014),(3,10.015),(4,2),(5,NULL),(7,100),(8,100),(9,-9),(10,10)) v(i,a);''')
    # Both queries use one snapshot; cutoff is measured independently below.
    expected = {hashlib.md5(str(i).encode()).hexdigest() for i in [1,3,9]}
    assert {r['record_id'].replace('-', '') for r in rows(new)} == expected
    assert rows(old) == rows(new)
    assert query("BEGIN; UPDATE rake_records SET created_at=now()-interval '24 hours' WHERE id=md5('8')::uuid; SELECT count(*) FROM (" + new + ") q WHERE record_id=md5('8')::uuid; ROLLBACK;") == '0'
    # More findings than the sample limit: compare the whole predicate first,
    # then verify the sample is unique and is a subset of the true findings.
    query("INSERT INTO rake_records SELECT md5(i::text)::uuid,md5('otherclub')::uuid,1,now()-interval '1 hour' FROM generate_series(20,70)i; INSERT INTO rake_attributions(rake_record_id,rake_amount) SELECT md5(i::text)::uuid,2 FROM generate_series(20,70)i;")
    old_all = old.removesuffix('\n    LIMIT 20')
    new_all = new.removesuffix(' LIMIT 20')
    assert rows(old_all) == rows(new_all)
    sampled = rows(new)
    assert len(sampled) == len({r['record_id'] for r in sampled}) == 20
    assert all(r in rows(old_all) for r in sampled)
    query("INSERT INTO rake_records SELECT md5(i::text)::uuid,md5('oldclub')::uuid,1,now()-interval '2 years' FROM generate_series(100,20100)i; INSERT INTO rake_attributions(rake_record_id,rake_amount) SELECT md5(i::text)::uuid,2 FROM generate_series(100,20100)i; ANALYZE rake_records; ANALYZE rake_attributions;")
    assert rows(old_all) == rows(new_all)
    plan = json.loads(query('EXPLAIN(FORMAT JSON) ' + new))[0]['Plan']
    assert plan['Node Type'] == 'Limit'
    cte = next(p for p in plan['Plans'] if p.get('Subplan Name') == 'CTE attributed')
    assert cte['Node Type'] == 'Aggregate', cte
    print('settlement-attribution-native-acceptance-passed')
finally:
    if started and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)

# The unchanged section G counts share this maintained required native route.
# Failure in either acceptance remains a failure of the existing accounting job.
subprocess.run([sys.executable,
    str(ROOT/'scripts/ci/fixtures/settlement-attribution/qualify-first-attempt-index.py'),
    '--pg-bin', str(pg), '--scratch', args.scratch], check=True, env=env, timeout=120)

# Exact all-player coverage and its fixed-width history access remain on the
# existing required accounting route. Any failed native assertion fails CI.
for fixture in ('qualify-coverage-history-index.py', 'qualify-coverage-receipt-index.py', 'qualify-atomic-coverage.py'):
    subprocess.run([sys.executable,
        str(ROOT/'scripts/ci/fixtures/settlement-attribution'/fixture),
        '--pg-bin', str(pg), '--scratch', args.scratch], check=True, env=env, timeout=120)
