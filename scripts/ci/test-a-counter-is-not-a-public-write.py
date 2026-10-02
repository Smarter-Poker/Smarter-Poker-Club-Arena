#!/usr/bin/env python3
"""Phase 3 security sweep: a counter, a claim, a schedule and a profile flag are
not things any logged-in player can write.

This harness builds a disposable PostgreSQL cluster with the production shape of
every object the migration touches - the four counter functions with their live
bodies and grants, the open policies as they stood, the club_members CHECK whose
function authenticated could not execute - and proves each finding BEFORE the
migration, then runs the shipped migration file verbatim and proves it closed
AFTER, as the real browser role (SET ROLE authenticated plus request.jwt.claims,
the way PostgREST runs a request).
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
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/a-counter-is-not-a-public-write')
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
cluster = Path(tempfile.mkdtemp(prefix='counter-not-public-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55711'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'phase 3: counters, claims, schedules and profile flags are not public writes',
           'cases': [], 'passed': False}

MIGRATIONS = ROOT / 'supabase/migrations'
found = sorted(MIGRATIONS.glob('*_a_counter_is_not_a_public_write.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one a_counter_is_not_a_public_write migration, found {len(found)}')
SHIPPED = found[0].read_text()

ALICE = '00000000-0000-0000-0000-00000000a11c'
BOB = '00000000-0000-0000-0000-000000000b0b'
REEL = '00000000-0000-0000-0000-0000000000e1'
ALIAS = '00000000-0000-0000-0000-0000000000a1'
POST = '00000000-0000-0000-0000-0000000000f1'
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

-- The four counters, live bodies and live grants (2026-10-02).
CREATE FUNCTION public.increment_reel_count(p_reel_id uuid, p_field text) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_target uuid;
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'increment_reel_count: invalid field %', p_field;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format('UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field) USING v_target;
END
$function$;
CREATE FUNCTION public.decrement_reel_count(p_reel_id uuid, p_field text) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_target uuid;
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'decrement_reel_count: invalid field %', p_field;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format('UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field) USING v_target;
END
$function$;
CREATE FUNCTION public.increment_post_count(p_post_id uuid, p_field text) RETURNS void LANGUAGE plpgsql
SET search_path TO 'public' AS $function$
BEGIN
  IF NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count'])) THEN
    RAISE EXCEPTION 'increment_post_count: invalid field %', p_field;
  END IF;
  EXECUTE format('UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field) USING p_post_id;
END;
$function$;
CREATE FUNCTION public.decrement_post_count(p_post_id uuid, p_field text) RETURNS void LANGUAGE plpgsql
SET search_path TO 'public' AS $function$
BEGIN
  IF NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count'])) THEN
    RAISE EXCEPTION 'decrement_post_count: invalid field %', p_field;
  END IF;
  EXECUTE format('UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field) USING p_post_id;
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
    run('fixture', FIXTURE)

    # ---------------- BEFORE: every finding reproduces ----------------
    loop = '\n'.join(f"SELECT public.increment_reel_count('{REEL}', 'view_count');" for _ in range(50))
    run('before-any-player-adds-fifty-views-to-any-reel',
        as_user(ALICE, loop) + views(REEL), '\n' * 50 + '50/0')
    run('before-any-player-reads-a-venue-claims-verification-code',
        as_user(ALICE, 'SELECT verification_code FROM public.venue_claims;'), '424242')
    run('before-any-player-rewrites-any-venues-schedule',
        as_user(ALICE, "UPDATE public.venue_game_schedules SET game_name='closed' WHERE venue_id=7 RETURNING game_name;"),
        'closed')
    run('before-a-player-verifies-their-own-phone',
        as_user(ALICE, f"UPDATE public.profiles SET phone_verified=true WHERE id='{ALICE}' RETURNING phone_verified;"),
        't')
    refused('before-every-browser-write-to-club-members-is-refused',
            as_user(ALICE, f"UPDATE public.club_members SET nickname='a' WHERE user_id='{ALICE}';"), '42501')
    run('reset-before-arm', "UPDATE public.social_reels SET view_count=0, share_count=0;"
        " UPDATE public.venue_game_schedules SET game_name='1/2 NLH';"
        f" UPDATE public.profiles SET phone_verified=false WHERE id='{ALICE}';")

    # ---------------- The shipped migration, verbatim ----------------
    run('shipped-migration', SHIPPED)

    # ---------------- AFTER ----------------
    refused('the-raw-reel-counter-refuses-a-player',
            as_user(ALICE, f"SELECT public.increment_reel_count('{REEL}', 'view_count');"), '42501')
    refused('the-raw-reel-decrement-refuses-a-player',
            as_user(ALICE, f"SELECT public.decrement_reel_count('{REEL}', 'like_count');"), '42501')
    refused('the-raw-post-counter-refuses-anon',
            as_user(None, f"SELECT public.increment_post_count('{POST}', 'view_count');", role='anon'), '42501')
    refused('the-raw-post-counter-refuses-a-player',
            as_user(ALICE, f"SELECT public.decrement_post_count('{POST}', 'comment_count');"), '42501')
    run('the-server-keeps-the-raw-counters',
        as_service(f"SELECT public.increment_reel_count('{REEL}', 'like_count');") +
        f"SELECT like_count FROM public.social_reels WHERE id='{REEL}';", '\n1')

    many = '\n'.join(f"SELECT public.fn_count_content_engagement('{REEL}', 'view');" for _ in range(50))
    run('fifty-views-from-one-player-count-once',
        as_user(ALICE, many) + views(REEL), 't\n' + 'f\n' * 49 + '1/0')
    run('another-player-counts-once-more',
        as_user(BOB, f"SELECT public.fn_count_content_engagement('{REEL}', 'view');") + views(REEL), 't\n2/0')
    run('an-alias-counts-on-its-canonical-reel-and-is-the-same-view',
        as_user(ALICE, f"SELECT public.fn_count_content_engagement('{ALIAS}', 'view');") + views(REEL), 'f\n2/0')
    run('a-share-is-its-own-receipt',
        as_user(ALICE, f"SELECT public.fn_count_content_engagement('{REEL}', 'share');"
                       f"SELECT public.fn_count_content_engagement('{REEL}', 'share');") + views(REEL),
        't\nf\n2/1')
    run('a-post-counts-on-the-post',
        as_user(ALICE, f"SELECT public.fn_count_content_engagement('{POST}', 'view', 'posts');"
                       f"SELECT public.fn_count_content_engagement('{POST}', 'view');") +
        f"SELECT view_count FROM public.social_posts WHERE id='{POST}';", 't\nf\n1')
    run('a-reels-hint-never-counts-a-post',
        as_user(BOB, f"SELECT public.fn_count_content_engagement('{POST}', 'view', 'reels');"), 'f')
    run('nothing-counts-for-a-caller-with-no-identity',
        as_service(f"SELECT public.fn_count_content_engagement('{REEL}', 'view');") + views(REEL), 'f\n2/1')
    refused('anon-cannot-reach-the-counter-door',
            as_user(None, f"SELECT public.fn_count_content_engagement('{REEL}', 'view');", role='anon'), '42501')
    run('an-unknown-id-counts-nothing',
        as_user(ALICE, "SELECT public.fn_count_content_engagement(gen_random_uuid(), 'view');"), 'f')
    refused('only-view-and-share-are-countable',
            as_user(ALICE, f"SELECT public.fn_count_content_engagement('{REEL}', 'like');"), '22023')
    run('a-day-later-the-same-player-counts-again',
        "UPDATE public.content_engagement_receipts SET counted_at = now() - interval '25 hours'"
        f" WHERE viewer_id='{ALICE}' AND kind='view' AND content_id='{REEL}';\n" +
        as_user(ALICE, f"SELECT public.fn_count_content_engagement('{REEL}', 'view');") + views(REEL) +
        f"SELECT times_counted FROM public.content_engagement_receipts WHERE viewer_id='{ALICE}'"
        f" AND kind='view' AND content_id='{REEL}';", 't\n3/1\n2')
    refused('a-player-cannot-read-the-receipts',
            as_user(ALICE, 'SELECT count(*) FROM public.content_engagement_receipts;'), '42501')

    refused('a-venue-claim-is-not-readable-by-a-player',
            as_user(ALICE, 'SELECT verification_code FROM public.venue_claims;'), '42501')
    refused('a-venue-claim-is-not-readable-by-anon',
            as_user(None, 'SELECT verification_code FROM public.venue_claims;', role='anon'), '42501')
    run('the-server-still-reads-venue-claims',
        as_service('SELECT verification_code FROM public.venue_claims;'), '424242')
    run('a-page-claimant-sees-only-their-own-claim',
        as_user(ALICE, 'SELECT string_agg(contact_email, \',\') FROM public.page_claims;'), 'alice@x.test')
    run('and-still-sees-their-pages-notifications',
        as_user(ALICE, 'SELECT string_agg(body, \',\') FROM public.page_notifications;'), 'for alice')
    refused('anon-cannot-read-page-claims',
            as_user(None, 'SELECT count(*) FROM public.page_claims;', role='anon'), '42501')

    run('a-player-cannot-rewrite-a-venues-schedule',
        as_user(ALICE, "UPDATE public.venue_game_schedules SET game_name='closed' WHERE venue_id=7;") +
        'SELECT game_name FROM public.venue_game_schedules;', '1/2 NLH')
    refused('a-player-cannot-post-a-venues-schedule',
            as_user(ALICE, "INSERT INTO public.venue_game_schedules (venue_id, game_name) VALUES (7, 'x');"), '42501')
    refused('a-player-cannot-create-a-legacy-table',
            as_user(ALICE, "INSERT INTO public.poker_tables (name) VALUES ('x');"), '42501')
    run('the-server-still-writes-schedules',
        as_service("UPDATE public.venue_game_schedules SET game_name='2/5 NLH' WHERE venue_id=7 RETURNING game_name;"),
        '2/5 NLH')

    for col, val in (('email_verified', 'true'), ('phone_verified', 'true'), ('access_tier', "'god'"),
                     ('tier', "'vip'"), ('skill_tier', "'Legend'"), ('level', '99')):
        refused(f'a-player-cannot-set-their-own-{col.replace("_", "-")}',
                as_user(ALICE, f"UPDATE public.profiles SET {col}={val} WHERE id='{ALICE}';"), '42501')
    run('a-player-still-edits-their-own-name',
        as_user(ALICE, f"UPDATE public.profiles SET display_name='alice two' WHERE id='{ALICE}' RETURNING display_name;"),
        'alice two')
    run('the-server-still-verifies-a-phone',
        as_service(f"UPDATE public.profiles SET phone_verified=true WHERE id='{ALICE}' RETURNING phone_verified;"), 't')

    refused('a-share-log-row-cannot-name-somebody-else',
            as_user(ALICE, f"INSERT INTO public.commander_home_group_share_log (caller_uid) VALUES ('{BOB}');"), '42501')
    refused('a-view-log-row-cannot-name-somebody-else',
            as_user(ALICE, f"INSERT INTO public.commander_home_group_view_log (caller_uid) VALUES ('{BOB}');"), '42501')
    refused('a-scan-cannot-name-somebody-else',
            as_user(ALICE, f"INSERT INTO public.qr_code_scans (venue_id, scanned_by) VALUES (1, '{BOB}');"), '42501')
    run('a-log-row-naming-the-caller-is-accepted',
        as_user(ALICE, f"INSERT INTO public.commander_home_group_view_log (caller_uid) VALUES ('{ALICE}');"
                       f"INSERT INTO public.qr_code_scans (venue_id, scanned_by) VALUES (1, '{ALICE}');") +
        'SELECT (SELECT count(*) FROM public.commander_home_group_view_log)||\'/\'||(SELECT count(*) FROM public.qr_code_scans);',
        '1/1')

    run('a-player-can-write-their-own-club-row-again',
        as_user(ALICE, f"UPDATE public.club_members SET nickname='ace' WHERE user_id='{ALICE}' RETURNING nickname;"),
        'ace')
    refused('and-the-house-board-check-still-holds',
            as_user(ALICE, f"UPDATE public.club_members SET is_bot=true WHERE user_id='{ALICE}';"), '23514')

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
