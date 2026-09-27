#!/usr/bin/env python3
"""Real unchanged cleanup/FK/club lock with a leading player index, private PG17."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/certification-player-index'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20260927053710_certification_cleanup_finds_cash_rake_sources_by_player.sql'
ONLINE = ROOT / 'scripts/ops/build-certification-player-index-concurrently.sql'
cluster = Path(tempfile.mkdtemp(prefix='cert-player-', dir=os.environ.get('TMPDIR')))
socket = Path(tempfile.mkdtemp(prefix='cert-player-s-', dir='/tmp'))
data = cluster / 'data'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
children = []
USER = '00000000-0000-4000-8000-000000000099'
PARENT = '00000000-0000-4000-8000-000000000098'
JOINER = '00000000-0000-4000-8000-000000000097'
CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
EMAIL = 'ca-customization-cert-postdeploy-native@example.invalid'


def run(args, sql=None, error=None):
    result = subprocess.run([str(a) for a in args], input=sql, text=True,
                            capture_output=True, env=env, timeout=120)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
        print('PASS: refused ' + error, flush=True)
    elif result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def argv():
    return [PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres']


def q(sql, error=None):
    return run(argv(), sql, error)


def wait_for(sql):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if q(sql) == 't':
            return
        time.sleep(.025)
    raise AssertionError('Native condition not observed: ' + sql)


def start(sql):
    proc = subprocess.Popen([str(a) for a in argv()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    children.append(proc)
    proc.stdin.write(sql + '\n')
    proc.stdin.flush()
    return proc


def finish(proc, sql='COMMIT;'):
    out, err = proc.communicate(sql + '\n', timeout=15)
    assert proc.returncode == 0, err
    return out


def seed():
    q(f"INSERT INTO auth.users(id,email) VALUES('{USER}','{EMAIL}');"
      f"INSERT INTO profiles(id,email) VALUES('{USER}','{EMAIL}');"
      f"INSERT INTO public.users(id) VALUES('{USER}');"
      f"INSERT INTO club_members(club_id,user_id,role) VALUES('{CLUB}','{USER}','admin');"
      f"INSERT INTO diamond_wallets(user_id) VALUES('{USER}');")


def cleanup():
    return json.loads(q("SET ROLE service_role; " + f"SELECT cleanup_reserved_certification_account('{USER}');"))


def identity():
    return q(f"SELECT jsonb_build_object('auth',(SELECT to_jsonb(a) FROM auth.users a WHERE id='{USER}'),"
             f"'profile',(SELECT to_jsonb(p) FROM profiles p WHERE id='{USER}'),"
             f"'member',(SELECT to_jsonb(m) FROM club_members m WHERE user_id='{USER}'),"
             f"'diamond',(SELECT to_jsonb(d) FROM diamond_wallets d WHERE user_id='{USER}'))")


def fingerprint():
    return q("""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM
      (SELECT oid,pg_get_functiondef(oid) definition,proacl,proowner,proconfig,prosecdef FROM pg_proc WHERE oid IN
      ('cleanup_reserved_certification_account(uuid)'::regprocedure,'lock_club_cashier_hierarchy_mutation()'::regprocedure))p),
      'table',(SELECT to_jsonb(t) FROM (SELECT oid,relacl,relowner,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='accounting_cash_rake_sources'::regclass)t),
      'fk',(SELECT to_jsonb(c) FROM pg_constraint c WHERE conname='accounting_cash_rake_sources_player_id_fkey'),
      'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgrelid='club_members'::regclass))""")


def nodes(n):
    yield n
    for child in n.get('Plans', []):
        yield from nodes(child)


try:
    assert ' 17.' in run([PG/'postgres', '--version'])
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    assert json.loads(q("SELECT json_build_object('host',inet_server_addr(),'dir',current_setting('data_directory'),'listen',current_setting('listen_addresses'))")) == {'host': None, 'dir': str(data), 'listen': ''}
    q((ROOT/'scripts/ci/fixtures/certification-retirement/setup.sql').read_text())
    q((ROOT/'supabase/migrations/20260927032118_reserved_certification_ledger_actors_are_retired_not_deleted.sql').read_text())
    q("""ALTER TABLE chip_ledger ADD COLUMN club_id uuid, ADD COLUMN hand_id uuid,
      ADD COLUMN table_id uuid, ADD COLUMN tournament_id uuid, ADD COLUMN status text,
      ADD COLUMN category text, ADD COLUMN from_type text, ADD COLUMN from_entity_id uuid,
      ADD COLUMN to_type text, ADD COLUMN to_entity_id uuid, ADD COLUMN idempotency_key text;
      ALTER TABLE club_members ADD COLUMN agent_id uuid, ADD COLUMN status text;
      CREATE TABLE accounting_tournament_fee_recognitions(bank_journal_id uuid);
      CREATE TABLE ca_test_account_ledger_actor_archive(ledger_id uuid PRIMARY KEY,actor_id uuid,actor_email text,ledger_row jsonb);
      CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rake_record_id uuid NOT NULL,
        player_id uuid NOT NULL REFERENCES auth.users(id),club_id uuid NOT NULL,union_id uuid,coordinator_union_id uuid,
        earned_at timestamptz NOT NULL DEFAULT now(),rake_credit numeric NOT NULL,contract jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(rake_record_id,player_id));
      ALTER TABLE accounting_cash_rake_sources ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON accounting_cash_rake_sources TO service_role;
      ALTER ROLE service_role BYPASSRLS;
    """)
    q((FIXTURE/'installed.sql').read_text())
    assert q("SELECT md5(pg_get_functiondef('cleanup_reserved_certification_account(uuid)'::regprocedure))") == 'f29271b8f640a2d2a1f04e6f020e150c'
    assert q("SELECT md5(pg_get_functiondef('lock_club_cashier_hierarchy_mutation()'::regprocedure))") == '2bf2e0dc1876c5b1238603fc18558907'
    q(f"INSERT INTO auth.users(id,email) VALUES('{PARENT}','ordinary@example.invalid'),('{JOINER}','joiner@example.invalid');"
      f"INSERT INTO profiles(id,email) VALUES('{JOINER}','joiner@example.invalid');"
      f"INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,rake_credit,contract) SELECT md5(i::text)::uuid,'{PARENT}','{CLUB}',i%13,jsonb_build_object('fixture',i) FROM generate_series(1,150000)i; ANALYZE accounting_cash_rake_sources;")
    original = fingerprint()
    immutable = q('SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM accounting_cash_rake_sources s')
    seed()
    lookup = f"SELECT 1,x.ctid FROM ONLY accounting_cash_rake_sources x WHERE '{USER}'::uuid=x.player_id"
    before = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + lookup))[0]
    assert cleanup()['success'] is True
    seed()
    # Actual FK rejection rolls the whole earlier membership/diamond deletion back.
    q(f"INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,rake_credit,contract) VALUES(gen_random_uuid(),'{USER}','{CLUB}',1,'{{}}')")
    preserved = identity()
    q(f"SELECT cleanup_reserved_certification_account('{USER}')", 'accounting_cash_rake_sources_player_id_fkey')
    assert identity() == preserved
    q(f"DELETE FROM accounting_cash_rake_sources WHERE player_id='{USER}'")
    q(MIGRATION.read_text(), 'CERTIFICATION_PLAYER_INDEX_MISSING_BUILD_ONLINE')
    q('CREATE INDEX idx_cash_rake_sources_player ON accounting_cash_rake_sources(rake_record_id,player_id)')
    q(MIGRATION.read_text(), 'CERTIFICATION_PLAYER_INDEX_CONTRACT_CHANGED')
    q('DROP INDEX idx_cash_rake_sources_player')
    # A real concurrent build waits for an existing writer without blocking another insert.
    writer = start("SET application_name='cert_player_writer'; BEGIN; LOCK TABLE accounting_cash_rake_sources IN ROW EXCLUSIVE MODE;")
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cert_player_writer' AND state='idle in transaction')")
    build = start("SET application_name='cert_player_build'; SET statement_timeout='20s'; " + ONLINE.read_text())
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index)")
    q(f"BEGIN; SET LOCAL lock_timeout='1s'; INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,rake_credit,contract) VALUES(gen_random_uuid(),'{PARENT}','{CLUB}',1,'{{}}'); ROLLBACK;")
    finish(writer, 'ROLLBACK;')
    finish(build, '')
    for flag in ['indisvalid', 'indisready', 'indislive']:
        q(f"UPDATE pg_index SET {flag}=false WHERE indexrelid='idx_cash_rake_sources_player'::regclass")
        q(MIGRATION.read_text(), 'CERTIFICATION_PLAYER_INDEX_CONTRACT_CHANGED')
        q(f"UPDATE pg_index SET {flag}=true WHERE indexrelid='idx_cash_rake_sources_player'::regclass")
    q('ALTER TABLE accounting_cash_rake_sources ALTER CONSTRAINT accounting_cash_rake_sources_player_id_fkey DEFERRABLE')
    q(MIGRATION.read_text(), 'CERTIFICATION_PLAYER_FK_CHANGED')
    q('ALTER TABLE accounting_cash_rake_sources ALTER CONSTRAINT accounting_cash_rake_sources_player_id_fkey NOT DEFERRABLE')
    q("ALTER FUNCTION cleanup_reserved_certification_account(uuid) SET statement_timeout='9min'")
    q(MIGRATION.read_text(), 'CERTIFICATION_CLEANUP_AUTHORITY_CHANGED')
    q("ALTER FUNCTION cleanup_reserved_certification_account(uuid) SET statement_timeout='10min'")
    q(MIGRATION.read_text().replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    q(MIGRATION.read_text())
    q(MIGRATION.read_text())  # Read-only verifier is stable, never rebuilds.
    assert fingerprint() == original
    after = json.loads(q('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + lookup))[0]
    assert any(n.get('Index Name') == 'idx_cash_rake_sources_player' for n in nodes(after['Plan']))
    before_buffers = before['Plan'].get('Shared Hit Blocks', 0) + before['Plan'].get('Shared Read Blocks', 0)
    after_buffers = after['Plan'].get('Shared Hit Blocks', 0) + after['Plan'].get('Shared Read Blocks', 0)
    assert before_buffers > 100 and after_buffers < before_buffers / 10, (before, after)
    fk_plan = json.loads(q('EXPLAIN (FORMAT JSON) ' + lookup + ' FOR KEY SHARE OF x'))[0]
    assert any(n.get('Index Name') == 'idx_cash_rake_sources_player' for n in nodes(fk_plan['Plan']))
    # Query behavior, RLS/EXECUTE grants and original FK refusal remain unchanged.
    for role in ['anon', 'authenticated']:
        q(f"SET ROLE {role}; SELECT cleanup_reserved_certification_account('{USER}')", 'permission denied')
        q(f'SET ROLE {role}; SELECT * FROM accounting_cash_rake_sources', 'permission denied')
    q(f"INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,rake_credit,contract) VALUES(gen_random_uuid(),'{USER}','{CLUB}',1,'{{}}')")
    preserved = identity()
    q(f"SELECT cleanup_reserved_certification_account('{USER}')", 'accounting_cash_rake_sources_player_id_fkey')
    assert identity() == preserved
    q(f"DELETE FROM accounting_cash_rake_sources WHERE player_id='{USER}'")
    q('UPDATE freeze_fixture SET active=true')
    preserved = identity()
    assert cleanup() == {'success': False, 'reason': 'platform_is_frozen'}
    assert identity() == preserved
    q('UPDATE freeze_fixture SET active=false')
    # Real cleanup retains the club advisory lock until commit; ordinary membership
    # insertion serializes through the exact unchanged trigger, then succeeds.
    owner = start("SET application_name='cert_player_cleanup'; BEGIN; SET ROLE service_role; " + f"SELECT cleanup_reserved_certification_account('{USER}');")
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l USING(pid) WHERE a.application_name='cert_player_cleanup' AND l.locktype='advisory' AND l.granted AND a.state='idle in transaction')")
    joiner = start("SET application_name='cert_player_join'; SET lock_timeout='5s'; " + f"INSERT INTO club_members(club_id,user_id,role) VALUES('{CLUB}','{JOINER}','member');")
    wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l USING(pid) WHERE a.application_name='cert_player_join' AND l.locktype='advisory' AND NOT l.granted)")
    result = finish(owner)
    assert json.loads(result)['success'] is True
    finish(joiner, '')
    assert q(f"SELECT count(*) FROM club_members WHERE user_id='{JOINER}'") == '1'
    assert q(f"SELECT count(*) FROM auth.users WHERE id='{USER}'") == '0'
    assert cleanup() == {'success': True, 'already_removed': True}
    assert q('SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM accounting_cash_rake_sources s') == immutable
    assert fingerprint() == original
    print(json.dumps({'acceptance': 'PASS', 'rows': 150000, 'before_buffers': before_buffers, 'after_buffers': after_buffers,
                      'before_ms': before['Execution Time'], 'after_ms': after['Execution Time'],
                      'cleanup': 'unchanged actual body; real FK rollback and hierarchy serialization',
                      'live_limit': 'not full production cleanup timing or complete join RPC'}), flush=True)
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
    if started:
        run([PG/'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
