#!/usr/bin/env python3
"""Kill pot table settings refuse what the engine cannot honour.

Installs 20260924034010_kill_pot_table_settings.sql VERBATIM into an isolated,
throwaway PostgreSQL cluster (PG_BIN) on top of a minimal fixture, and proves:
the install rewrites and scans neither hot table, the defaults, the three
CHECKs, the trigger's refusals and admissions (capability, variant, tournament,
bombs, cent and Diamond exactness), that 'off' is never refused and never even
reaches the trigger, the owner door's authorization and audit, and that a
cluster keeps the setting when it opens a new table or re-applies its ruleset.

The functions the migration reads or edits are loaded from their own migration
files, not retyped: the capability registry (20260924025555, when this tree
has it, else a faithful stub of fn_capability_available that says so in
RESULTS.json), fn_can_create_games (20260827), fn_ca_insert_hand_with_awards
(20260906113554), fn_managed_game_contract_document (20260909062236) and the
newest repository bodies of fn_cash_cluster_open_table and fn_cash_apply_ruleset
(their full definitions plus every later anchored patch, in version order).
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
MIG = ROOT / 'supabase/migrations'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/kill-pot-table-settings')
parser.add_argument('--registry', type=Path, default=None,
                    help='capability registry migration to load (default: the one in supabase/migrations, if any)')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='kill-pot-settings-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55693'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'kill pot table settings: columns, guard trigger, owner door, cluster projection; not engine play',
           'cases': [], 'passed': False}

installer_path = MIG / '20260924034010_kill_pot_table_settings.sql'
installer = installer_path.read_text()
if args.registry is not None:
    registry_path = args.registry.resolve()
else:
    found = sorted(MIG.glob('*_one_capability_registry_and_accepted_event_continuation.sql'))
    registry_path = found[-1] if found else None
results['registry'] = str(registry_path.relative_to(ROOT)) if registry_path and registry_path.is_relative_to(ROOT) else (
    str(registry_path) if registry_path else 'stub: faithful copy of fn_capability_available (registry migration not in this tree)')

OWNER = '00000000-0000-4000-8000-0000000000a1'
ADMIN = '00000000-0000-4000-8000-0000000000a2'
PLAYER = '00000000-0000-4000-8000-0000000000a3'
CLUB = '00000000-0000-4000-8000-0000000000c1'
DIAMOND = '002c2d27-9584-4e52-835a-bb2be148fc81'
TOURN = '00000000-0000-4000-8000-0000000000f1'
G_FLH = '00000000-0000-4000-8000-00000000e001'
G_NLH = '00000000-0000-4000-8000-00000000e002'
G_BOMB = '00000000-0000-4000-8000-00000000e003'
G_ODD = '00000000-0000-4000-8000-00000000e004'
CLOSED_T = '00000000-0000-4000-8000-0000000000d9'


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None, message=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if message is not None:
        passed = passed and message in r.stderr
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed, 'expectedSqlstate': error,
                             'expectedMessage': message, 'expected': expected})
    require(passed, name + ': ' + r.stdout[-800:] + r.stderr[-1500:])
    return r.stdout.rstrip('\n')


def probe(name, body, expected=None, error=None, message=None):
    return run(name, 'BEGIN;\n' + body + '\nROLLBACK;', expected, error, message)


def as_user(uid, body):
    return (f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '{uid}';"
            " SET LOCAL request.jwt.claim.role = 'authenticated';\n" + body)


def between(text, start, end, include_end=True):
    i = text.index(start)
    j = text.index(end, i + len(start))
    return text[i:j + (len(end) if include_end else 0)]


def cluster_bodies():
    """The newest repository bodies of the two cluster writers: each full
    definition, then every later anchored patch, in version order."""
    parts = []
    s = (MIG / '20260905050000_the_move_survives_the_hand_and_a_game_seats_you_once.sql').read_text()
    parts.append(between(s, 'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table', '\n$$;'))
    s = (MIG / '20260909181230_the_floor_follows_the_player_and_the_ruleset_projects_every_promise.sql').read_text()
    i = s.index('CREATE OR REPLACE FUNCTION public.fn_cash_apply_ruleset')
    j = s.index('$function$;', s.index('AS $function$', i) + 13) + len('$function$;')
    parts.append(s[i:j])
    s = (MIG / '20260909191454_the_promise_is_pinned_the_ensure_knows_its_template_and_the_seat_ceiling_follows_the_game.sql').read_text()
    parts.append(between(s, 'DO $reconciler$', '$reconciler$;'))
    parts.append(between(s, 'DO $opener$', '$opener$;'))
    for f, anchor in [
        ('20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql',
         "v_fn  text := 'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'"),
        ('20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql',
         "v_src := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'"),
    ]:
        s = (MIG / f).read_text()
        i = s.rindex('DO $do$', 0, s.index(anchor))
        j = s.index('$do$;', i + 8) + len('$do$;')
        parts.append(s[i:j])
    return '\n\n'.join(parts) + '\n'


def authority_bodies():
    s = (MIG / '20260827_snapshot_game_creation_access_functions.sql').read_text()
    a = between(s, 'CREATE OR REPLACE FUNCTION public.fn_club_union_context', '$function$;')
    b = between(s, 'CREATE OR REPLACE FUNCTION public.fn_can_create_games', '$function$;')
    s = (MIG / '20260906113554_the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it.sql').read_text()
    c = between(s, 'CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards', 'END $fn$;')
    s = (MIG / '20260909062236_terminal_tables_cannot_commit_live_occupancies.sql').read_text()
    d = between(s, 'definition := $definition$', '$definition$;', include_end=False)[len('definition := $definition$'):]
    return '\n\n'.join([a, b, c, d + ';']) + '\n'


FIXTURE = f"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('fixture.session_live', true), ''), 'true')::boolean $$;
CREATE TABLE public.ca_declared_money_triggers (table_name text, trigger_name text, note text,
  PRIMARY KEY (table_name, trigger_name));
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL, club_id uuid, union_id uuid,
  parent_tournament_id uuid, created_at timestamptz DEFAULT now(),
  CONSTRAINT tournaments_status_check CHECK (status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING','COMPLETED','CANCELLED')));
INSERT INTO public.tournaments (id, status, club_id) VALUES ('{TOURN}', 'RUNNING', '{CLUB}');

CREATE TABLE public.clubs (id uuid PRIMARY KEY, name text, owner_id uuid, is_union boolean DEFAULT false,
  union_id uuid, asset text NOT NULL DEFAULT 'chips', is_platform boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX poker_arena_one_diamond_identity ON public.clubs(asset) WHERE asset = 'diamonds';
CREATE TABLE public.unions (id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.union_admins (union_id uuid, user_id uuid);
CREATE TABLE public.union_clubs (union_id uuid, club_id uuid);
CREATE TABLE public.club_members (club_id uuid, user_id uuid, role text, status text);
INSERT INTO public.clubs (id, name, owner_id) VALUES ('{CLUB}', 'Fixture Club', '{OWNER}');
INSERT INTO public.clubs (id, name, asset, is_platform) VALUES ('{DIAMOND}', 'Diamond Arena', 'diamonds', true);
INSERT INTO public.club_members VALUES ('{CLUB}', '{OWNER}', 'owner', 'active'),
  ('{CLUB}', '{ADMIN}', 'admin', 'active'), ('{CLUB}', '{PLAYER}', 'member', 'active');

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, union_id uuid, name text,
  game_type text DEFAULT 'cash', game_variant text, game_mode text, small_blind numeric, big_blind numeric,
  stakes text, max_players integer, min_buy_in numeric, max_buy_in numeric,
  ante_enabled boolean, ante numeric, ante_bb numeric, big_blind_ante_enabled boolean,
  nit_game boolean, career_percent_min integer, maintain_percent_min integer, maintain_hands integer,
  bomb_pot_enabled boolean DEFAULT false, bomb_pot_trigger_mode text, bomb_pot_interval_seconds integer,
  bomb_pot_frequency integer, bomb_pot_ante_multiplier integer, bomb_pot_board_count smallint,
  bomb_pot_double_board boolean, bomb_pot_min_players integer,
  straddle_enabled boolean, auto_utg_straddle boolean, voluntary_straddle boolean,
  run_it_mode text, run_it_twice boolean, allow_run_it_twice boolean, run_it_twice_enabled boolean,
  rake_percent numeric, rake_cap_bb numeric, is_private boolean, is_vip_only boolean, is_anonymous boolean,
  ban_chat boolean, insurance_enabled boolean, seven_deuce_enabled boolean, seven_deuce_amount numeric,
  action_time_seconds integer, auto_start_players integer, auto_extension boolean, auto_restart boolean,
  auto_create_table boolean, status text DEFAULT 'waiting', current_players integer DEFAULT 0, created_by uuid,
  cluster_id uuid, role text, main_index integer, lifecycle text, opened_at timestamptz, live_at timestamptz,
  tournament_id uuid, is_deleted boolean DEFAULT false, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
GRANT SELECT, INSERT, UPDATE ON public.tables TO service_role, authenticated;
CREATE TABLE public.table_seats (table_id uuid, seat_number integer, left_at timestamptz);
CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid, hand_number bigint,
  small_blind numeric, big_blind numeric(12,2), bbj_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cash_games (
  id uuid PRIMARY KEY, club_id uuid, union_id uuid, name text, template_name text, variant text,
  sb numeric, bb numeric, handedness integer, ruleset_snapshot jsonb, enabled boolean DEFAULT true,
  must_move boolean DEFAULT true, created_by uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.cash_cluster_events (id bigserial PRIMARY KEY, game_id uuid NOT NULL, table_id uuid,
  kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{{}}'::jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.table_settings_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, table_id uuid NOT NULL, club_id uuid NOT NULL,
  changed_by uuid NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), before jsonb NOT NULL, after jsonb NOT NULL);
CREATE FUNCTION public.fn_cash_stakes_label(p_sb numeric, p_bb numeric, p_variant text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT trim_scale(p_sb)::text || '/' || trim_scale(p_bb)::text $$;

-- An existing estate: rows that predate the columns, on both hot tables.
INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, bomb_pot_enabled, cluster_id, lifecycle)
SELECT '{CLUB}', 'Legacy ' || g, CASE WHEN g % 3 = 0 THEN 'flh' ELSE 'nlh' END, 0.05, 0.10, g % 5 = 0, NULL, 'live'
  FROM generate_series(1, 400) g;
INSERT INTO public.tables (id, club_id, name, game_variant, small_blind, big_blind, tournament_id, game_type)
VALUES ('00000000-0000-4000-8000-0000000000d1', '{CLUB}', 'Tournament Table', 'flh', 50, 100, '{TOURN}', 'tournament');
INSERT INTO public.hand_history (table_id, hand_number, small_blind, big_blind)
SELECT '00000000-0000-4000-8000-0000000000d1', g, 0.05, 0.10 FROM generate_series(1, 5000) g;
"""

SNAPSHOT_CLASSIC = ('{"bombs":{"enabled":false},"regular_ante":"none","vpip_floor":0,"vpip_window":10,'
                    '"options":{},"min_buyin_bb":40,"max_buyin_bb":200,"run_it_n_times":"opt_in"}')
SNAPSHOT_BOMBS = ('{"bombs":{"enabled":true,"trigger":"every_orbit","ante_bb":2,"boards":1},"regular_ante":"sb",'
                  '"vpip_floor":20,"vpip_window":10,"options":{},"min_buyin_bb":40,"max_buyin_bb":200,"run_it_n_times":"opt_in"}')

GAMES = f"""
INSERT INTO public.cash_games (id, club_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by) VALUES
  ('{G_FLH}', '{CLUB}', 'FLH 0.05/0.10 Classic', 'classic', 'flh', 0.05, 0.10, 6, '{SNAPSHOT_CLASSIC}', '{OWNER}'),
  ('{G_NLH}', '{CLUB}', 'NLH 0.05/0.10 Classic', 'classic', 'nlh', 0.05, 0.10, 6, '{SNAPSHOT_CLASSIC}', '{OWNER}'),
  ('{G_BOMB}', '{CLUB}', 'FLO8 0.10/0.20 Action', 'action', 'flo8', 0.10, 0.20, 6, '{SNAPSHOT_BOMBS}', '{OWNER}'),
  ('{G_ODD}', '{CLUB}', 'FLH 0.02/0.05 Classic', 'classic', 'flh', 0.02, 0.05, 6, '{SNAPSHOT_CLASSIC}', '{OWNER}');
SELECT public.fn_cash_cluster_open_table('{G_FLH}', 'main', 1, 'live', NULL);
SELECT public.fn_cash_cluster_open_table('{G_FLH}', 'feeder', NULL, 'live', NULL);
SELECT public.fn_cash_cluster_open_table('{G_ODD}', 'main', 1, 'live', NULL);
INSERT INTO public.tables (id, club_id, name, game_variant, small_blind, big_blind, cluster_id, role, lifecycle, status)
VALUES ('{CLOSED_T}', '{CLUB}', 'Closed', 'flh', 0.05, 0.10, '{G_FLH}', 'feeder', 'closed', 'closed');
"""

STUB_REGISTRY = """
BEGIN;
CREATE TABLE public.platform_capabilities (capability_id text PRIMARY KEY, rule_version text NOT NULL,
  readiness text NOT NULL, readiness_evidence jsonb NOT NULL DEFAULT '{}'::jsonb, revision bigint NOT NULL DEFAULT 1);
INSERT INTO public.platform_capabilities VALUES ('cash.fixed_limit.kill_pots', 'kill-v1', 'planned', '{}', 1);
-- Verbatim body of fn_capability_available from 20260924025555.
CREATE FUNCTION public.fn_capability_available(p_capability_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT COALESCE(
    (SELECT c.readiness IN ('deployed','production_verified')
       FROM public.platform_capabilities c
      WHERE c.capability_id = p_capability_id),
    false);
$fn$;
REVOKE ALL ON FUNCTION public.fn_capability_available(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_capability_available(text) TO authenticated, service_role;
COMMIT;
"""


def set_readiness(name, readiness):
    """Move cash.fixed_limit.kill_pots through the registry's own writer when the
    real registry is loaded, else through the stub row."""
    if registry_path:
        evidence = '{"harness":"test-kill-pot-table-settings"}' if readiness in ('deployed', 'production_verified') else '{}'
        sql = ("BEGIN; SET LOCAL request.jwt.claim.role = 'service_role';"
               " SELECT public.fn_set_capability_readiness('cash.fixed_limit.kill_pots', '" + readiness + "', 'kill-v1',"
               " (SELECT revision FROM public.platform_capabilities WHERE capability_id='cash.fixed_limit.kill_pots'),"
               " '" + evidence + "'::jsonb)->>'readiness'; COMMIT;")
    else:
        sql = ("UPDATE public.platform_capabilities SET readiness='" + readiness + "', revision=revision+1"
               " WHERE capability_id='cash.fixed_limit.kill_pots' RETURNING readiness;")
    run(name, sql, readiness)


def ins(variant='flh', bb='0.10', mode='full', bombs='false', club=CLUB, tournament='NULL', game_type="'cash'", threshold='10'):
    return ("INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, bomb_pot_enabled,"
            " tournament_id, game_type, kill_mode, kill_threshold_bb) VALUES"
            f" ('{club}', 'Probe', '{variant}', {bb} / 2, {bb}, {bombs}, {tournament}, {game_type}, '{mode}', {threshold})"
            " RETURNING kill_mode;")


try:
    require(re.search(r'PostgreSQL\) (16|17)\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 16 or 17 required')
    require(chr(8212) not in installer, 'The migration carries an em dash')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=" + PORT + "\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    run('fixture', FIXTURE)
    run('authority-and-contract-functions-from-their-migrations', authority_bodies())
    run('cluster-writers-newest-repository-bodies', cluster_bodies())
    run('cluster-writers-pinned-preimage',
        "SELECT md5(prosrc) FROM pg_proc WHERE oid IN ('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure,"
        " 'public.fn_cash_apply_ruleset(uuid)'::regprocedure) ORDER BY proname;",
        '955b66471351f80e5e7a7385aed5f527\nd0a29f6532f92bce3e22d92269c030ce')
    run('games', GAMES)

    # Before the migration: the hand writer ignores a key that is not a column,
    # so an engine that sends kill_pot to a database without it still commits.
    run('pre-install-unknown-hand-key-is-ignored',
        "CREATE TEMP TABLE written AS SELECT public.fn_ca_insert_hand_with_awards("
        "'{\"table_id\":\"00000000-0000-4000-8000-0000000000d1\",\"hand_number\":900001,\"small_blind\":0.05,"
        "\"big_blind\":0.10,\"kill_pot\":{\"rule_version\":\"kill-v1\"}}'::jsonb, '[]'::jsonb) AS id;"
        " SELECT count(*) FROM public.hand_history h JOIN written w USING (id);", '1')

    # The migration refuses without the registry, atomically.
    run('install-refused-without-capability-registry', installer, error='55000',
        message='KILL_POT_SETTINGS_NEED_THE_CAPABILITY_REGISTRY')
    run('refused-install-left-nothing',
        "SELECT count(*) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='kill_mode';", '0')

    if registry_path:
        run('capability-registry-real-migration', registry_path.read_text())
    else:
        run('capability-registry-stub', STUB_REGISTRY)
    run('capability-starts-planned', "SELECT public.fn_capability_available('cash.fixed_limit.kill_pots');", 'f')

    # Production declares tables.big_blind numeric(15,2); the first live install
    # (2026-09-24) was refused by a typmod-sensitive precondition. The
    # preconditions must accept the production declaration.
    pre_block = between(installer, 'DO $pre$', '$pre$;')
    run('preconditions-accept-production-numeric-precision',
        "BEGIN; ALTER TABLE public.tables ALTER COLUMN big_blind TYPE numeric(15,2);\n" + pre_block +
        "\nSELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass"
        " AND attname='big_blind'; ROLLBACK;", 'numeric(15,2)')

    # A drifted opener body is refused before anything is written.
    run('install-refused-on-changed-opener-preimage',
        "BEGIN; ALTER FUNCTION public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid) RENAME TO fn_tmp;"
        " CREATE FUNCTION public.fn_cash_cluster_open_table(p_game_id uuid, p_role text, p_main_index integer,"
        " p_lifecycle text DEFAULT 'opening', p_created_by uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql"
        " SECURITY DEFINER AS $$ BEGIN RETURN NULL; END $$;\n" + installer.replace('BEGIN;\nSET LOCAL lock_timeout', 'SET LOCAL lock_timeout', 1),
        error='55000', message='KILL_POT_SETTINGS_OPENER_PREIMAGE_CHANGED')

    before = run('hot-tables-before',
                 "SELECT pg_stat_force_next_flush(); SELECT string_agg(c.relname || ':' || c.relfilenode || ':' || s.seq_scan, ',' ORDER BY c.relname)"
                 " FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE c.relname IN ('tables','hand_history');")
    before = before.splitlines()[-1]
    run('install', installer + "\nSELECT pg_stat_force_next_flush();")
    after = run('hot-tables-after',
                "SELECT string_agg(c.relname || ':' || c.relfilenode || ':' || s.seq_scan, ',' ORDER BY c.relname)"
                " FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE c.relname IN ('tables','hand_history');")
    results['hotTables'] = {'before': before, 'after': after}
    require(before == after, f'The install rewrote or scanned a hot table: {before} -> {after}')
    results['cases'].append({'name': 'install-no-rewrite-no-scan', 'passed': True, 'expected': before})
    run('checks-are-not-valid-and-enforced-from-now',
        "SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) FROM pg_constraint"
        " WHERE conname IN ('tables_kill_mode_check','tables_kill_threshold_bb_check','hand_history_kill_pot_is_object');",
        'hand_history_kill_pot_is_object:false,tables_kill_mode_check:false,tables_kill_threshold_bb_check:false')
    run('defaults-on-existing-rows',
        "SELECT (SELECT count(*) FROM public.tables WHERE kill_mode = 'off' AND kill_threshold_bb = 10) = (SELECT count(*) FROM public.tables)"
        " AND (SELECT count(*) FROM public.hand_history WHERE kill_pot IS NOT NULL) = 0;", 't')
    probe('check-refuses-unknown-mode', "UPDATE public.tables SET kill_mode='double' WHERE name='Legacy 3';", error='23514')
    probe('check-refuses-unknown-threshold', "UPDATE public.tables SET kill_threshold_bb=9 WHERE name='Legacy 3';", error='23514')
    probe('check-refuses-non-object-kill-pot', "UPDATE public.hand_history SET kill_pot='[]' WHERE hand_number=1;", error='23514')

    # CAPABILITY PLANNED: nothing may turn kill on; off is never refused.
    probe('planned-refuses-full-on-flh-cash', ins(), error='22023', message='Kill Pots Are Not Available Yet')
    probe('planned-refuses-half-on-flo8-cash', ins('flo8', mode='half'), error='22023', message='Kill Pots Are Not Available Yet')
    probe('off-never-refused-while-planned',
          "UPDATE public.tables SET kill_mode='off', kill_threshold_bb=15, bomb_pot_enabled=true, game_variant='plo4', big_blind=0.05"
          " WHERE name LIKE 'Legacy %'; " + ins('nlh', '0.05', 'off', 'true', tournament=f"'{TOURN}'", game_type="'tournament'")
          + " SELECT count(*) = (SELECT count(*) FROM public.tables) FROM public.tables WHERE kill_mode='off';", 'off\nt')
    # An 'off' write never even reaches the guard: replace the rule with one
    # that raises, and write every guarded column of an off row.
    probe('off-row-does-not-reach-the-trigger',
          "CREATE OR REPLACE FUNCTION public.fn_tables_kill_pot_guard() RETURNS trigger LANGUAGE plpgsql AS"
          " $$ BEGIN RAISE EXCEPTION 'unexpected guard call'; END $$;"
          " UPDATE public.tables SET kill_threshold_bb=12, game_variant='flo8', game_type='cash', tournament_id=NULL,"
          " bomb_pot_enabled=true, big_blind=1, club_id=club_id WHERE name='Legacy 3' RETURNING kill_threshold_bb;", '12')

    set_readiness('capability-deployed', 'deployed')
    probe('deployed-allows-full-on-flh-cash', ins(), 'full')
    probe('deployed-allows-full-on-flo8-cash', ins('flo8'), 'full')
    probe('deployed-allows-half-on-even-cents', ins(bb='0.10', mode='half', threshold='15'), 'half')
    probe('deployed-allows-half-on-whole-chip-blind', ins(bb='1', mode='half', threshold='8'), 'half')
    probe('refuses-nlh', ins('nlh'), error='22023', message="Kill Pots Need Fixed Limit Hold'em Or Fixed Limit Omaha Hi-Lo")
    probe('refuses-plo', ins('plo4', mode='half'), error='22023', message='Kill Pots Need Fixed Limit')
    probe('refuses-tournament-by-id', ins(tournament=f"'{TOURN}'"), error='22023', message='Kill Pots Are Only Available At Cash Tables')
    probe('refuses-tournament-by-game-type', ins(game_type="'tournament'"), error='22023', message='Kill Pots Are Only Available At Cash Tables')
    probe('refuses-bombs-on', ins(bombs='true'), error='22023', message='Kill Pots Cannot Be Combined With Bomb Pots')
    probe('refuses-odd-cent-half', ins(bb='0.05', mode='half'), error='22023',
          message='Half Kill Needs A Big Blind That Is An Even Number Of Cents')
    probe('allows-odd-cent-full', ins(bb='0.05', mode='full'), 'full')
    probe('refuses-fractional-cent', ins(bb='0.005', mode='full'), error='22023', message='Kill Pots Need A Big Blind Of Whole Cents')
    probe('refuses-odd-unit-half-on-diamond-table', ins(bb='5', mode='half', club=DIAMOND), error='22023',
          message='Half Kill Needs An Even Number Of Diamonds As The Big Blind')
    probe('allows-even-unit-half-on-diamond-table', ins(bb='6', mode='half', club=DIAMOND), 'half')
    probe('allows-odd-unit-full-on-diamond-table', ins(bb='5', mode='full', club=DIAMOND), 'full')
    probe('refuses-fractional-diamond-blind', ins(bb='2.5', mode='full', club=DIAMOND), error='22023',
          message='Kill Pots Need A Big Blind Of Whole Diamonds')
    # A kill table then refuses whatever would make it unhonourable.
    probe('kill-table-refuses-turning-bombs-on',
          "UPDATE public.tables SET kill_mode='full' WHERE name='Legacy 3';"
          " UPDATE public.tables SET bomb_pot_enabled=true WHERE name='Legacy 3';",
          error='22023', message='Kill Pots Cannot Be Combined With Bomb Pots')
    probe('kill-table-refuses-variant-change',
          "UPDATE public.tables SET kill_mode='half' WHERE name='Legacy 3';"
          " UPDATE public.tables SET game_variant='nlh' WHERE name='Legacy 3';",
          error='22023', message='Kill Pots Need Fixed Limit')
    probe('kill-table-refuses-odd-blind-for-half',
          "UPDATE public.tables SET kill_mode='half' WHERE name='Legacy 3';"
          " UPDATE public.tables SET big_blind=0.25 WHERE name='Legacy 3';",
          error='22023', message='Half Kill Needs A Big Blind That Is An Even Number Of Cents')
    probe('service-role-writer-runs-the-guard-as-invoker',
          "SET LOCAL ROLE service_role; UPDATE public.tables SET kill_mode='full' WHERE name='Legacy 3' RETURNING kill_mode;", 'full')
    probe('authenticated-writer-refused-by-the-guard',
          "SET LOCAL ROLE authenticated; UPDATE public.tables SET kill_mode='full' WHERE name='Legacy 1';",
          error='22023', message="Kill Pots Need Fixed Limit Hold'em")

    # THE OWNER DOOR.
    door = f"SELECT (public.fn_set_cash_game_kill_settings('{G_FLH}', 'full', 12))->>'tables_changed';"
    probe('door-refuses-anonymous', door, error='28000', message='Sign In To Change Kill Pots')
    probe('door-refuses-a-player', as_user(PLAYER, door), error='42501',
          message='Only The Club Owner Or An Admin Can Change Kill Pots')
    probe('door-refuses-a-revoked-session', as_user(OWNER, "SET LOCAL fixture.session_live = 'false';" + door),
          error='28000')
    probe('door-anon-has-no-execute', "SET LOCAL ROLE anon; " + door, error='42501')
    probe('door-refuses-nlh-game', as_user(OWNER, f"SELECT public.fn_set_cash_game_kill_settings('{G_NLH}', 'full', 10);"),
          error='22023', message="Kill Pots Need Fixed Limit Hold'em")
    probe('door-refuses-bomb-template', as_user(ADMIN, f"SELECT public.fn_set_cash_game_kill_settings('{G_BOMB}', 'full', 10);"),
          error='22023', message='Kill Pots Cannot Be Combined With Bomb Pots')
    probe('door-refuses-odd-cent-half', as_user(OWNER, f"SELECT public.fn_set_cash_game_kill_settings('{G_ODD}', 'half', 10);"),
          error='22023', message='Half Kill Needs A Big Blind That Is An Even Number Of Cents')
    probe('door-refuses-bad-threshold', as_user(OWNER, f"SELECT public.fn_set_cash_game_kill_settings('{G_FLH}', 'full', 9);"),
          error='22023', message='Kill Threshold Must Be 8, 10, 12 Or 15 Big Blinds')
    probe('door-owner-sets-full-on-every-live-table',
          as_user(OWNER, door) + " RESET ROLE;"
          f" SELECT string_agg(kill_mode || ':' || kill_threshold_bb, ',' ORDER BY role, id) FROM public.tables"
          f" WHERE cluster_id = '{G_FLH}' AND lifecycle <> 'closed';"
          f" SELECT kill_mode FROM public.tables WHERE id = '{CLOSED_T}';"
          f" SELECT ruleset_snapshot->'kill' FROM public.cash_games WHERE id = '{G_FLH}';",
          '2\nfull:12,full:12\noff\n{"mode": "full", "threshold_bb": 12}')
    probe('door-admin-allowed-and-audited',
          as_user(ADMIN, f"SELECT (public.fn_set_cash_game_kill_settings('{G_FLH}', 'half', 10))->>'ok';") + " RESET ROLE;"
          f" SELECT count(*) || ':' || bool_and(changed_by = '{ADMIN}') || ':' || bool_and(before->>'kill_mode' = 'off' AND after->>'kill_mode' = 'half')"
          " FROM public.table_settings_changes;"
          f" SELECT kind || ':' || (payload->'after'->>'mode') || ':' || (payload->>'tables_changed')"
          f" FROM public.cash_cluster_events WHERE game_id = '{G_FLH}' AND kind = 'kill_settings_changed';",
          'true\n2:true:true\nkill_settings_changed:half:2')
    probe('door-replay-writes-no-second-audit',
          as_user(OWNER, door + door) + " RESET ROLE; SELECT count(*) FROM public.table_settings_changes;"
          " SELECT count(*) FROM public.cash_cluster_events WHERE kind = 'kill_settings_changed';",
          '2\n0\n2\n1')
    # The cluster keeps it: a new table, and a drifted table on the next apply.
    probe('cluster-new-table-carries-kill',
          as_user(OWNER, door) + " RESET ROLE;"
          f" CREATE TEMP TABLE opened AS SELECT public.fn_cash_cluster_open_table('{G_FLH}', 'main', 2, 'live', NULL) AS id;"
          " SELECT t.kill_mode || ':' || t.kill_threshold_bb FROM public.tables t JOIN opened o USING (id);",
          '2\nfull:12')
    probe('cluster-reapply-restores-drift',
          as_user(OWNER, door) + " RESET ROLE;"
          f" UPDATE public.tables SET kill_mode='off' WHERE cluster_id='{G_FLH}' AND role='feeder' AND lifecycle <> 'closed';"
          f" SELECT public.fn_cash_apply_ruleset('{G_FLH}');"
          f" SELECT string_agg(DISTINCT kill_mode, ',') FROM public.tables WHERE cluster_id='{G_FLH}' AND lifecycle <> 'closed';"
          f" SELECT public.fn_cash_apply_ruleset('{G_FLH}');",
          '2\n1\nfull\n0')
    probe('door-off-turns-every-table-off',
          as_user(OWNER, door + f" SELECT (public.fn_set_cash_game_kill_settings('{G_FLH}', 'off', 12))->>'tables_changed';")
          + f" RESET ROLE; SELECT string_agg(DISTINCT kill_mode, ',') FROM public.tables WHERE cluster_id='{G_FLH}';",
          '2\n2\noff')
    probe('odd-cent-game-allows-full-through-the-door',
          as_user(OWNER, f"SELECT (public.fn_set_cash_game_kill_settings('{G_ODD}', 'full', 8))->>'tables_changed';"), '1')

    # Readiness demoted: nobody can turn kill on, off still works, and the
    # cluster projection turns the whole game off together without failing.
    run('door-sets-full-before-demotion', "BEGIN; " + as_user(OWNER, door) + " COMMIT;", '2')
    set_readiness('capability-demoted', 'tested')
    probe('demoted-door-refuses-on', as_user(OWNER, door), error='22023', message='Kill Pots Are Not Available Yet')
    probe('demoted-door-accepts-off',
          as_user(OWNER, f"SELECT (public.fn_set_cash_game_kill_settings('{G_FLH}', 'off', 10))->>'ok';"), 'true')
    probe('demoted-unrelated-write-to-a-kill-table-is-not-refused',
          f"UPDATE public.tables SET big_blind = 0.10, game_variant = 'flh' WHERE cluster_id = '{G_FLH}' AND lifecycle <> 'closed'"
          " RETURNING kill_mode;", 'full\nfull')
    probe('demoted-direct-set-refused',
          "UPDATE public.tables SET kill_mode='half' WHERE name='Legacy 3';", error='22023', message='Kill Pots Are Not Available Yet')
    probe('demoted-projection-turns-the-game-off',
          f"SELECT public.fn_cash_apply_ruleset('{G_FLH}');"
          f" CREATE TEMP TABLE opened AS SELECT public.fn_cash_cluster_open_table('{G_FLH}', 'feeder', NULL, 'opening', NULL) AS id;"
          " SELECT t.kill_mode FROM public.tables t JOIN opened o USING (id);"
          f" SELECT string_agg(DISTINCT kill_mode, ',') FROM public.tables WHERE cluster_id='{G_FLH}';",
          '2\noff\noff')

    # The hand writer stores the record once the column exists.
    run('post-install-kill-pot-is-stored',
        "BEGIN; CREATE TEMP TABLE written AS SELECT public.fn_ca_insert_hand_with_awards("
        "'{\"table_id\":\"00000000-0000-4000-8000-0000000000d1\",\"hand_number\":900002,\"small_blind\":0.05,"
        "\"big_blind\":0.10,\"kill_pot\":{\"rule_version\":\"kill-v1\"}}'::jsonb, '[]'::jsonb) AS id;"
        " SELECT h.kill_pot->>'rule_version' FROM public.hand_history h JOIN written w USING (id); ROLLBACK;", 'kill-v1')
    run('grants-as-declared',
        "SELECT has_function_privilege('authenticated','public.fn_set_cash_game_kill_settings(uuid,text,integer)','EXECUTE')"
        " AND NOT has_function_privilege('anon','public.fn_set_cash_game_kill_settings(uuid,text,integer)','EXECUTE')"
        " AND NOT has_function_privilege('anon','public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid)','EXECUTE')"
        " AND (SELECT NOT prosecdef FROM pg_proc WHERE oid='public.fn_tables_kill_pot_guard()'::regprocedure)"
        " AND (SELECT prosecdef FROM pg_proc WHERE oid='public.fn_set_cash_game_kill_settings(uuid,text,integer)'::regprocedure);", 't')
    run('contract-document-keeps-kill-configuration',
        "SELECT public.fn_managed_game_contract_document('table', to_jsonb(t)) ?& ARRAY['kill_mode','kill_threshold_bb']"
        " FROM public.tables t WHERE name='Legacy 3';", 't')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
