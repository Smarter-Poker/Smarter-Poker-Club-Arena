#!/usr/bin/env python3
"""Finite PG17 qualification of the read-only stranded-player audit."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
BASE = ROOT / 'scripts/ci/fixtures/stranded-player-read/installed.sql'
MIGRATION = ROOT / 'supabase/migrations/20260927150637_stranded_player_audit_examines_history_only_after_excluding_.sql'
cluster = Path(tempfile.mkdtemp(prefix='stranded-read-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='stranded-s-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG)+':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
children = []


def run(args, sql=None, error=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True,
                       capture_output=True, env=env, timeout=90)
    if error:
        assert p.returncode != 0 and error in p.stderr, p.stderr
    elif p.returncode:
        raise RuntimeError(p.stdout+p.stderr)
    return p.stdout.strip()


def argv():
    return [PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,
            '-U','fixture_admin','-d','postgres']


def q(sql, error=None):
    return run(argv(),sql,error)


def result():
    return json.loads(q("SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY tournament_name),'[]') FROM public.fn_ca_stranded_tournament_players() x"))


def fingerprint():
    return q("SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'security',prosecdef,'volatility',provolatile) FROM pg_proc WHERE oid='fn_ca_stranded_tournament_players()'::regprocedure")


def rows_digest():
    return q("SELECT md5(string_agg(x,'' ORDER BY x)) FROM (SELECT row_to_json(t)::text x FROM tournaments t UNION ALL SELECT row_to_json(t)::text FROM tournament_players t UNION ALL SELECT row_to_json(t)::text FROM tables t UNION ALL SELECT row_to_json(t)::text FROM table_seats t) s")


def uuid(n):
    h=hashlib.md5(str(n).encode()).hexdigest()
    return h[:8]+'-'+h[8:12]+'-'+h[12:16]+'-'+h[16:20]+'-'+h[20:]


try:
    assert ' 17.' in run([PG/'postgres','--version'])
    run([PG/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nautovacuum=off\n")
    run([PG/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start']); started=True
    assert json.loads(q("SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'))")) == {'host':None,'dir':str(data)}
    q("""CREATE ROLE postgres NOSUPERUSER BYPASSRLS;
CREATE ROLE anon NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOSUPERUSER BYPASSRLS;
CREATE ROLE authenticator NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT anon,authenticated,service_role TO authenticator;
GRANT ALL ON SCHEMA public TO postgres;
SET ROLE postgres;
CREATE FUNCTION u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(n::text)::uuid $$;
CREATE TABLE tournaments(id uuid PRIMARY KEY,name text,status text);
CREATE TABLE tournament_players(tournament_id uuid REFERENCES tournaments,user_id uuid,status text,PRIMARY KEY(tournament_id,user_id));
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid REFERENCES tournaments);
CREATE TABLE table_seats(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,table_id uuid REFERENCES tables,user_id uuid,stack numeric,left_at timestamptz);
CREATE INDEX idx_tables_tournament_id ON tables(tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX idx_table_seats_table ON table_seats(table_id);
CREATE INDEX idx_table_seats_live_user ON table_seats(user_id,table_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX active_seat ON table_seats(table_id,user_id) WHERE left_at IS NULL;
CREATE INDEX idx_tp_tournament ON tournament_players(tournament_id);
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_seats ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
INSERT INTO tournaments SELECT u(n),'event-'||n,CASE WHEN n=2 THEN 'COMPLETED' ELSE 'RUNNING' END FROM generate_series(1,6)n;
INSERT INTO tables SELECT u(100+n),u(n) FROM generate_series(1,6)n;
INSERT INTO tables VALUES(u(999),NULL);
INSERT INTO tournament_players VALUES(u(1),u(11),'registered'),(u(1),u(12),'playing'),(u(1),u(13),'playing'),(u(1),u(14),'eliminated'),(u(1),u(15),NULL),(u(1),u(16),'playing'),(u(1),u(17),'playing'),(u(1),u(18),'playing'),(u(1),u(19),'playing'),(u(2),u(21),'playing'),(u(3),u(31),'playing'),(u(4),u(41),'playing'),(u(5),u(51),'custom'),(u(6),u(61),'playing');
INSERT INTO table_seats(table_id,user_id,stack,left_at) VALUES
 (u(101),u(11),99,'2026-09-01Z'),(u(101),u(11),10.004,'2026-09-02Z'),
 (u(101),u(12),3.566,'2026-09-02Z'),(u(102),u(12),500,NULL),
 (u(101),u(13),50,NULL),(u(101),u(14),90,'2026-09-02Z'),
 (u(101),u(15),80,'2026-09-02Z'),(u(101),u(16),NULL,'2026-09-02Z'),
 (u(101),u(17),-1,'2026-09-02Z'),(u(101),u(18),0,'2026-09-02Z'),
 (u(102),u(21),70,'2026-09-02Z'),(u(103),u(31),-10,'2026-09-02Z'),
 (u(105),u(51),2.005,'2026-09-02Z'),(u(106),u(61),5,'2026-09-02Z'),
 (u(999),u(61),100,NULL);
RESET ROLE;""")
    original=BASE.read_text(); migration=MIGRATION.read_text()
    assert hashlib.md5(original.encode()).hexdigest()=='5dc2f495fb115311c61fbf057456c225'
    q('SET ROLE postgres;'+original+"; REVOKE ALL ON FUNCTION fn_ca_stranded_tournament_players() FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_ca_stranded_tournament_players() TO service_role;")
    metadata=fingerprint(); before_rows=rows_digest(); baseline=result()
    expected=[('event-1',1,2,13.57),('event-5',5,1,2.01),('event-6',6,1,5)]
    assert [(x['tournament_name'],x['tournament_id'],x['stranded_players'],x['stranded_chips']) for x in baseline]==[(name,uuid(n),count,amount) for name,n,count,amount in expected], baseline
    for r in baseline:
        assert r['detail'].startswith(str(r['stranded_players'])+' player(s) are still in this event holding ')
    q('SET ROLE postgres;'+migration.replace('COMMIT;','ROLLBACK;'))
    assert q("SELECT pg_get_functiondef('fn_ca_stranded_tournament_players()'::regprocedure)")==original.strip()
    q('SET ROLE postgres;'+migration)
    assert fingerprint()==metadata and rows_digest()==before_rows and result()==baseline
    q('SET ROLE postgres;'+migration,'STRANDED_PLAYER_READ_SOURCE_CHANGED')
    for role in ['anon','authenticated']:
        q('SET SESSION AUTHORIZATION authenticator; SET ROLE '+role+'; SELECT * FROM fn_ca_stranded_tournament_players();','permission denied')
    assert q('SET SESSION AUTHORIZATION authenticator; SET ROLE authenticated; SELECT count(*) FROM table_seats;')=='0'
    assert q('SET SESSION AUTHORIZATION authenticator; SET ROLE service_role; SELECT count(*) FROM fn_ca_stranded_tournament_players();')=='3'
    fixed=q("SELECT pg_get_functiondef('fn_ca_stranded_tournament_players()'::regprocedure)")+'\n'
    q('SET ROLE postgres;'+original+'; RESET ROLE; ALTER FUNCTION fn_ca_stranded_tournament_players() OWNER TO fixture_admin;')
    q(migration,'STRANDED_PLAYER_READ_AUTHORITY_CHANGED')
    q('ALTER FUNCTION fn_ca_stranded_tournament_players() OWNER TO postgres; SET ROLE postgres;'+fixed)
    assert fingerprint()==metadata and result()==baseline
    q('BEGIN; TRUNCATE tournaments CASCADE; SELECT 1; ROLLBACK;')
    assert q('BEGIN; TRUNCATE tournaments CASCADE; SELECT count(*) FROM fn_ca_stranded_tournament_players(); ROLLBACK;')=='0'
    assert result()==baseline
    # The changed reader remains in its original statement snapshot while a
    # real concurrent writer removes an old positive stack from another session.
    p=subprocess.Popen([str(x) for x in argv()],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(p)
    p.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM fn_ca_stranded_tournament_players();\n");p.stdin.flush()
    assert p.stdout.readline().strip()=='3'
    q('UPDATE table_seats SET stack=0 WHERE user_id=u(51)')
    p.stdin.write('SELECT count(*) FROM fn_ca_stranded_tournament_players(); ROLLBACK;\n');p.stdin.close()
    assert p.wait(timeout=10)==0 and p.stdout.read().strip()=='3',p.stderr.read()
    assert len(result())==2
    q('UPDATE table_seats SET stack=2.005 WHERE user_id=u(51)')
    assert result()==baseline
    q("""INSERT INTO tournaments SELECT u(n),'large-'||n,'RUNNING' FROM generate_series(1000,1019)n;
INSERT INTO tables SELECT u(10000+n),u(n) FROM generate_series(1000,1019)n;
INSERT INTO tournament_players SELECT u(1000+n%20),u(100000+n),'playing' FROM generate_series(1,12000)n;
INSERT INTO table_seats(table_id,user_id,stack,left_at) SELECT u(11000+n%20),u(100000+n),50,NULL FROM generate_series(1,12000)n;
ANALYZE;""")
    body=lambda s:s.split('AS $function$\n',1)[1].split('$function$',1)[0]
    old_plan=json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body(original)))[0]
    new_plan=json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body(fixed)))[0]
    assert result()==baseline
    assert new_plan['Plan']['Shared Hit Blocks'] < old_plan['Plan']['Shared Hit Blocks'],(old_plan,new_plan)
    print(json.dumps({'passed':True,'original_md5':hashlib.md5(original.encode()).hexdigest(),'candidate_md5':hashlib.md5(fixed.encode()).hexdigest(),'old_buffers':old_plan['Plan']['Shared Hit Blocks'],'new_buffers':new_plan['Plan']['Shared Hit Blocks'],'old_ms':old_plan['Execution Time'],'new_ms':new_plan['Execution Time'],'scope':'synthetic native PostgreSQL roles, original and candidate query semantics, snapshot, rollback and refusal; no production writes or billed-savings inference'}),flush=True)
finally:
    for p in children:
        if p.poll() is None:
            p.terminate();p.wait(timeout=10)
    if started: run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(socket)
