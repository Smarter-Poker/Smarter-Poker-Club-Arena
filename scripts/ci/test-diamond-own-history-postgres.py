"""Native proof of the actual own-history RPC and canonical Arena access authority."""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PG = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
if not (PG / 'postgres').exists():
    PG = pathlib.Path('/usr/lib/postgresql/17/bin')
parent = pathlib.Path(os.environ.get('TMPDIR', tempfile.gettempdir()))
if sys.platform == 'darwin' and not pathlib.Path('/Volumes/SmarterWork').is_mount():
    raise RuntimeError('External SSD is not mounted; refusing internal-drive scratch')
if pathlib.Path('/Volumes/SmarterWork').is_mount():
    parent = pathlib.Path('/Volumes/SmarterWork/agent-work')
work = pathlib.Path(tempfile.mkdtemp(prefix='dh-', dir=parent))
sock = work / 's'
sock.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
checks = 0

def command(args, sql=None, refuse=None):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=40)
    if refuse:
        assert result.returncode and refuse in result.stderr, result.stderr
    elif result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

psql = [PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '55819', '-U', 'postgres', '-d', 'postgres']
def sql(body, refuse=None):
    return command(psql, body, refuse)

def check(ok):
    global checks
    assert ok
    checks += 1

def definition(path, name):
    text = path.read_text()
    match = re.search(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\(.*?AS (\$[A-Za-z_0-9]*\$).*?\1\s*;', text, re.S | re.I)
    assert match, name
    return match.group(0)

U='10000000-0000-0000-0000-000000000001'
V='10000000-0000-0000-0000-000000000002'
A='20000000-0000-0000-0000-000000000001'
C='20000000-0000-0000-0000-000000000002'
H='30000000-0000-0000-0000-000000000001'
J='30000000-0000-0000-0000-000000000002'
K='30000000-0000-0000-0000-000000000003'
T='40000000-0000-0000-0000-000000000001'
def own(club=A, extra=''):
    return f"SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','{U}',false); {extra} SELECT hand->>'id' FROM ca_own_hand_history_by_club('{club}');"

try:
    check(command([PG/'postgres','--version']).startswith('postgres (PostgreSQL) 17.'))
    command([PG/'initdb','-D',work/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    command([PG/'pg_ctl','-D',work/'d','-l',work/'log','-o',f"-k {sock} -p 55819 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
    fields='created_at started_at pot_size community_cards community_cards2 community_cards3 rit_boards players actions winners winners_by_board game_variant small_blind big_blind rake_amount bbj_amount button_seat hole_cards showdown pots bomb_pot kill_pot'.split()
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; CREATE TABLE profiles(id uuid); CREATE TABLE clubs(id uuid,club_id bigint,slug text,lifecycle_status text,asset text,is_platform boolean,union_id uuid); CREATE TABLE club_members(club_id uuid,user_id uuid,status text,role text); CREATE TABLE ca_arena_settings(club_id uuid,cash_games_enabled boolean,tournaments_enabled boolean); CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,club_id uuid); CREATE TABLE hand_history(id uuid,table_id uuid,hand_number bigint,"+','.join(f+' jsonb' for f in fields)+');')
    # Load the exact context shipped by the maintained migration, never a mock.
    context_paths=sorted((ROOT/'supabase/migrations').glob('*.sql'))
    context=None
    for path in reversed(context_paths):
        if re.search(r'CREATE OR REPLACE FUNCTION public\.fn_poker_arena_context\(',path.read_text(),re.I):
            context=definition(path,'fn_poker_arena_context'); break
    assert context
    sql(context)
    original=definition(ROOT/'supabase/migrations/20261003134650_stats_facts_outbox_and_corrections.sql','ca_own_hand_history_by_club')
    sql(original+" REVOKE ALL ON FUNCTION ca_own_hand_history_by_club(uuid,uuid,integer,integer) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_own_hand_history_by_club(uuid,uuid,integer,integer) TO authenticated,service_role;")
    sql(f"INSERT INTO profiles VALUES('{U}'),('{V}'); INSERT INTO clubs VALUES('{A}',1,'diamond-arena','active','diamonds',true,null),('{C}',2,'chip','active','chips',false,null); INSERT INTO ca_arena_settings VALUES('{A}',true,true); INSERT INTO hand_history(id,table_id,hand_number) VALUES('{H}','{T}',1),('{J}','{T}',2),('{K}','{T}',3); INSERT INTO ca_hand_facts VALUES('{H}','{U}','{A}'),('{J}','{V}','{A}'),('{K}','{U}','{C}');")
    check(sql("SELECT md5(pg_get_functiondef('ca_own_hand_history_by_club(uuid,uuid,integer,integer)'::regprocedure))")=='64f95bd1cc7d0537c22005f16dbaa9f3')
    sql(own(), 'not authorized for hand-history club'); check(True)
    migration=(ROOT/'supabase/migrations/20261015213440_diamond_hand_history_admits_automatic_arena_membership.sql').read_text()
    sql(migration)
    check(sql(own()).splitlines()[-1]==H)
    sql(own(C),'not authorized for hand-history club'); check(True)
    sql(f"INSERT INTO club_members VALUES('{C}','{U}','approved','member');")
    check(sql(own(C)).splitlines()[-1]==K)
    sql(f"UPDATE club_members SET status='pending';")
    sql(own(C),'not authorized for hand-history club'); check(True)
    sql(f"UPDATE clubs SET lifecycle_status='retired' WHERE id='{A}';")
    sql(own(),'not authorized for hand-history club'); check(True)
    sql(f"UPDATE clubs SET lifecycle_status='active',is_platform=false WHERE id='{A}';")
    sql(own(),'Invalid Diamond Arena Identity'); check(True)
    sql(f"UPDATE clubs SET is_platform=true WHERE id='{A}';")
    sql("SET ROLE authenticated; SELECT * FROM ca_own_hand_history_by_club('"+A+"');",'requires authentication'); check(True)
    sql("SET ROLE anon; SELECT * FROM ca_own_hand_history_by_club('"+A+"');",'permission denied'); check(True)
    check(sql("SELECT has_function_privilege('authenticated','ca_own_hand_history_by_club(uuid,uuid,integer,integer)','EXECUTE') AND NOT has_function_privilege('anon','ca_own_hand_history_by_club(uuid,uuid,integer,integer)','EXECUTE')")=='t')
    sql(migration,'DIAMOND_OWN_HISTORY_PREIMAGE_CHANGED'); check(True)
    print(f'{checks} native Diamond own-history checks passed: original refusal reproduced, automatic membership admitted, own hands only, chip membership, retired/malformed identity, authentication, ACL and replay refusal preserved.')
finally:
    subprocess.run(list(map(str,[PG/'pg_ctl','-D',work/'d','-m','immediate','-w','stop'])),capture_output=True)
    shutil.rmtree(work)
