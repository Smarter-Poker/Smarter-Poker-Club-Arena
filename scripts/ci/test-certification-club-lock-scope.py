#!/usr/bin/env python3
"""Exact catalog migration and concurrent PostgreSQL sessions; no production access."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
MIGRATION = ROOT / 'supabase/migrations/20261029193107_certification_cleanup_locks_only_its_own_club_graph.sql'
PREIMAGES = ROOT / 'scripts/ci/fixtures/certification-club-lock-scope/preimages.json'
OUT = Path(os.environ.get('CERTIFICATION_SCOPE_EVIDENCE', ROOT / 'artifacts/certification-club-lock-scope'))
OUT.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='cert-scope-'))
if AS_PG:
    shutil.chown(work, 'postgres')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = str(sock.getsockname()[1])
started = False
passed = False
cases = []
threads = []
C1 = '00000000-0000-4000-8000-000000000001'
C2 = '00000000-0000-4000-8000-000000000002'

def command(args, **kw):
    return subprocess.run(args, env=ENV, text=True, capture_output=True, **kw)

def sql(query, check=True):
    r = command([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                 '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres'],
                input=query, timeout=30)
    if check and r.returncode:
        raise RuntimeError(r.stderr)
    return r

def expect(name, ok, **data):
    cases.append({'case': name, 'passed': bool(ok), **data})
    if not ok:
        raise AssertionError(name + ': ' + json.dumps(data))

def background(query):
    result = []
    thread = threading.Thread(target=lambda: result.append(sql(query, check=False)))
    thread.start()
    threads.append(thread)
    return thread, result

def await_marker(key):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if sql(f"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530099 AND objid={key} AND granted);").stdout.strip() == 't':
            return
        time.sleep(.02)
    raise AssertionError('Missing concurrency marker ' + str(key))

try:
    for args in [AS_PG + [str(PG / 'initdb'), '-D', str(work / 'data'), '-U', 'postgres', '-A', 'trust'],
                 AS_PG + [str(PG / 'pg_ctl'), '-D', str(work / 'data'), '-l', str(work / 'postgres.log'),
                          '-w', '-o', f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off", 'start']]:
        r = command(args)
        if r.returncode:
            raise RuntimeError(r.stderr)
    started = True
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA smarter_private; CREATE SCHEMA auth;"
        "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';"
        "CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'service_role'::text$$;"
        "CREATE TABLE clubs(id uuid PRIMARY KEY, lifecycle_status text DEFAULT 'active');"
        "CREATE TABLE cash_games(id integer,club_id uuid); CREATE TABLE tournament_schedules(id integer,club_id uuid);"
        f"INSERT INTO clubs(id) VALUES('{C1}'),('{C2}');")
    definitions = json.loads(PREIMAGES.read_text())
    for signature, definition in definitions.items():
        sql(definition + '; REVOKE ALL ON FUNCTION ' + signature + ' FROM PUBLIC,anon,authenticated,service_role;')
    for table in ['cash_games', 'tournament_schedules']:
        sql(f'CREATE TRIGGER retired_guard BEFORE INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();')
    sql("CREATE FUNCTION smarter_private.certification_retention_admission() RETURNS void LANGUAGE sql SET lock_timeout='32s' AS $$SELECT pg_advisory_xact_lock(530090,2)$$;")
    old = definitions['public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)']
    gate = re.search(r'  DECLARE\n    v_gate_tries.*?  END;\n', old, re.S).group()
    sql('CREATE FUNCTION old_gate() RETURNS void LANGUAGE plpgsql AS $old$ BEGIN\n' + gate + 'END $old$;')
    holder, result = background('BEGIN; SELECT old_gate(); SELECT pg_advisory_xact_lock(530099,1); SELECT pg_sleep(2); COMMIT;')
    await_marker(1)
    before = sql("SET lock_timeout='1s'; SELECT pg_advisory_xact_lock_shared(530090,1);", check=False)
    expect('BEFORE exact cleanup gate times out a live continuation', before.returncode != 0 and 'lock timeout' in before.stderr)
    holder.join()
    expect('BEFORE cleanup holder succeeded', result[0].returncode == 0)
    # The existing guard also admitted a game whose club disappeared while it waited.
    sql(f"DELETE FROM clubs WHERE id='{C1}'; INSERT INTO cash_games VALUES(1,'{C1}');")
    expect('BEFORE missing club accepts an orphan', sql('SELECT count(*) FROM cash_games;').stdout.strip() == '1')
    sql(f"DELETE FROM cash_games; INSERT INTO clubs(id) VALUES('{C1}');")
    sql(MIGRATION.read_text())
    expect('exact pinned migration and ACL preservation pass', True)
    proof = re.search(r'^-- @live-proof: (.+)$', MIGRATION.read_text(), re.M).group(1)
    expect('installation live proof matches exact catalog postimages',
           sql('SELECT ' + proof + ';').stdout.strip() == 't')
    for signature in definitions:
        if 'prepare_' not in signature:
            continue
        body = sql(f"SELECT prosrc FROM pg_proc WHERE oid='{signature}'::regprocedure;").stdout
        expect('admission precedes first identity read: ' + signature,
               body.index('certification_club_admission(p_club_id)') < body.index('SELECT * INTO v_club')
               and 'pg_try_advisory_xact_lock(530090,1)' not in body
               and 'certification_retention_admission()' not in body)
    holder, result = background(f"BEGIN; SELECT smarter_private.certification_club_admission('{C1}'); SELECT pg_advisory_xact_lock(530099,2); SELECT pg_sleep(2); COMMIT;")
    await_marker(2)
    begin = time.monotonic()
    sql("SET lock_timeout='1s'; SELECT pg_advisory_xact_lock_shared(530090,1);")
    sql(f"SET lock_timeout='1s'; INSERT INTO cash_games VALUES(2,'{C2}');")
    same = sql(f"SET lock_timeout='100ms'; INSERT INTO cash_games VALUES(3,'{C1}');", check=False)
    expect('AFTER live continuation and other club proceed; same club remains fenced',
           same.returncode != 0 and 'lock timeout' in same.stderr and time.monotonic() - begin < 1)
    holder.join()
    expect('scoped cleanup completes', result[0].returncode == 0)
    holder, result = background(f"BEGIN; SELECT 1 FROM clubs WHERE id='{C1}' FOR KEY SHARE; SELECT pg_advisory_xact_lock(530099,3); SELECT pg_sleep(1); COMMIT;")
    await_marker(3)
    busy = sql(f"SELECT smarter_private.certification_club_admission('{C1}');", check=False)
    expect('active writer makes cleanup refuse without waiting', busy.returncode != 0 and 'could not obtain lock' in busy.stderr)
    holder.join()
    holder, result = background('BEGIN; SELECT pg_advisory_xact_lock(530090,1); SELECT pg_advisory_xact_lock(530099,4); SELECT pg_sleep(1); COMMIT;')
    await_marker(4)
    busy = sql(f"SELECT smarter_private.certification_club_admission('{C1}');", check=False)
    expect('maintenance still excludes cleanup', busy.returncode != 0 and 'CERTIFICATION_FIXTURE_MAINTENANCE_BUSY' in busy.stderr)
    holder.join()
    for index, table in enumerate(['cash_games', 'tournament_schedules'], 5):
        holder, result = background(f"BEGIN; SELECT smarter_private.certification_club_admission('{C1}'); SELECT pg_advisory_xact_lock(530099,{index}); SELECT pg_sleep(1); DELETE FROM clubs WHERE id='{C1}'; COMMIT;")
        await_marker(index)
        writer = sql(f"INSERT INTO {table} VALUES(9,'{C1}');", check=False)
        holder.join()
        expect('waiting writer refuses deleted parent: ' + table,
               writer.returncode != 0 and 'CLUB_NOT_FOUND' in writer.stderr and result[0].returncode == 0)
        sql(f"INSERT INTO clubs(id) VALUES('{C1}');")
    sql(f"BEGIN; SELECT smarter_private.certification_club_admission('{C1}'); ROLLBACK; INSERT INTO cash_games VALUES(10,'{C1}');")
    expect('rollback releases scoped admission', True)
    expect('untrusted caller cannot acquire cleanup admission', sql(f"SET ROLE authenticated; SELECT smarter_private.certification_club_admission('{C1}');", check=False).returncode != 0)
    # Exercise the actual post-deploy catalog query against this exact installed
    # migration, never a live database or a handwritten substitute function.
    sql("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text,name text);")
    def readiness(expected):
        program = r"""
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// Accounting CI installs the server lockfile, not root dependencies.
const pg = createRequire(resolve(process.cwd(), 'server/package.json'))('pg');
import { classifyProof, readProof } from './scripts/ci/await-certification-cleanup-safety.mjs';
const client = new pg.Client({host:'127.0.0.1',port:Number(process.argv[2]),user:'postgres',database:'postgres',options:'-c default_transaction_read_only=on',statement_timeout:500,query_timeout:1000});
try {
 await client.connect();
 try { await client.query('CREATE TABLE forbidden_fixture_write(id int)'); throw Error('readonly failed'); }
 catch (error) { if (error.code !== '25006') throw error; }
 try { console.log(classifyProof(await readProof(client))); }
 catch (error) { console.log(error.message); }
} finally { await client.end(); }
"""
        result = command(['node', '--input-type=module', '-', port], input=program, cwd=ROOT, timeout=15)
        expect('native readiness: ' + expected, result.returncode == 0 and expected in result.stdout,
               stdout=result.stdout, stderr=result.stderr)
    readiness('pending')
    sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261029193107','certification_cleanup_locks_only_its_own_club_graph');")
    readiness('ready')
    sql("UPDATE supabase_migrations.schema_migrations SET name='wrong';")
    readiness('history identity differs')
    sql("UPDATE supabase_migrations.schema_migrations SET name='certification_cleanup_locks_only_its_own_club_graph',version='20261029193108';")
    readiness('history identity differs')
    sql("UPDATE supabase_migrations.schema_migrations SET version='20261029193107';")
    for signature in definitions:
        saved = sql(f"SELECT pg_get_functiondef('{signature}'::regprocedure);").stdout
        sql(f"ALTER FUNCTION {signature} SET statement_timeout='3s';")
        readiness('function identity differs: ' + signature)
        sql(saved)
    for role in ['PUBLIC', 'anon', 'authenticated', 'service_role']:
        sql('GRANT EXECUTE ON FUNCTION smarter_private.certification_club_admission(uuid) TO ' + role + ';')
        readiness('non-owner access')
        sql('REVOKE ALL ON FUNCTION smarter_private.certification_club_admission(uuid) FROM ' + role + ';')
    readiness('ready')
    helper_sig = 'smarter_private.certification_club_admission(uuid)'
    helper_definition = sql(f"SELECT pg_get_functiondef('{helper_sig}'::regprocedure);").stdout
    helper_hash = sql(f"SELECT md5(pg_get_functiondef('{helper_sig}'::regprocedure));").stdout.strip()
    (OUT / 'helper-function-hash.json').write_text(json.dumps({'signature':helper_sig,'md5':helper_hash}) + '\n')
    sql(f"ALTER FUNCTION {helper_sig} SET statement_timeout='3s';")
    readiness('helper identity differs')
    sql(helper_definition)
    readiness('ready')
    passed = True
finally:
    for thread in threads:
        thread.join(timeout=30)
    if started:
        command(AS_PG + [str(PG / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate', 'stop'])
    shutil.rmtree(work)
    result = {'passed': passed, 'production_mutations': False, 'cluster_removed': not work.exists(), 'cases': cases}
    (OUT / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
