#!/usr/bin/env python3
"""A stale tab counts through the same door.

20261002223109_a_counter_is_not_a_public_write took the four raw counters away
from every browser and gave the browser fn_count_content_engagement. The reels
pages - and every tab already open - still call increment_reel_count /
increment_post_count for a view and a share, so after it a real player's view
stopped counting at all.

This harness loads production's exact counter text (the follow-up migration's
md5 pins abort if it is not), runs both shipped migrations verbatim, and proves
as the browser role that an old call is now the caller's own view or share,
once a day, through the same receipt - and that every other browser write
(a like, a comment, any decrement) is refused while the server keeps the
unchanged body.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/a-stale-tab-counts-through-the-same-door')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


pg = find_pg_bin()
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='stale-tab-counts-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55712'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'phase 3: an old counter call is the caller\'s own view or share, and nothing else',
           'cases': [], 'passed': False}

MIGRATIONS = ROOT / 'supabase/migrations'


def one(pattern):
    found = sorted(MIGRATIONS.glob(pattern))
    if len(found) != 1:
        raise RuntimeError(f'expected exactly one {pattern}, found {len(found)}')
    return found[0].read_text()


FIRST = one('*_a_counter_is_not_a_public_write.sql')
SHIPPED = one('*_a_stale_tab_counts_through_the_same_door.sql')
# Another agent's migration over the same two reel routines; both files carry one text.
THEIRS = one('*_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql')

ALICE = '00000000-0000-0000-0000-00000000a11c'
BOB = '00000000-0000-0000-0000-000000000b0b'
REEL = '00000000-0000-0000-0000-0000000000e1'
ALIAS = '00000000-0000-0000-0000-0000000000a1'
POST = '00000000-0000-0000-0000-0000000000f1'
REEL2 = '00000000-0000-0000-0000-0000000000e2'
CLUB = '00000000-0000-0000-0000-0000000000c1'

FIXTURE = f"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Live body of public.fn_is_service_context(), 2026-10-02.
CREATE FUNCTION public.fn_is_service_context() RETURNS boolean LANGUAGE plpgsql STABLE
SET search_path TO 'public' AS $function$
DECLARE v_raw_claims text; v_jwt_role text;
BEGIN
    v_raw_claims := current_setting('request.jwt.claims', true);
    IF v_raw_claims IS NOT NULL AND btrim(v_raw_claims) <> '' AND btrim(v_raw_claims) <> 'null' THEN
        BEGIN v_jwt_role := v_raw_claims::jsonb ->> 'role';
        EXCEPTION WHEN others THEN RETURN false; END;
        RETURN v_jwt_role = 'service_role';
    END IF;
    IF current_user IN ('anon', 'authenticated') THEN RETURN false; END IF;
    RETURN true;
END;
$function$;

CREATE TABLE public.social_reels (id uuid PRIMARY KEY, like_count int DEFAULT 0, comment_count int DEFAULT 0,
  share_count int DEFAULT 0, view_count int DEFAULT 0);
CREATE TABLE public.social_posts (id uuid PRIMARY KEY, author_id uuid, like_count int DEFAULT 0,
  comment_count int DEFAULT 0, share_count int DEFAULT 0, view_count int DEFAULT 0);
CREATE TABLE public.social_reel_aliases (alias_reel_id uuid PRIMARY KEY, canonical_reel_id uuid);
ALTER TABLE public.social_reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON public.social_reels FOR SELECT USING (true);
CREATE POLICY social_posts_read ON public.social_posts FOR SELECT USING (true);
CREATE POLICY social_posts_update_own ON public.social_posts FOR UPDATE TO authenticated
  USING (author_id = (SELECT auth.uid()));
INSERT INTO public.social_reels (id) VALUES ('{REEL}');
INSERT INTO public.social_reel_aliases VALUES ('{ALIAS}', '{REEL}');
INSERT INTO public.social_posts (id, author_id) VALUES ('{POST}', '{BOB}');

-- The four counters: pg_get_functiondef of production, 2026-10-02 (md5-pinned by the migration).
CREATE OR REPLACE FUNCTION public.increment_reel_count(p_reel_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_target uuid;
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'increment_reel_count: invalid field %', p_field;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;
CREATE OR REPLACE FUNCTION public.decrement_reel_count(p_reel_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_target uuid;
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'decrement_reel_count: invalid field %', p_field;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;
CREATE OR REPLACE FUNCTION public.increment_post_count(p_post_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _allowed_fields text[] := ARRAY[
    'like_count', 'comment_count', 'share_count', 'view_count'
  ];
BEGIN
  -- Allowlist guard: reject arbitrary column names
  IF NOT (p_field = ANY(_allowed_fields)) THEN
    RAISE EXCEPTION 'increment_post_count: invalid field %', p_field;
  END IF;

  EXECUTE format(
    'UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING p_post_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.decrement_post_count(p_post_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _allowed_fields text[] := ARRAY[
    'like_count', 'comment_count', 'share_count', 'view_count'
  ];
BEGIN
  IF NOT (p_field = ANY(_allowed_fields)) THEN
    RAISE EXCEPTION 'decrement_post_count: invalid field %', p_field;
  END IF;

  EXECUTE format(
    'UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING p_post_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.increment_reel_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decrement_reel_count(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_reel_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_reel_count(uuid, text) TO authenticated, service_role;

-- The claims, as they stood.
CREATE TABLE public.venue_claims (id uuid PRIMARY KEY, venue_id int, user_id uuid, status text,
  claimant_email text, claimant_phone text, verification_code text);
ALTER TABLE public.venue_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY venue_claims_read ON public.venue_claims FOR SELECT USING (true);
INSERT INTO public.venue_claims VALUES (gen_random_uuid(), 1, '{BOB}', 'pending', 'b@x.test', '555', '424242');
CREATE TABLE public.page_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), page_type text, page_id text,
  user_id uuid, contact_email text, contact_phone text, status text);
ALTER TABLE public.page_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_claims_select ON public.page_claims FOR SELECT USING (true);
INSERT INTO public.page_claims (page_type, page_id, user_id, contact_email, status) VALUES
  ('venue', 'v1', '{ALICE}', 'alice@x.test', 'approved'), ('venue', 'v2', '{BOB}', 'bob@x.test', 'approved');
CREATE TABLE public.page_notifications (id serial PRIMARY KEY, page_type text, page_id text, body text);
ALTER TABLE public.page_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_notifications_visible_to_page_claimant ON public.page_notifications FOR SELECT USING (
  EXISTS (SELECT 1 FROM page_claims pc WHERE pc.page_type = page_notifications.page_type
    AND pc.page_id = page_notifications.page_id AND pc.user_id = (SELECT auth.uid()) AND pc.status = 'approved'));
INSERT INTO public.page_notifications (page_type, page_id, body) VALUES ('venue', 'v1', 'for alice'), ('venue', 'v2', 'for bob');

-- Schedules and the legacy tables, as they stood.
CREATE TABLE public.venue_game_schedules (id serial PRIMARY KEY, venue_id int, game_name text);
ALTER TABLE public.venue_game_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY vgs_select_policy ON public.venue_game_schedules FOR SELECT USING (true);
CREATE POLICY vgs_insert_policy ON public.venue_game_schedules FOR INSERT WITH CHECK ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY vgs_update_policy ON public.venue_game_schedules FOR UPDATE USING ((SELECT auth.uid()) IS NOT NULL);
INSERT INTO public.venue_game_schedules (venue_id, game_name) VALUES (7, '1/2 NLH');
CREATE TABLE public.poker_tables (id serial PRIMARY KEY, name text);
ALTER TABLE public.poker_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON public.poker_tables FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create tables" ON public.poker_tables FOR INSERT
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

-- Profiles, as they stood: a player may update their own row.
CREATE TABLE public.profiles (id uuid PRIMARY KEY, display_name text, email_verified boolean DEFAULT false,
  phone_verified boolean DEFAULT false, access_tier text DEFAULT 'Full_Access', tier text DEFAULT 'Newcomer',
  skill_tier text DEFAULT 'Newcomer', level int DEFAULT 1);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY profiles_update ON public.profiles FOR UPDATE USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);
INSERT INTO public.profiles (id, display_name) VALUES ('{ALICE}', 'alice'), ('{BOB}', 'bob');

-- Logs, as they stood.
CREATE TABLE public.commander_home_group_share_log (id serial PRIMARY KEY, group_id uuid, token_id uuid, caller_uid uuid);
CREATE TABLE public.commander_home_group_view_log (id serial PRIMARY KEY, group_id uuid, caller_uid uuid);
CREATE TABLE public.qr_code_scans (id serial PRIMARY KEY, venue_id int, scanned_by uuid);
ALTER TABLE public.commander_home_group_share_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_view_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_code_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY share_log_insert_authenticated ON public.commander_home_group_share_log FOR INSERT
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY view_log_insert_authenticated ON public.commander_home_group_view_log FOR INSERT
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);
CREATE POLICY "Authenticated users can record scans" ON public.qr_code_scans FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

-- club_members and the CHECK whose function authenticated could not execute.
CREATE TABLE public.clubs (id uuid PRIMARY KEY, is_platform boolean DEFAULT false);
INSERT INTO public.clubs VALUES ('{CLUB}', false);
CREATE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE((SELECT c.is_platform FROM public.clubs c WHERE c.id = p_club_id), false)
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) TO service_role;
CREATE TABLE public.club_members (club_id uuid, user_id uuid, nickname text, is_bot boolean DEFAULT false,
  CONSTRAINT club_members_bot_house_only CHECK ((NOT COALESCE(is_bot, false)) OR fn_ca_house_board_allows_automation(club_id)));
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY club_members_select ON public.club_members FOR SELECT USING (true);
CREATE POLICY club_members_update ON public.club_members FOR UPDATE USING (user_id = (SELECT auth.uid()));
INSERT INTO public.club_members (club_id, user_id) VALUES ('{CLUB}', '{ALICE}');

-- Supabase's default table privileges.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
"""


def as_user(uid, sql, role='authenticated'):
    claims = json.dumps({'sub': uid, 'role': role}) if uid else ''
    return (f"SELECT set_config('request.jwt.claims', '{claims}', false) \\g /dev/null\n"
            f"SET ROLE {role};\n{sql}\nRESET ROLE;\n")


def as_service(sql):
    return ("SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false) \\g /dev/null\n"
            f"SET ROLE service_role;\n{sql}\nRESET ROLE;\n")


def command(argv, sql=None, timeout=60):
    return subprocess.run([str(x) for x in argv], input=sql, text=True,
                          capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed})
    require(passed, name + ': ' + r.stdout[-400:] + r.stderr[-1200:])
    return r.stdout.rstrip('\n')


def refused(name, sql, sqlstate):
    """The statement must fail, with this SQLSTATE."""
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode != 0 and sqlstate in r.stderr
    results['cases'].append({'name': name, 'passed': passed, 'sqlstate': sqlstate})
    require(passed, f'{name}: expected {sqlstate}, got rc={r.returncode}: ' + r.stderr[-800:])


def views(content):
    return f"SELECT view_count||'/'||share_count FROM public.social_reels WHERE id='{content}';"


try:
    version = command([pg / 'postgres', '--version']).stdout
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16+ required: ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                "'\nunix_socket_permissions=0700\nport=" + PORT +
                "\nshared_buffers='16MB'\nmax_connections=20\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE + f"INSERT INTO public.social_reels (id) VALUES ('{REEL2}');")
    run('pre-image-is-production', "SELECT string_agg(md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname)"
        " FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN"
        " ('increment_reel_count','decrement_reel_count','increment_post_count','decrement_post_count');",
        '6e8206b74bc797839782a9017bb94570,2f3f5d1cf59b0645aaee4951943dec6c,'
        '4dab81e6b5c5eed82f71ab751a07a54e,23f843d6fb8c218559dfed7ad59f8421')
    run('first-migration', FIRST)

    # ---------------- BEFORE: an old call no longer counts a real view ----------------
    refused('before-a-stale-tab-view-is-refused',
            as_user(ALICE, f"SELECT public.increment_reel_count('{REEL2}', 'view_count');"), '42501')

    # ---------------- The shipped follow-up, verbatim (md5 pins included) ----------------
    run('shipped-migration', SHIPPED)

    # ---------------- AFTER ----------------
    run('a-stale-tab-view-counts-once',
        as_user(ALICE, '\n'.join(f"SELECT public.increment_reel_count('{REEL2}', 'view_count');"
                                  for _ in range(5))) + views(REEL2), '\n' * 5 + '1/0')
    run('it-is-the-same-receipt-as-the-new-door',
        as_user(ALICE, f"SELECT public.fn_count_content_engagement('{REEL2}', 'view');") + views(REEL2),
        'f\n1/0')
    run('a-stale-tab-share-counts-once',
        as_user(ALICE, f"SELECT public.increment_reel_count('{REEL2}', 'share_count');"
                       f"SELECT public.increment_reel_count('{REEL2}', 'share_count');") + views(REEL2),
        '\n\n1/1')
    run('another-player-counts-once-more',
        as_user(BOB, f"SELECT public.increment_reel_count('{REEL2}', 'view_count');") + views(REEL2),
        '\n2/1')
    refused('a-browser-cannot-add-a-like',
            as_user(ALICE, f"SELECT public.increment_reel_count('{REEL2}', 'like_count');"), '42501')
    refused('a-browser-cannot-add-a-comment-count',
            as_user(ALICE, f"SELECT public.increment_post_count('{POST}', 'comment_count');"), '42501')
    refused('a-browser-cannot-take-a-reel-count-down',
            as_user(ALICE, f"SELECT public.decrement_reel_count('{REEL2}', 'view_count');"), '42501')
    refused('a-browser-cannot-take-a-post-count-down',
            as_user(BOB, f"SELECT public.decrement_post_count('{POST}', 'comment_count');"), '42501')
    run('a-stale-tab-post-view-counts-on-the-post-once',
        as_user(BOB, f"SELECT public.increment_post_count('{POST}', 'view_count');"
                     f"SELECT public.increment_post_count('{POST}', 'view_count');") +
        f"SELECT view_count FROM public.social_posts WHERE id='{POST}';", '\n\n1')
    refused('anon-still-cannot-call-a-counter',
            as_user(None, f"SELECT public.increment_reel_count('{REEL2}', 'view_count');", role='anon'), '42501')
    run('the-server-keeps-the-unchanged-body',
        as_service(f"SELECT public.increment_reel_count('{REEL2}', 'like_count');"
                   f"SELECT public.increment_reel_count('{REEL2}', 'like_count');"
                   f"SELECT public.decrement_reel_count('{REEL2}', 'like_count');"
                   f"SELECT public.increment_post_count('{POST}', 'comment_count');"
                   f"SELECT public.decrement_post_count('{POST}', 'comment_count');") +
        f"SELECT (SELECT like_count FROM public.social_reels WHERE id='{REEL2}')||'/'||"
        f"(SELECT comment_count FROM public.social_posts WHERE id='{POST}');", '\n' * 5 + '1/0')
    reel_md5 = ("SELECT string_agg(md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p"
                " WHERE p.pronamespace = 'public'::regnamespace"
                " AND p.proname IN ('increment_reel_count','decrement_reel_count');")
    before = run('reel-text-after-this-migration', reel_md5)
    run('the-other-reel-migration-changes-nothing', THEIRS + reel_md5, before)
    run('a-session-with-no-request-is-the-server',
        f"SELECT public.increment_reel_count('{ALIAS}', 'share_count');" + views(REEL2) + views(REEL),
        '\n2/1\n0/1')

    results['passed'] = all(c.get('passed', True) for c in results['cases'])
finally:
    if (cluster / 'data/postmaster.pid').exists():
        command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    shutil.rmtree(cluster, ignore_errors=True)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']),
                      'evidence': str(out)}))
