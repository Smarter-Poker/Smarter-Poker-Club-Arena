"""Execute the exact mutual-friends migration on disposable PostgreSQL 17."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='mf-'))
socket = cluster / 's'
socket.mkdir()
owner = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
if owner:
    shutil.chown(cluster, 'postgres')
    shutil.chown(socket, 'postgres')
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
started = False


def run(args, sql=None):
    return subprocess.run([str(x) for x in args], input=sql, text=True,
                          capture_output=True, check=True, timeout=60, env=env).stdout.strip()


def q(sql):
    return run([PG / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket,
                '-U', 'postgres', '-d', 'postgres'], sql)


def friends(viewer, other):
    return json.loads(q(f"""SELECT set_config('request.jwt.claim.sub','{viewer}',false);
SELECT coalesce(jsonb_agg(x),'[]') FROM public.get_mutual_friends('{other}') x;""").splitlines()[-1])


A, B, C, D, E = [f'00000000-0000-0000-0000-{n:012}' for n in range(1, 6)]
try:
    run(owner + [PG / 'initdb', '-D', cluster / 'd', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    run(owner + [PG / 'pg_ctl', '-D', cluster / 'd', '-l', cluster / 'log', '-o',
                 f"-k {socket} -c listen_addresses=''", '-w', 'start'])
    started = True
    q("""CREATE SCHEMA auth;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE TABLE public.friendships(user_id uuid, friend_id uuid, status text);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, alias text, username text,
 display_name text, first_name text, last_name text, full_name text,
 arena_avatar_url text, avatar_url text);
CREATE FUNCTION public.fn_arena_name(text,text,text,text,text,text) RETURNS text
 LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce($1,$2,$3,'Player') $$;""")
    baseline = ROOT / 'scripts/ci/fixtures/mutual-friends-baseline.sql'
    q(baseline.read_text())
    q("""REVOKE ALL ON FUNCTION public.get_mutual_friends(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mutual_friends(uuid) TO authenticated, service_role;""")
    q(f"""INSERT INTO public.profiles VALUES
('{C}','MamaPriya','social-name',NULL,NULL,NULL,NULL,'/arena.png','/social.png'),
('{D}','SecondFriend',NULL,NULL,NULL,NULL,NULL,'   ','/fallback.png'),
('{E}','PendingFriend',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO public.friendships VALUES
('{A}','{C}','accepted'),('{C}','{A}','accepted'),
('{B}','{C}','accepted'),('{C}','{B}','accepted');""")
    assert len(friends(A, B)) == 4, 'baseline must reproduce screenshot'
    acl = q("SELECT proacl::text FROM pg_proc WHERE oid='public.get_mutual_friends(uuid)'::regprocedure")
    migration = (ROOT / 'supabase/migrations/20261021204534_mutual_friends_are_unique_players.sql').read_text()
    q(migration)
    assert friends(A, B) == [{'id': C, 'username': 'MamaPriya', 'avatar_url': '/arena.png'}]
    q(f"""INSERT INTO public.friendships VALUES
('{A}','{C}','accepted'),('{B}','{C}','accepted'),
('{D}','{A}','accepted'),('{B}','{D}','accepted'),
('{A}','{E}','accepted'),('{B}','{E}','pending');""")
    result = friends(A, B)
    assert [x['id'] for x in result] == [C, D]
    assert result[1]['avatar_url'] == '/fallback.png'
    assert friends(B, A) == result, 'intersection must be symmetric'
    assert friends('', B) == [], 'anonymous viewer must receive nothing'
    assert q("SELECT count(*) FROM public.get_mutual_friends(NULL)") == '0'
    assert q("SELECT proacl::text FROM pg_proc WHERE oid='public.get_mutual_friends(uuid)'::regprocedure") == acl
    assert q("SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='public.get_mutual_friends(uuid)'::regprocedure") == 't'
    try:
        q(migration)
        raise AssertionError('replay must refuse changed preimage')
    except subprocess.CalledProcessError as error:
        assert 'mutual_friends_preimage_changed' in error.stderr
    print(json.dumps({'status': 'PASS', 'baseline_count': 4, 'fixed_count': 1,
                      'checks': ['reciprocal_and_duplicate_edges', 'distinct_players',
                                 'pending_excluded', 'symmetric', 'arena_identity',
                                 'avatar_fallback', 'anonymous_and_null', 'ACL_preserved',
                                 'security_definer_and_search_path', 'replay_refused']}))
finally:
    if started:
        run(owner + [PG / 'pg_ctl', '-D', cluster / 'd', '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(cluster)
