#!/usr/bin/env python3
"""Isolated PostgreSQL 17 qualification of the exact sanitized history migration."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
scratch = Path(tempfile.mkdtemp(prefix='ph-', dir=os.environ.get('RUNNER_TEMP', tempfile.gettempdir())))
socket = scratch / 's'
socket.mkdir()
data = scratch / 'data'
started = False
env = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}
def run(args, sql=None, expected=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True, env=env, timeout=60)
    if expected:
        assert p.returncode != 0 and expected in p.stderr, p.stdout+p.stderr
    elif p.returncode:
        raise RuntimeError(p.stdout+p.stderr)
    return p.stdout.strip()
def q(sql, expected=None):
    return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-U','postgres','-d','postgres'],sql,expected)
try:
    run([PG/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
    run([PG/'pg_ctl','-D',data,'-l',scratch/'server.log','-w','start'])
    started=True
    fixture=(ROOT/'scripts/qualification/player-command-history.sql').read_text()
    schema, checks=fixture.split('-- QUALIFICATION CHECKS',1)
    checks, join_checks=checks.split('-- REALTIME JOIN CHECKS',1)
    q(schema)
    q("SELECT ca_club_player_history('10000000-0000-4000-8000-000000000001');",'does not exist')
    print('PASS before: required history read is absent',flush=True)
    migration=ROOT/'supabase/migrations/20261012144105_player_command_history_reads_sanitized_staff_scope.sql'
    q(migration.read_text())
    q(join_checks,'staff join probe denied')
    print('PASS before: original policy rejects the actual default-false Realtime join probe',flush=True)
    correction=ROOT/'supabase/migrations/20261012220618_player_history_authorizes_realtime_join_check_rows.sql'
    q(correction.read_text())
    print(q(join_checks),flush=True)
    q(correction.read_text(),'refusing replay')
    print(q(checks),flush=True)
    q(migration.read_text(),'refusing replay')
    assert q("SELECT has_function_privilege('authenticated','ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)','EXECUTE') AND NOT has_function_privilege('anon','ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)','EXECUTE') AND NOT has_function_privilege('service_role','ca_club_player_history(uuid,uuid,text,date,date,jsonb,integer)','EXECUTE')")=='t'
    assert q("SELECT has_function_privilege('authenticated','ca_player_history_can_read(uuid)','EXECUTE') AND NOT has_function_privilege('anon','ca_player_history_can_read(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_publish_player_history_change()','EXECUTE') AND NOT has_function_privilege('service_role','fn_publish_player_history_change()','EXECUTE')")=='t'
    print('PASS replay refusal and exact authenticated-only ACL',flush=True)
finally:
    if started:
        run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(scratch)
