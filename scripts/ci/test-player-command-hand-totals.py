#!/usr/bin/env python3
"""Private PostgreSQL proof of exact roster totals and concurrent initialization."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
SCRATCH = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
cluster = Path(tempfile.mkdtemp(prefix='roster-totals-', dir=SCRATCH))
socket = cluster / 's'
socket.mkdir()
data = cluster / 'data'
env = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}
started = False
children = []
STAGE = ROOT / 'supabase/migrations/20261010064938_player_command_hand_totals_advance_with_their_facts.sql'
ACTIVATE = ROOT / 'supabase/migrations/20261010065031_player_command_reads_exact_retained_hand_totals.sql'
A = '10000000-0000-4000-8000-000000000001'
B = '10000000-0000-4000-8000-000000000002'
U = '20000000-0000-4000-8000-000000000001'
V = '20000000-0000-4000-8000-000000000002'


def run(args, sql=None, error=None):
    r = subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True,
                       env=env, timeout=60)
    if error:
        assert r.returncode and error in r.stderr, r.stdout + r.stderr
    elif r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def argv():
    return [PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'postgres', '-d', 'postgres']


def q(sql, error=None):
    return run(argv(), sql, error)


def start(sql):
    args = argv()
    from_file = len(sql) > 8192
    if from_file:
        path = cluster / ('session-' + str(len(children)) + '.sql')
        path.write_text(sql)
        args += ['-f', path]
    p = subprocess.Popen([str(a) for a in args], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    children.append(p)
    if from_file:
        return p
    try:
        p.stdin.write(sql + '\n')
        p.stdin.flush()
    except BrokenPipeError:
        raise RuntimeError(p.stderr.read())
    return p


def finish(p, sql=''):
    out, err = p.communicate(sql + '\n', timeout=30)
    assert p.returncode == 0, out + err
    return out


def parity(label):
    assert q('''WITH facts AS (SELECT club_id,user_id,sum(rake_paid) fees,count(*) hands
      FROM ca_hand_facts WHERE club_id IS NOT NULL GROUP BY club_id,user_id)
      SELECT count(*) FROM facts f FULL JOIN club_roster_hand_totals t USING(club_id,user_id)
      WHERE coalesce(f.fees,0) IS DISTINCT FROM t.fees
         OR coalesce(f.hands,0) IS DISTINCT FROM t.hands''') == '0', label
    print('PASS ' + label, flush=True)


try:
    run([PG/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
         '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as c:
        c.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n")
    run([PG/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    started = True
    q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
      CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,club_id uuid,rake_paid numeric NOT NULL,
        PRIMARY KEY(hand_id,user_id));
      CREATE TABLE clubs(id uuid PRIMARY KEY,name text);
      CREATE TABLE club_members(user_id uuid,club_id uuid,role text,status text,agent_id uuid,
        chip_balance numeric,promo_balance numeric,joined_at timestamptz,last_active_at timestamptz,
        nickname text,notes text,display_name text);
      CREATE TABLE profiles(id uuid PRIMARY KEY,is_admin boolean,player_number text,alias text,
        username text,display_name text,arena_avatar_url text,avatar_url text,is_online boolean,
        last_seen timestamptz,last_login timestamptz);
      CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,status text);
      CREATE TABLE table_seats(user_id uuid,table_id uuid,club_id uuid,left_at timestamptz);
      CREATE TABLE agents(user_id uuid,club_id uuid,status text,agent_wallet_balance numeric,
        promo_wallet_balance numeric);
      CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY[$1]$$;
      CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
      CREATE FUNCTION fn_club_role_rank(text) RETURNS integer LANGUAGE sql AS
        $$SELECT CASE $1 WHEN 'owner' THEN 6 WHEN 'agent' THEN 3 ELSE 0 END$$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
    ''')
    q(f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{U}','{A}',1.25),"
      f"(gen_random_uuid(),'{V}','{A}',2.50),(gen_random_uuid(),'{U}',NULL,9.0);")
    q('GRANT INSERT ON ca_hand_facts TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;')
    q(STAGE.read_text())
    q((ROOT/'supabase/migrations/20261010070915_player_command_totals_have_no_direct_service_writer.sql').read_text())
    assert q("SELECT has_table_privilege('service_role','club_roster_hand_totals','SELECT') AND NOT has_table_privilege('service_role','club_roster_hand_totals','UPDATE') AND NOT has_table_privilege('service_role','club_roster_hand_totals_state','UPDATE')") == 't'
    q(f"SET ROLE service_role; INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{U}','{A}',0); RESET ROLE;")
    q((ROOT/'scripts/ci/fixtures/player-command-hand-totals/roster-preimage.sql').read_text())
    print('Preimage hash ' + q("SELECT md5(pg_get_functiondef('ca_club_roster_rows(uuid)'::regprocedure))"), flush=True)
    # Changes before initialization include deletes, updates and a moved club.
    q(f"UPDATE ca_hand_facts SET rake_paid=3.75 WHERE user_id='{U}' AND club_id='{A}';"
      f"DELETE FROM ca_hand_facts WHERE user_id='{V}';"
      f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{V}','{B}',5);")
    # Hold a gate so initialization's statement snapshot precedes a committed writer.
    holder = start('BEGIN; SELECT pg_advisory_xact_lock(74101);')
    deadline = time.monotonic()+10
    while q('SELECT count(*) FROM pg_locks WHERE locktype=\'advisory\' AND granted') != '1':
        assert time.monotonic() < deadline
        time.sleep(.02)
    activation = ACTIVATE.read_text()
    gated = activation.replace('WITH facts AS MATERIALIZED (',
       'WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(74101)), facts AS MATERIALIZED (')
    gated = gated.replace('FROM public.ca_hand_facts WHERE club_id IS NOT NULL',
       'FROM public.ca_hand_facts CROSS JOIN gate WHERE club_id IS NOT NULL')
    seed = start(gated)
    deadline = time.monotonic()+10
    while q("SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'") != '1':
        assert time.monotonic() < deadline
        time.sleep(.02)
    q(f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{U}','{A}',7.25);")
    q(f"UPDATE ca_hand_facts SET rake_paid=rake_paid+.50 WHERE club_id='{A}' AND rake_paid<7;"
      f"DELETE FROM ca_hand_facts WHERE club_id='{B}';")
    finish(holder, 'COMMIT;')
    finish(seed)
    parity('initialization preserves historical facts and concurrent insert')
    q(f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{U}','{A}',1.01),"
      f"(gen_random_uuid(),'{V}','{B}',2.02);")
    parity('multi-row insert')
    q(f"UPDATE ca_hand_facts SET club_id='{B}',rake_paid=rake_paid+.03 WHERE club_id='{A}';")
    parity('club move and fee update')
    q(f"UPDATE ca_hand_facts SET user_id='{U}' WHERE user_id='{V}';")
    parity('player reassignment')
    q('UPDATE ca_hand_facts SET rake_paid=rake_paid;')
    parity('idempotent unchanged update')
    q(f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{V}','{A}',0);")
    parity('zero-rake hand still counts')
    q('DELETE FROM ca_hand_facts WHERE rake_paid>6;')
    parity('retention delete subtracts exact facts')
    q('BEGIN; DELETE FROM ca_hand_facts; ROLLBACK;')
    parity('writer rollback rolls back totals')
    q(f"INSERT INTO ca_hand_facts VALUES(gen_random_uuid(),'{U}',NULL,10);")
    parity('null club facts stay out of club totals')
    q("SET ROLE authenticated; SELECT * FROM club_roster_hand_totals;", 'permission denied')
    q("SET ROLE anon; SELECT fn_club_roster_hand_totals_insert();", 'permission denied')
    print('PASS browser table and function privileges', flush=True)
    q(ACTIVATE.read_text(), 'already initialized')
    parity('initialization replay refuses duplicate seed')
    q(f"INSERT INTO clubs VALUES('{B}','Fixture');"
      f"INSERT INTO profiles(id,alias,username) VALUES('{U}','Owner','owner'),('{V}','Player','player');"
      f"INSERT INTO club_members(user_id,club_id,role,status,chip_balance,promo_balance) VALUES"
      f"('{U}','{B}','owner','active',50,0),('{V}','{B}','player','active',25,0);")
    assert q(f"SELECT count(*) FROM ca_club_roster_rows('{B}')") == '2'
    assert q(f"SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='{V}';"
      f"SELECT bool_and(total_fees IS NULL AND total_hands IS NULL) FROM ca_club_roster_rows('{B}')").splitlines()[-1] == 't'
    print('PASS real roster row authorization redacts ordinary player', flush=True)
    assert q(f"SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='{U}';"
      f"SELECT total_fees=(SELECT fees FROM club_roster_hand_totals WHERE club_id='{B}' AND user_id='{U}')"
      f" FROM ca_club_roster_rows('{B}') WHERE user_id='{U}'").splitlines()[-1] == 't'
    print('PASS real roster returns exact authorized totals', flush=True)
    q("ALTER TABLE club_members ADD COLUMN updated_at timestamptz;")
    q("CREATE FUNCTION ca_club_roster_access(uuid,uuid) RETURNS text LANGUAGE sql AS $$SELECT 'staff'::text$$;")
    q("CREATE TABLE audit_trail(actor_id uuid,actor_role text,action text,target_type text,target_id uuid,club_id uuid,before_state jsonb,after_state jsonb,reason text,request_id text);")
    q((ROOT/'scripts/ci/fixtures/player-command-hand-totals/notes-preimage.sql').read_text())
    q((ROOT/'supabase/migrations/20261010065859_player_command_note_retries_serialize_on_the_member.sql').read_text())
    actor = "SET request.jwt.claim.sub='" + U + "';"
    write = f"SELECT ca_club_member_notes_update('{B}','{V}','Concurrent Note','Remark','same-receipt');"
    first = start('BEGIN; ' + actor + write)
    deadline = time.monotonic()+10
    while q("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted") != '1':
        assert time.monotonic() < deadline
        time.sleep(.02)
    second = start(actor + write)
    deadline = time.monotonic()+10
    while q("SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'") != '1':
        assert time.monotonic() < deadline
        time.sleep(.02)
    finish(first, 'COMMIT;')
    assert '"replayed": true' in finish(second)
    assert q("SELECT count(*) FROM audit_trail WHERE request_id='same-receipt'") == '1'
    q(actor + f"SELECT ca_club_member_notes_update('{B}','{V}','Newer Note','Newer Remark','newer-receipt');")
    replay = q(actor + write)
    assert 'Newer Note' in replay and '"replayed": true' in replay
    assert q(f"SELECT nickname FROM club_members WHERE user_id='{V}'") == 'Newer Note'
    q(actor + f"SELECT ca_club_member_notes_update('{B}','{U}','No','No','self');", error='Not Self-Editable')
    print('PASS concurrent note receipts serialize and replay cannot overwrite newer notes', flush=True)
    q('ALTER TABLE ca_hand_facts RENAME TO facts_unavailable_to_roster;')
    assert q(f"SELECT count(*) FROM ca_club_roster_rows('{B}')") == '2'
    print('PASS roster does not scan hand facts after activation', flush=True)
    print('PLAYER COMMAND HAND TOTALS QUALIFICATION PASSED', flush=True)
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
    if started:
        run([PG/'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(cluster)
