#!/usr/bin/env python3
"""Qualify exact SELECT policies against real PG17 sessions and captured helpers."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260927003247_scoped_achievement_and_commission_history_reads.sql'
CAPTURE = ROOT / 'scripts/ci/fixtures/scoped-audit-reads/baseline.json'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin)
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
cluster = Path(tempfile.mkdtemp(prefix='scoped-audit-', dir=os.environ.get('RUNNER_TEMP')))
socket = Path(tempfile.mkdtemp(prefix='sa-sock-'))
data = cluster / 'data'
started = False

def run(argv, sql=None, expected=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=45)
    if expected:
        assert result.returncode and expected in result.stderr, result.stderr + result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()

def q(sql, expected=None, role='postgres'):
    return run([pg/'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', role, '-d', 'postgres'], sql, expected)

def uid(n):
    return '00000000-0000-0000-0000-' + str(n).zfill(12)

def browser(n, sql, expected=None, role='authenticated'):
    # A distinct nonsuperuser login is essential: SET ROLE from postgres would
    # leave session_user trusted by the unchanged finance helper.
    return q("SET ROLE " + role + "; SET request.jwt.claim.role='" + role +
             "'; SET request.jwt.claim.sub='" + uid(n) + "'; " + sql,
             expected, 'authenticator').splitlines()[-1]

def preserved():
    return q("SELECT jsonb_build_object('helpers',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'definition',pg_get_functiondef(oid),'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE pronamespace='public'::regnamespace),'tables',(SELECT jsonb_agg(jsonb_build_object('name',relname,'acl',relacl,'rls',relrowsecurity,'owner',relowner) ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'))")

try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n")
    started = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
      CREATE TABLE profiles(id uuid PRIMARY KEY, role text, is_admin boolean);
      CREATE TABLE clubs(id uuid PRIMARY KEY, owner_id uuid);
      CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,PRIMARY KEY(club_id,user_id));
      CREATE TABLE training_user_achievements(id uuid PRIMARY KEY,user_id uuid,achievement_id text,progress numeric,unlocked_at timestamptz);
      CREATE TABLE commission_rate_audit(id uuid PRIMARY KEY,club_id uuid,new_rate numeric);
      CREATE TABLE rake_rate_audit(id uuid PRIMARY KEY,club_id uuid,new_rate numeric);
      GRANT SELECT ON club_members TO authenticated;
      ALTER TABLE training_user_achievements ENABLE ROW LEVEL SECURITY;
      ALTER TABLE commission_rate_audit ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rake_rate_audit ENABLE ROW LEVEL SECURITY;
      GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON training_user_achievements TO anon,authenticated;
      GRANT SELECT,REFERENCES,TRIGGER ON commission_rate_audit,rake_rate_audit TO anon,authenticated;
      GRANT ALL ON training_user_achievements,commission_rate_audit,rake_rate_audit TO service_role;""")
    captured = json.loads(CAPTURE.read_text())
    for fn in captured['functions']:
        q(fn['definition'])
        sig = fn['name'] + ('(uuid)' if fn['name']=='ca_can_view_club_finances' else '()')
        q('REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC; GRANT EXECUTE ON FUNCTION ' + sig + ' TO authenticated,service_role;')
        assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))") == fn['md5']
    for p in captured['policies']:
        sql = 'CREATE POLICY '+p['policyname']+' ON '+p['tablename']+' FOR '+p['cmd']+' TO '+','.join(p['roles'])+' USING ('+p['qual']+')'
        if p['with_check']: sql += ' WITH CHECK ('+p['with_check']+')'
        q(sql)
    for n in (1,2):
        q("INSERT INTO training_user_achievements VALUES('"+uid(n)+"','"+uid(n)+"','hands_100',50,NULL);")
    for n in (100,200):
        q("INSERT INTO clubs VALUES('"+uid(n)+"','"+uid(n+10)+"'); INSERT INTO commission_rate_audit VALUES('"+uid(n)+"','"+uid(n)+"',0.1); INSERT INTO rake_rate_audit VALUES('"+uid(n)+"','"+uid(n)+"',0.05);")
    for n,role,status in [(1,'player','active'),(3,'owner','active'),(4,'co_owner','active'),(5,'admin','active'),(6,'super_agent','active'),(7,'agent','active'),(8,'admin','banned'),(9,'owner','suspended')]:
        q("INSERT INTO club_members VALUES('"+uid(100)+"','"+uid(n)+"','"+role+"','"+status+"')")
    for n,role in [(20,'admin'),(21,'superadmin'),(22,'god'),(23,'player')]:
        q("INSERT INTO profiles VALUES('"+uid(n)+"','"+role+"',false)")
    q("INSERT INTO profiles VALUES('"+uid(24)+"','player',true)")
    q("INSERT INTO club_members VALUES('"+uid(100)+"','"+uid(10)+"','admin',NULL),('"+uid(100)+"','"+uid(110)+"','owner','banned')")
    assert browser(1,'SELECT count(*) FROM training_user_achievements') == '0'
    assert browser(3,'SELECT count(*) FROM commission_rate_audit') == '0'
    original = preserved()
    migration = MIGRATION.read_text()
    if not args.baseline:
        q(migration.replace('COMMIT;', 'ROLLBACK;'))
        assert browser(1,'SELECT count(*) FROM training_user_achievements') == '0'
        q('CREATE POLICY unexpected_read ON training_user_achievements FOR SELECT TO authenticated USING(false)')
        q(migration, 'SCOPED_AUDIT_READ_PREIMAGE_DRIFT')
        q('DROP POLICY unexpected_read ON training_user_achievements')
        q('ALTER POLICY rake_rate_audit_service_role_all ON rake_rate_audit TO authenticated')
        q(migration, 'SCOPED_AUDIT_READ_PREIMAGE_DRIFT')
        q('ALTER POLICY rake_rate_audit_service_role_all ON rake_rate_audit TO service_role')
        q('ALTER FUNCTION ca_can_view_club_finances(uuid) SET search_path=public,pg_temp')
        q(migration, 'SCOPED_AUDIT_READ_PREIMAGE_DRIFT')
        q(next(fn['definition'] for fn in captured['functions'] if fn['name']=='ca_can_view_club_finances'))
        q(migration)
        q(migration, 'SCOPED_AUDIT_READ_PREIMAGE_DRIFT')
    assert browser(1,'SELECT string_agg(user_id::text,\',\') FROM training_user_achievements') == uid(1), 'own achievement progress must be readable'
    assert browser(2,'SELECT string_agg(user_id::text,\',\') FROM training_user_achievements') == uid(2)
    assert browser(1,"SELECT count(*) FROM training_user_achievements WHERE user_id='"+uid(2)+"'") == '0'
    # Preserve the maintained helper's NULL-status and direct-owner override.
    for n in (3,4,5,6,10,110):
        for table in ('commission_rate_audit','rake_rate_audit'):
            assert browser(n,'SELECT string_agg(club_id::text,\',\') FROM '+table) == uid(100), (n,table)
    for n in (1,2,7,8,9,23):
        for table in ('commission_rate_audit','rake_rate_audit'):
            assert browser(n,'SELECT count(*) FROM '+table) == '0', (n,table)
    # is_admin remains an authority even when the profile's role is player.
    for n in (20,21,22,24):
        for table in ('commission_rate_audit','rake_rate_audit'):
            assert browser(n,'SELECT count(*) FROM '+table) == '2', (n,table)
    for table in ('training_user_achievements','commission_rate_audit','rake_rate_audit'):
        assert browser(1,'SELECT count(*) FROM '+table,role='anon') == '0'
        assert q("SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub=''; SELECT count(*) FROM " + table, role='authenticator').splitlines()[-1] == '0'
        assert browser(0,'SELECT count(*) FROM '+table,role='service_role') == '2'
        browser(1,'DELETE FROM '+table,'permission denied')
        browser(3,'UPDATE '+table+' SET id=id','permission denied')
        browser(20,'INSERT INTO '+table+'(id) VALUES(\''+uid(999)+'\')','permission denied')
    q("UPDATE club_members SET status='suspended' WHERE user_id='"+uid(5)+"'")
    assert browser(5,'SELECT count(*) FROM commission_rate_audit') == '0'
    q("DELETE FROM club_members WHERE user_id='"+uid(6)+"'")
    assert browser(6,'SELECT count(*) FROM rake_rate_audit') == '0'
    assert preserved() == original, 'helper, ownership or privileges changed'
    print('PASS: scoped-audit-read-acceptance; real browser roles, own account, finance/club scope, revocation, no writes, drift/replay/rollback')
finally:
    if started and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
