#!/usr/bin/env python3
"""Caller-bound union administrator read on isolated PG17, never production."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import select
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260927170842_union_administrator_directory_binds_the_signed_in_operator.sql'
NAME = ROOT / 'scripts/ci/fixtures/union-admin-directory/arena-name.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
args = parser.parse_args()
pg = Path(args.pg_bin)
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
cluster = Path(tempfile.mkdtemp(prefix='union-dir-', dir=os.environ.get('RUNNER_TEMP')))
socket = Path(tempfile.mkdtemp(prefix='ud-sock-'))
data = cluster / 'data'
started = False


def run(argv, sql=None, expected=None):
    r = subprocess.run([str(a) for a in argv], input=sql, text=True,
                       capture_output=True, env=env, timeout=45)
    if expected:
        assert r.returncode and expected in r.stderr, r.stdout + r.stderr
    elif r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def q(sql, expected=None, role='fixture_admin'):
    return run([pg/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', role, '-d', 'postgres'], sql, expected)


def uid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def browser(n, sql, expected=None, role='authenticated'):
    return q(f"SET ROLE {role}; SET request.jwt.claim.sub='{uid(n) if n else ''}'; " + sql,
             expected, 'authenticator')


def read(union=100):
    return "SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.user_id),'[]'::jsonb) FROM public.fn_union_admin_directory('"+uid(union)+"')d"


def original():
    return q("""SELECT jsonb_build_object(
      'tables',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner,'acl',relacl,'rls',relrowsecurity) ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'),
      'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
      'name',pg_get_functiondef('public.fn_arena_name(text,text,text,text,text,text)'::regprocedure),
      'rows',(SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id) FROM union_admins a))""")


try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb', '-D', data, '-U', 'fixture_admin', '--auth-local=trust',
         '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
    started = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    q("""CREATE ROLE postgres NOSUPERUSER BYPASSRLS LOGIN;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator;
      GRANT USAGE,CREATE ON SCHEMA public TO postgres;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO postgres,anon,authenticated,service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      CREATE TABLE unions(id uuid PRIMARY KEY,owner_id uuid);
      CREATE TABLE profiles(id uuid PRIMARY KEY,username text,alias text,display_name text,
        first_name text,last_name text,full_name text,arena_avatar_url text);
      CREATE TABLE union_admins(union_id uuid,user_id uuid,role text,created_at timestamptz,
        permissions jsonb, PRIMARY KEY(union_id,user_id));
      ALTER TABLE unions OWNER TO postgres; ALTER TABLE profiles OWNER TO postgres;
      ALTER TABLE union_admins OWNER TO postgres;
      ALTER TABLE unions ENABLE ROW LEVEL SECURITY; ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE union_admins ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON union_admins TO authenticated;
      CREATE POLICY union_admins_read ON union_admins FOR SELECT TO authenticated USING(user_id=auth.uid());""")
    q(NAME.read_text())
    assert q("SELECT md5(pg_get_functiondef('public.fn_arena_name(text,text,text,text,text,text)'::regprocedure))") == '2b7a84c23987cb7c923dde302f9ea998'
    q(f"INSERT INTO unions VALUES('{uid(100)}','{uid(1)}'),('{uid(200)}','{uid(9)}');")
    for n, role in [(2,'union_lead'),(3,'union_admin'),(4,'invalid_legacy_role')]:
        q(f"INSERT INTO union_admins VALUES('{uid(100)}','{uid(n)}','{role}','2026-09-01','{{\"secret_permission\":true}}');")
    q(f"INSERT INTO union_admins VALUES('{uid(200)}','{uid(8)}','union_admin','2026-09-01','{{}}');")
    q(f"INSERT INTO profiles VALUES('{uid(2)}','lead-handle',NULL,'Legal Name',NULL,NULL,'Legal Name','arena-lead.png'),('{uid(3)}',NULL,NULL,'Legal Name',NULL,NULL,'Legal Name','arena-admin.png');")
    # Actual defect: union owner sees zero other administrators via raw RLS.
    assert browser(1,'SELECT count(*) FROM union_admins') == '0'
    assert browser(3,'SELECT count(*) FROM union_admins') == '1'
    baseline = original()
    migration = MIGRATION.read_text()
    q(migration.replace('COMMIT;', 'ROLLBACK;'))
    assert q("SELECT to_regprocedure('public.fn_union_admin_directory(uuid)') IS NULL") == 't'
    assert original() == baseline
    q("ALTER FUNCTION fn_arena_name(text,text,text,text,text,text) SET search_path=public")
    q(migration, 'UNION_ADMIN_DIRECTORY_NAME_DEPENDENCY_CHANGED')
    q(NAME.read_text())
    q(migration)
    q(migration, 'UNION_ADMIN_DIRECTORY_ALREADY_EXISTS')
    owner = json.loads(browser(1,read()))
    assert [x['user_id'] for x in owner] == [uid(2),uid(3)]
    assert [x['display_name'] for x in owner] == ['lead-handle','Player']
    assert set(owner[0]) == {'union_id','user_id','role','created_at','username','display_name','avatar_url'}
    assert 'Legal Name' not in json.dumps(owner) and 'secret_permission' not in json.dumps(owner)
    for n in (2,3):
        assert json.loads(browser(n,read())) == owner
    for n in (0,4,5,8,9):
        browser(n,read(),'not_authorised')
    browser(1,read(200),'not_authorised')
    browser(1,"SELECT * FROM fn_union_admin_directory(NULL)",'not_authorised')
    browser(1,read(),'permission denied',role='anon')
    browser(0,read(),'not_authorised',role='service_role')
    assert json.loads(browser(1,read(),role='service_role')) == owner
    browser(1,'DELETE FROM union_admins','permission denied')
    browser(3,"UPDATE union_admins SET role='union_lead'",'permission denied')
    # Revocation committed by a distinct session is effective on the next read.
    q(f"DELETE FROM union_admins WHERE user_id='{uid(3)}'")
    browser(3,read(),'not_authorised')
    assert len(json.loads(browser(1,read()))) == 1
    q(f"INSERT INTO union_admins VALUES('{uid(100)}','{uid(3)}','union_admin','2026-09-01','{{\"secret_permission\":true}}')")
    # An uncommitted change does not invent an early grant, nor lock a reader.
    writer = subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    try:
        writer.stdin.write(f"BEGIN; DELETE FROM union_admins WHERE user_id='{uid(3)}'; SELECT 'writer_ready';\n"); writer.stdin.flush()
        assert select.select([writer.stdout], [], [], 10)[0], 'writer readiness exceeded bound'
        assert writer.stdout.readline().strip() == 'writer_ready'
        assert json.loads(browser(3,read())) == owner
        writer.stdin.write('COMMIT;\n'); writer.stdin.close()
        assert writer.wait(timeout=10) == 0, writer.stderr.read()
        browser(3,read(),'not_authorised')
    finally:
        if writer.poll() is None:
            writer.terminate(); writer.wait(timeout=10)
        writer.stdout.close(); writer.stderr.close()
    q(f"INSERT INTO union_admins VALUES('{uid(100)}','{uid(3)}','union_admin','2026-09-01','{{\"secret_permission\":true}}')")
    assert original() == baseline, 'raw RLS, tables, grants, profiles or rows changed'
    assert q("SELECT proowner::regrole::text||'|'||prosecdef||'|'||provolatile::text||'|'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.fn_union_admin_directory(uuid)'::regprocedure") == 'postgres|true|s|search_path=public, pg_temp'
    assert q("SELECT has_function_privilege('anon','fn_union_admin_directory(uuid)','EXECUTE')||'|'||has_function_privilege('authenticated','fn_union_admin_directory(uuid)','EXECUTE')") == 'false|true'
    print(json.dumps({'status':'PASS','migrationSHA256':hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),'cases':'raw RLS defect, owner/admin, other union, missing/invalid role, anonymous, null identity, safe name, service auth, no writes, committed/uncommitted revocation, rollback, dependency drift, replay, preserved table authority'}))
finally:
    if started and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
