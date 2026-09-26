#!/usr/bin/env python3
"""Multi-day stage foundation (R1, R3, R3b, R4 and the R5 database RPCs).

Real PostgreSQL, private socket, disposable cluster. The fixture creates only
the relations these migrations touch, with the columns and constraints the
migrations read. Every existing function the migrations depend on or patch is
loaded from its newest definition in supabase/migrations/, never re-typed:

  tournaments_status_check                     20260429i_x17 (the whole file)
  fn_tournaments_refuse_unbuilt_multi_day      20260902052302 (the whole file,
                                               including its own 7-column probe)
  fn_platform_frozen, fn_freeze_bypass_active  20260902090000
  fn_entry_purchases_frozen,
  fn_refuse_new_entries_while_frozen           20260908042800
  fn_thaw_reconnect_states, fn_thaw_platform   20260908032311
  fn_ca_lock_settlement_lane_for_tournament,
  fn_tournament_live_seat_acquisition_requires_authority
                                               20260910173147
  capability registry                          20260924025555 (the whole file;
                                               --capability-migration when it is
                                               not yet in this tree)

DEPENDENCY: this candidate merges only after the capability registry
(20260924025555_one_capability_registry_and_accepted_event_continuation.sql,
its own pull request) is on main. The registry migration is deliberately NOT
copied here. Until it lands, this harness refuses with exit 2 and a message
naming the missing migration, instead of failing mid-run.

Usage: PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-multi-day-stage-foundation.py
Must not run as root (initdb refuses). Prints one PASS line per case.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase' / 'migrations'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
CANDIDATES = [
    '20260924043217_multi_day_stage_foundation_tables.sql',
    '20260924043224_a_bagged_tournament_is_a_controlled_status.sql',
    '20260924043232_the_bagged_status_check_is_validated.sql',
    '20260924043239_multi_day_stage_transitions_are_lease_fenced.sql',
]
SOURCES = [
    ('20260902090000_the_platform_freezes_at_the_tables_not_the_functions.sql', 'fn_platform_frozen'),
    ('20260902090000_the_platform_freezes_at_the_tables_not_the_functions.sql', 'fn_freeze_bypass_active'),
    ('20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql', 'fn_entry_purchases_frozen'),
    ('20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql', 'fn_refuse_new_entries_while_frozen'),
    ('20260908032311_reconnect_allowance_survives_maintenance.sql', 'fn_thaw_reconnect_states'),
    ('20260908032311_reconnect_allowance_survives_maintenance.sql', 'fn_thaw_platform'),
    ('20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql', 'fn_ca_lock_settlement_lane_for_tournament'),
    ('20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql', 'fn_tournament_live_seat_acquisition_requires_authority'),
]

T1 = 'a1000000-0000-4000-8000-000000000001'   # the multi-day event
T2 = 'a1000000-0000-4000-8000-000000000002'   # an ordinary RUNNING event (thaw control)
T3 = 'a1000000-0000-4000-8000-000000000003'   # REGISTERING, never launched
T4 = 'a1000000-0000-4000-8000-000000000004'   # plan validation target
CLUB = 'c1000000-0000-4000-8000-000000000001'
LEASE = 'b1000000-0000-4000-8000-000000000001'
LEASE2 = 'b1000000-0000-4000-8000-000000000002'
TABLES = ['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002']
DAY2_TABLES = ['d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002']
USERS = ['e1000000-0000-4000-8000-00000000000%d' % i for i in range(1, 7)]
HORSE = USERS[5]
STACKS = [12000, 8000, 5000, 20000, 3000, 7000]


def function_source(file_name, name):
    source = (MIG / file_name).read_text()
    found = None
    for match in re.finditer(r'CREATE(?: OR REPLACE)? FUNCTION public\.' + name +
                             r'\(.*?\bAS (\$\w*\$).*?\1\s*;', source, re.S):
        found = match.group(0)
    if not found:
        raise RuntimeError('missing actual SQL component %s in %s' % (name, file_name))
    return found


class Cluster:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.sock = self.dir / 'socket'
        self.sock.mkdir()
        self.data = self.dir / 'data'
        self.env = {**os.environ, 'PGHOST': str(self.sock), 'PGPORT': '5432',
                    'PGDATABASE': 'postgres', 'PGUSER': 'postgres', 'PGCONNECT_TIMEOUT': '5'}
        self.started = False

    def start(self):
        subprocess.run([str(PG / 'initdb'), '-D', str(self.data), '-U', 'postgres', '-A', 'trust',
                        '--no-locale', '-E', 'UTF8'], check=True, capture_output=True, text=True)
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(self.data), '-l', str(self.dir / 'postgres.log'),
                        '-o', "-F -k %s -c listen_addresses='' -c max_locks_per_transaction=256" % self.sock,
                        '-w', 'start'], check=True, capture_output=True, text=True)
        self.started = True

    def stop(self):
        if self.started:
            subprocess.run([str(PG / 'pg_ctl'), '-D', str(self.data), '-m', 'immediate', '-w', 'stop'],
                           capture_output=True, text=True)

    def psql(self, text, error=None, timeout=60):
        result = subprocess.run([str(PG / 'psql'), '-XAtq', '-v', 'ON_ERROR_STOP=1'], input=text, text=True,
                                capture_output=True, env=self.env, timeout=timeout)
        if error is not None:
            if result.returncode == 0 or error not in result.stderr:
                raise AssertionError('expected error %r, got rc=%s stdout=%s stderr=%s'
                                     % (error, result.returncode, result.stdout, result.stderr))
            return result.stderr
        if result.returncode != 0:
            raise AssertionError('SQL failed: %s\n--- sql ---\n%s' % (result.stderr, text[:2000]))
        return result.stdout.strip()

    def val(self, text):
        out = self.psql(text)
        return out.splitlines()[-1] if out else ''

    def rpc(self, call):
        out = self.psql("SET ROLE service_role; SELECT (%s)::text;" % call)
        return json.loads(out.splitlines()[-1])


FIXTURE = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE TABLE public.ca_declared_money_triggers (
  table_name text NOT NULL, trigger_name text NOT NULL, note text,
  UNIQUE (table_name, trigger_name));
CREATE TABLE public.ca_mtt_admission_contract (singleton boolean PRIMARY KEY, abi text NOT NULL);
INSERT INTO public.ca_mtt_admission_contract VALUES (true, 'unlimited-mtt-v2');

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text, club_id uuid, union_id uuid,
  status text NOT NULL DEFAULT 'ANNOUNCED',
  tournament_type text, variant text,
  start_time timestamptz, started_at timestamptz, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  starting_chips integer DEFAULT 10000,
  current_level integer DEFAULT 0, level_started_at timestamptz, blind_level_state jsonb,
  on_break boolean DEFAULT false, break_started_at timestamptz, break_ends_at timestamptz,
  addon_period_ends_at timestamptz,
  late_reg_levels integer, rebuy_levels integer, addon_levels integer,
  is_multi_day boolean DEFAULT false, total_days integer DEFAULT 1, day_number integer DEFAULT 1,
  parent_tournament_id uuid, survivors_advance_to uuid, flight_number integer,
  flight_end_chips_snapshot jsonb);

CREATE TYPE public.tournament_player_status AS ENUM ('registered', 'playing', 'eliminated', 'winner');
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL, username text NOT NULL DEFAULT 'p',
  chips integer DEFAULT 0, status public.tournament_player_status DEFAULT 'registered',
  table_id uuid, seat_number integer, current_bounty numeric DEFAULT 0,
  rebuys integer DEFAULT 0, add_on boolean DEFAULT false, club_id uuid,
  rebuy_prompt_until timestamptz, registered_at timestamptz DEFAULT now(),
  UNIQUE (tournament_id, user_id));

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, club_id uuid, union_id uuid,
  status text DEFAULT 'waiting', max_players integer DEFAULT 9, current_players integer DEFAULT 0,
  is_deleted boolean DEFAULT false, bomb_pot_next_due_at timestamptz,
  break_eligible_since timestamptz, cluster_id uuid, updated_at timestamptz DEFAULT now());

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  seat_number integer NOT NULL CHECK (seat_number BETWEEN 1 AND 10),
  user_id uuid, player_id uuid, member_id uuid, stack numeric(15,2) DEFAULT 0, status text,
  joined_at timestamptz DEFAULT now(), left_at timestamptz,
  is_sitting_out boolean DEFAULT false, is_away boolean DEFAULT false, leave_pending boolean DEFAULT false,
  scheduled_leave_hands integer, horse_id uuid, auto_rebuy boolean DEFAULT false,
  time_bank_remaining integer, time_bank_uses_remaining integer, club_id uuid,
  sit_out_at timestamptz, entry_hold jsonb, entry_post_agreed boolean DEFAULT false,
  UNIQUE (table_id, seat_number));
CREATE UNIQUE INDEX idx_unique_active_user_per_table ON public.table_seats (table_id, user_id) WHERE left_at IS NULL;

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  instance_id text NOT NULL, engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2)));

CREATE TABLE public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  launch_id uuid NOT NULL UNIQUE, started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(), completed_at timestamptz,
  lease_generation uuid);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL, hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  hand_id uuid NOT NULL, payload_hash text NOT NULL, stack_result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number), UNIQUE (hand_number), UNIQUE (hand_id));
CREATE TABLE public.hand_state_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid NOT NULL, hand_number integer NOT NULL,
  is_complete boolean NOT NULL DEFAULT false, disconnect_states jsonb,
  updated_at timestamptz NOT NULL DEFAULT now());

-- The maintenance boundary and the thaw's other deadline tables.
CREATE TABLE public.engine_maintenance_break (
  enforce_freeze boolean, phase text, announced_at timestamptz, break_started_at timestamptz,
  break_ends_at timestamptz, reason text, ownership_token uuid DEFAULT gen_random_uuid());
CREATE TABLE public.engine_maintenance_thaws (
  freeze_started_at timestamptz PRIMARY KEY, frozen_seconds numeric, shifted jsonb,
  thawed_by text, thawed_at timestamptz);
CREATE TABLE public.table_waitlist (hold_expires_at timestamptz);
CREATE TABLE public.chip_transactions (reversible_until timestamptz);
CREATE TABLE public.tournament_bounty_awards (reveal_deadline_at timestamptz);
CREATE TABLE public.cash_player_session (stay_last_tick_at timestamptz, closed_at timestamptz, stay_running boolean);
CREATE TABLE public.cash_rejoin_constraints (expires_at timestamptz);
CREATE TABLE public.cash_seat_moves (state text, expires_at timestamptz);
CREATE TABLE public.engine_presence_parked (disconnect_states jsonb, parked_at timestamptz);
"""

TRIGGERS = r"""
-- The three production doors these migrations patch or rely on, attached as
-- production attaches them (20260903003000:113, 20260908042800:360/491,
-- 20260909014433:1366).
CREATE TRIGGER zz_freeze_launch_guard
  BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status = 'RUNNING' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
CREATE TRIGGER zz_freeze_entry_guard
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
CREATE TRIGGER zz_freeze_entry_guard
  BEFORE INSERT OR UPDATE OF left_at, user_id ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
CREATE TRIGGER a0_tournament_live_seat_root_guard
  BEFORE INSERT OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority();
"""


# Production's money-RPC registry DDL guard (event trigger ab_ca_money_rpc_registered, read live
# 2026-09-24): a new public function whose source writes a balance column must already be registered.
# The first production install of 20260924043239 was refused by it; the harness carries it so a
# missing registration fails here first.
MONEY_REGISTRY_GUARD = r"""
CREATE TABLE IF NOT EXISTS public.ca_money_rpc_registry (
  proname text PRIMARY KEY, status text NOT NULL, notes text, added_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_balance_columns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['agent_wallet_balance','backup_balance','backup_bbj_balance','balance','bbj_wallet','bounty_winnings',
    'chip_balance','chip_pool','chip_treasury','chips','credit_used','held_chips','insurance_balance','insurance_wallet',
    'locked_chips','main_balance','main_bbj_balance','prize','promo_balance','promo_fund_balance','promo_wallet',
    'promo_wallet_balance','rake_wallet','spin_reserve_wallet','stack']::text[] $f$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$f$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_registry_guard() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE obj record; v_name text; v_src text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF obj.object_type <> 'function' OR obj.schema_name IS DISTINCT FROM 'public' THEN CONTINUE; END IF;
    SELECT p.proname, p.prosrc INTO v_name, v_src FROM pg_proc p WHERE p.oid = obj.objid AND p.prokind = 'f';
    IF v_name IS NULL THEN CONTINUE; END IF;
    IF NOT public.fn_ca_money_rpc_writes_balances(v_src) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_name) THEN CONTINUE; END IF;
    RAISE EXCEPTION 'REFUSED: % writes balance columns and is not in ca_money_rpc_registry', v_name USING ERRCODE = '42501';
  END LOOP;
END;
$f$;
DROP EVENT TRIGGER IF EXISTS ab_ca_money_rpc_registered;
CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();
"""


def seed_event(c):
    """T1: a RUNNING MTT at the end of level 12, two tables, six players (one a
    horse), every stack equal to its last accepted hand. T2: an ordinary
    RUNNING event. T3: REGISTERING, never launched."""
    rows = []
    rows.append("""
INSERT INTO public.tournaments (id, name, club_id, status, tournament_type, variant, start_time,
  late_reg_levels, rebuy_levels, addon_levels)
VALUES ('%s', 'Two Day Main', '%s', 'REGISTERING', 'MTT', 'nlh', now() + interval '1 hour', 6, 0, 0),
       ('%s', 'Ordinary Event', '%s', 'REGISTERING', 'MTT', 'nlh', now() + interval '1 hour', 0, 0, 0),
       ('%s', 'Never Launched', '%s', 'REGISTERING', 'MTT', 'nlh', now() + interval '1 hour', 0, 0, 0),
       ('%s', 'Plan Validation', '%s', 'REGISTERING', 'MTT', 'nlh', now() + interval '1 hour', 4, 0, 0);
""" % (T1, CLUB, T2, CLUB, T3, CLUB, T4, CLUB))
    c.psql('\n'.join(rows))


def launch_and_play(c):
    """Stand-in for the existing launch (which these migrations do not touch):
    a completed launch receipt, RUNNING, seated players and accepted hands."""
    sql = ["BEGIN;",
           "SET LOCAL session_replication_role = replica;",  # the launch itself is out of scope
           "UPDATE public.tournaments SET status='RUNNING', started_at=now()-interval '3 hours', current_level=12,"
           " level_started_at=now()-interval '20 minutes', blind_level_state='{\"index\":12,\"small_blind\":300,\"big_blind\":600,\"ante\":600}'"
           " WHERE id IN ('%s','%s');" % (T1, T2),
           "INSERT INTO public.tournament_launch_receipts (tournament_id, launch_id, started_at, completed_at, lease_generation)"
           " VALUES ('%s', gen_random_uuid(), now()-interval '3 hours', now()-interval '3 hours', '%s'),"
           " ('%s', gen_random_uuid(), now()-interval '3 hours', now()-interval '3 hours', gen_random_uuid());" % (T1, LEASE, T2)]
    for i, tid in enumerate(TABLES):
        sql.append("INSERT INTO public.tables (id, tournament_id, club_id, status, current_players) VALUES ('%s','%s','%s','running',3);"
                   % (tid, T1, CLUB))
    for i, uid in enumerate(USERS):
        table = TABLES[i // 3]
        seat = (i % 3) + 1
        horse = "'%s'" % uid if uid == HORSE else 'NULL'
        sql.append("INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status, table_id, seat_number, current_bounty, club_id)"
                   " VALUES ('%s','%s','player%d',%d,'playing','%s',%d,%d,'%s');" % (T1, uid, i, STACKS[i], table, seat, 100 + i, CLUB))
        sql.append("INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, horse_id, club_id)"
                   " VALUES ('%s',%d,'%s',%d,'active',%s,'%s');" % (table, seat, uid, STACKS[i], horse, CLUB))
    # An eliminated player keeps a roster row and no seat.
    sql.append("INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status, current_bounty)"
               " VALUES ('%s','e1000000-0000-4000-8000-000000000099','busted',0,'eliminated',0);" % T1)
    # Accepted hands: the latest hand at each table wrote every stack there.
    for t_index, tid in enumerate(TABLES):
        for hand in range(2):
            number = 1000100 + t_index * 10 + hand
            written = {USERS[t_index * 3 + k]: STACKS[t_index * 3 + k] + (0 if hand == 1 else 500 * (k - 1))
                       for k in range(3)}
            sql.append("INSERT INTO public.hand_atomic_commits (table_id, hand_number, hand_id, payload_hash, stack_result)"
                       " VALUES ('%s', %d, gen_random_uuid(), repeat('a',64), '%s');"
                       % (tid, number, json.dumps({'success': True, 'written': written})))
        sql.append("INSERT INTO public.hand_state_snapshots (table_id, hand_number, is_complete) VALUES ('%s', 101, true);" % tid)
    sql.append("INSERT INTO public.engine_tournament_leases (tournament_id, instance_id, lease_generation, protocol_version, heartbeat_at)"
               " VALUES ('%s','engine-a','%s',2,clock_timestamp());" % (T1, LEASE))
    sql.append("COMMIT;")
    c.psql('\n'.join(sql))


def heartbeat(c, generation=LEASE):
    c.psql("UPDATE public.engine_tournament_leases SET heartbeat_at = clock_timestamp(), lease_generation='%s'"
           " WHERE tournament_id='%s';" % (generation, T1))


def watermarks(c):
    rows = c.psql("SELECT table_id, max(hand_number) FROM public.hand_atomic_commits WHERE table_id IN ('%s','%s') GROUP BY 1 ORDER BY 1;"
                  % tuple(TABLES)).splitlines()
    return json.dumps([{'table_id': r.split('|')[0], 'last_hand_number': int(r.split('|')[1])} for r in rows])


def set_capability(c, readiness, revision):
    evidence = "'{\"harness\":\"test-multi-day-stage-foundation\"}'::jsonb" if readiness in ('deployed', 'production_verified') else "'{}'::jsonb"
    c.psql("SET request.jwt.claims = '{\"role\":\"service_role\"}'; SELECT public.fn_set_capability_readiness("
           "'tournament.multi_day.single_flight', '%s', 'multi-day-v1', %d, %s);" % (readiness, revision, evidence))


PASSED = []


def case(name):
    def wrap(fn):
        fn.case_name = name
        return fn
    return wrap


def ok(name, detail=''):
    PASSED.append(name)
    print('PASS %-58s %s' % (name, detail))
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capability-migration', default=None,
                        help='path to 20260924025555_*.sql when it is not yet in supabase/migrations/')
    args = parser.parse_args()
    capability = Path(args.capability_migration) if args.capability_migration else next(iter(sorted(MIG.glob('20260924025555_*.sql'))), None)
    if capability is None or not capability.is_file():
        where = str(capability) if capability is not None else 'supabase/migrations/20260924025555_*.sql'
        print('FAIL multi-day stage foundation depends on the capability registry migration 20260924025555 '
              '(one_capability_registry_and_accepted_event_continuation), which merges before this change. '
              'Not found: %s. Merge the capability registry first, or pass --capability-migration PATH.' % where,
              file=sys.stderr)
        return 2
    if os.geteuid() == 0:
        print('FAIL run as a non-root user (initdb refuses root)', file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix='multi-day-stage-') as directory:
        os.chmod(directory, 0o700)
        c = Cluster(directory)
        try:
            c.start()
            run_all(c, capability)
        finally:
            c.stop()
    print('PASS multi-day stage foundation: %d cases on PostgreSQL %s' % (len(PASSED), PG))
    return 0


def run_all(c, capability):
    c.psql(FIXTURE)
    c.psql((MIG / '20260429i_x17_widen_tournaments_status_completing.sql').read_text())
    for file_name, name in SOURCES:
        c.psql(function_source(file_name, name))
    c.psql(TRIGGERS)
    c.psql(capability.read_text())
    seed_event(c)
    # The unbuilt guard, installed with its own seven-column probe on T3.
    c.psql((MIG / '20260902052302_a_half_guarded_feature_is_a_feature_that_can_be_half_built.sql').read_text())
    c.psql(MONEY_REGISTRY_GUARD)

    # ---- before: the platform has no BAGGED and no way back into RUNNING ----
    c.psql("UPDATE public.tournaments SET status='BAGGED' WHERE id='%s';" % T3, error='tournaments_status_check')
    ok('before_install_bagged_is_not_a_status')

    # ---- R0 preconditions refuse before anything changes -------------------
    for name in CANDIDATES[:1]:
        c.psql((MIG / name).read_text())
    c.psql("UPDATE public.ca_mtt_admission_contract SET abi='legacy-capacity-v1';")
    c.psql((MIG / CANDIDATES[1]).read_text(), error='MULTI_DAY_REQUIRES_MTT_ACTIVATION_FIRST')
    c.psql("UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';")
    original = function_source(SOURCES[3][0], 'fn_refuse_new_entries_while_frozen')
    c.psql(original.replace("RETURN NEW;\n    END IF;\n    RAISE EXCEPTION", "RETURN NEW;\n    END IF;\n\n    RAISE EXCEPTION", 1))
    c.psql((MIG / CANDIDATES[1]).read_text(), error='MULTI_DAY_PATCH_SOURCE_DRIFT')
    c.psql(original)
    assert c.val("SELECT count(*) FROM pg_trigger WHERE tgname='trg_tournaments_bagged_status_door'") == '0'
    ok('r0_preconditions_refuse_legacy_abi_and_source_drift', 'nothing installed on refusal')

    for name in CANDIDATES[1:]:
        c.psql((MIG / name).read_text())
    assert c.val("SELECT convalidated FROM pg_constraint WHERE conname='tournaments_status_check'") == 't'
    ok('migrations_install_in_order', ', '.join(n[:14] for n in CANDIDATES))
    assert c.val("SELECT string_agg(proname || '=' || status, ',' ORDER BY proname) FROM public.ca_money_rpc_registry"
                 " WHERE proname IN ('fn_bag_tournament_stage','fn_seat_stage_entitlement')") == \
        'fn_bag_tournament_stage=approved,fn_seat_stage_entitlement=approved'
    ok('money_moving_stage_rpcs_are_registered_before_they_exist', 'production DDL guard carried in the harness')

    # Declared live proofs are true on the installed schema.
    proofs = []
    for name in CANDIDATES:
        proofs += re.findall(r'^-- @live-proof: (.+?)\s*$', (MIG / name).read_text(), re.M)
    for proof in proofs:
        assert c.val('SELECT (%s)::text' % proof) == 'true', proof
    ok('every_live_proof_is_true', '%d proofs' % len(proofs))

    # ---- the unbuilt guard still refuses all seven columns -----------------
    for column, value in [('is_multi_day', 'true'), ('total_days', '3'), ('day_number', '2'),
                          ('parent_tournament_id', "'%s'" % T2), ('survivors_advance_to', "'%s'" % T2),
                          ('flight_number', '2'), ('flight_end_chips_snapshot', "'{}'::jsonb")]:
        c.psql("UPDATE public.tournaments SET %s = %s WHERE id = '%s';" % (column, value, T3), error='Multi day tournaments are not built yet')
    ok('unbuilt_guard_still_refuses_seven_columns')

    # ---- privileges ---------------------------------------------------------
    c.psql("SET ROLE authenticated; SELECT public.fn_seal_tournament_stage_plan('%s', '{}'::jsonb);" % T1, error='permission denied')
    c.psql("SET ROLE anon; SELECT public.fn_bag_tournament_stage('%s', '%s', 1, '[]');" % (T1, LEASE), error='permission denied')
    c.psql("SET ROLE service_role; INSERT INTO public.tournament_stage_plans (tournament_id, capability_id, rule_version, time_zone, stage_count, plan, plan_hash)"
           " VALUES ('%s','tournament.multi_day.single_flight','multi-day-v1','UTC',2,'{}',md5('x'));" % T1, error='permission denied')
    ok('rpcs_are_service_role_only_and_tables_are_not_writable')

    # ---- capability unavailable: every RPC refuses --------------------------
    plan = {'time_zone': 'America/Chicago',
            'stages': [{'stage_no': 1, 'end_after_level': 12},
                       {'stage_no': 2, 'scheduled_start_utc': '2099-01-01T17:00:00Z'}]}
    calls = [
        "public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (T1, json.dumps(plan)),
        "public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, LEASE),
        "public.fn_bag_tournament_stage('%s', '%s', 1, '[]'::jsonb)" % (T1, LEASE),
        "public.fn_reschedule_tournament_stage('%s', 2, now() + interval '1 day', 1, 'weather')" % T1,
        "public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 1, '%s', '{}'::jsonb)" % (T1, LEASE),
        "public.fn_seat_stage_entitlement('%s', gen_random_uuid(), '%s', gen_random_uuid(), '%s', 1)" % (T1, LEASE, DAY2_TABLES[0]),
        "public.fn_complete_stage_resume('%s', gen_random_uuid(), '%s')" % (T1, LEASE),
    ]
    for call in calls:
        assert c.rpc(call) == {'ok': False, 'reason': 'capability_unavailable'}, call
    assert c.val("SELECT count(*) FROM public.tournament_stage_plans") == '0'
    ok('capability_unavailable_every_rpc_refuses', '7 of 7 refused, nothing written')

    set_capability(c, 'deployed', 1)
    assert c.val("SELECT public.fn_capability_available('tournament.multi_day.single_flight')") == 't'

    # ---- seal: validation, then the real plan -------------------------------
    bad = [
        ({'time_zone': 'Mars/Olympus', 'stages': plan['stages']}, 'time_zone_unknown'),
        ({'time_zone': 'UTC', 'stages': plan['stages'][:1]}, 'stage_count_out_of_range'),
        ({'time_zone': 'UTC', 'stages': [{'stage_no': 1, 'end_after_level': 4}, plan['stages'][1]]}, 'entry_window_crosses_day_end'),
        ({'time_zone': 'UTC', 'stages': [{'stage_no': 1, 'end_after_level': 12}, {'stage_no': 2, 'scheduled_start_utc': '2001-01-01T00:00:00Z'}]}, 'stage_start_invalid'),
        ({'time_zone': 'UTC', 'stages': [{'stage_no': 1}, plan['stages'][1]]}, 'stage_end_level_invalid'),
        ({'time_zone': 'UTC', 'stages': plan['stages'], 'extra': 1}, 'plan_shape_invalid'),
    ]
    for body, reason in bad:
        got = c.rpc("public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (T4, json.dumps(body)))
        assert got.get('reason') == reason, (reason, got)
    sealed = c.rpc("public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (T1, json.dumps(plan)))
    assert sealed['ok'] and not sealed['replay'] and sealed['stage_count'] == 2, sealed
    again = c.rpc("public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (T1, json.dumps(plan)))
    assert again['ok'] and again['replay'], again
    other = dict(plan, time_zone='UTC')
    assert c.rpc("public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (T1, json.dumps(other)))['reason'] == 'plan_already_sealed'
    assert c.val("SELECT count(*) FROM public.tournaments WHERE id='%s' AND NOT is_multi_day AND total_days=1" % T1) == '1'
    ok('seal_validates_replays_and_never_writes_the_badge_columns', '6 invalid plans refused')

    # ---- writer rules --------------------------------------------------------
    c.psql("INSERT INTO public.tournament_stage_transitions (tournament_id, stage_no, kind, idempotency_key, facts)"
           " VALUES ('%s',1,'seal','x','{}');" % T1, error='MULTI_DAY_STAGE_WRITER_REQUIRED')
    c.psql("DELETE FROM public.tournament_stages WHERE tournament_id='%s';" % T1, error='MULTI_DAY_STAGE_RECORD_IS_PERMANENT')
    c.psql("TRUNCATE public.tournament_stage_transitions CASCADE;", error='MULTI_DAY_STAGE_RECORD_IS_PERMANENT')
    c.psql("BEGIN; SELECT set_config('app.multi_day_stage_writer','%s',true);"
           " UPDATE public.tournament_stages SET end_after_level = 20 WHERE tournament_id='%s' AND stage_no=1; COMMIT;" % (T1, T1),
           error='MULTI_DAY_STAGE_STRUCTURE_IS_SEALED')
    ok('stage_records_are_rpc_owned_permanent_and_sealed')

    launch_and_play(c)
    total = sum(STACKS)

    # ---- day-end intent -----------------------------------------------------
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, LEASE2))['reason'] == 'lease_lost'
    c.psql("UPDATE public.engine_tournament_leases SET heartbeat_at = clock_timestamp() - interval '1 minute' WHERE tournament_id='%s';" % T1)
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, LEASE))['reason'] == 'lease_lost'
    heartbeat(c)
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 11)" % (T1, LEASE))['reason'] == 'level_mismatch'
    assert c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, watermarks(c)))['reason'] == 'stage_not_day_ending'
    ended = c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, LEASE))
    assert ended['ok'] and not ended['replay'] and ended['stage_state'] == 'day_ending', ended
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, LEASE))['replay'] is True
    ok('day_end_intent_is_lease_fenced_level_exact_and_idempotent', 'stale generation and stale heartbeat refused')

    # ---- the bag refuses without a complete watermark -----------------------
    heartbeat(c)
    c.psql("INSERT INTO public.hand_state_snapshots (table_id, hand_number, is_complete) VALUES ('%s', 102, false);" % TABLES[0])
    assert c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, watermarks(c)))['reason'] == 'hand_in_flight'
    c.psql("UPDATE public.hand_state_snapshots SET is_complete = true WHERE hand_number = 102;")
    stale = watermarks(c)
    c.psql("INSERT INTO public.hand_atomic_commits (table_id, hand_number, hand_id, payload_hash, stack_result)"
           " VALUES ('%s', 1000102, gen_random_uuid(), repeat('b',64), '%s');"
           % (TABLES[0], json.dumps({'success': True, 'written': {USERS[k]: STACKS[k] for k in range(3)}})))
    got = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, stale))
    assert got['reason'] == 'watermark_mismatch', got
    one_table = json.dumps(json.loads(watermarks(c))[:1])
    assert c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, one_table))['reason'] == 'watermark_tables_mismatch'
    c.psql("UPDATE public.table_seats SET stack = stack + 1 WHERE user_id = '%s';" % USERS[0])
    got = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, watermarks(c)))
    assert got['reason'] == 'felt_differs_from_accepted_hand', got
    c.psql("UPDATE public.table_seats SET stack = stack - 1 WHERE user_id = '%s';" % USERS[0])
    assert c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE2, watermarks(c)))['reason'] == 'lease_lost'
    c.psql("INSERT INTO public.engine_maintenance_break (enforce_freeze, phase, announced_at, break_started_at, break_ends_at)"
           " VALUES (true, 'counting_down', now() - interval '3 minutes', now() - interval '1 minute', now() + interval '4 minutes');")
    assert c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, watermarks(c)))['reason'] == 'platform_frozen'
    c.psql("DELETE FROM public.engine_maintenance_break;")
    assert c.val("SELECT status FROM public.tournaments WHERE id='%s'" % T1) == 'RUNNING'
    assert c.val("SELECT count(*) FROM public.tournament_stage_bags") == '0'
    ok('bag_refuses_unaccepted_hands_stale_watermarks_felt_drift_stale_lease_freeze', 'nothing moved')

    # ---- direct status writes into BAGGED are refused -----------------------
    c.psql("UPDATE public.tournaments SET status='BAGGED' WHERE id='%s';" % T1, error='TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG')
    c.psql("BEGIN; SELECT set_config('app.atomic_stage_bag','%s:00000000-0000-0000-0000-000000000000',true);"
           " UPDATE public.tournaments SET status='BAGGED' WHERE id='%s'; COMMIT;" % (T1, T1), error='TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG')
    c.psql("INSERT INTO public.tournaments (name, status) VALUES ('born bagged', 'BAGGED');", error='TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG')
    c.psql("UPDATE public.tournaments SET status='BAGGED' WHERE id='%s';" % T3, error='TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG')
    c.psql("UPDATE public.tournaments SET status='NAPPING' WHERE id='%s';" % T3, error='tournaments_status_check')
    ok('status_check_accepts_bagged_only_through_the_bag')

    # ---- the bag ------------------------------------------------------------
    before_felt = c.val("SELECT sum(s.stack) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.left_at IS NULL" % T1)
    assert float(before_felt) == total, before_felt
    bag = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE, watermarks(c)))
    assert bag['ok'] and not bag['replay'] and bag['players'] == 6 and float(bag['total_chips']) == total, bag
    checks = {
        "SELECT status FROM public.tournaments WHERE id='%s'" % T1: 'BAGGED',
        "SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.left_at IS NULL" % T1: '0',
        "SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.stack <> 0" % T1: '0',
        "SELECT sum(stack)::bigint FROM public.tournament_stage_bags WHERE tournament_id='%s'" % T1: str(total),
        "SELECT count(*) FROM public.tournament_stage_bags WHERE tournament_id='%s'" % T1: '6',
        "SELECT sum(stack)::bigint FROM public.tournament_qualification_entitlements WHERE tournament_id='%s' AND state='active' AND target_stage_no=2" % T1: str(total),
        "SELECT sum(chips) FROM public.tournament_players WHERE tournament_id='%s' AND status='playing'" % T1: str(total),
        "SELECT count(*) FROM public.tournament_players WHERE tournament_id='%s' AND (table_id IS NOT NULL OR seat_number IS NOT NULL)" % T1: '0',
        "SELECT count(*) FROM public.tables WHERE tournament_id='%s' AND status <> 'closed'" % T1: '0',
        "SELECT sum(bounty_head)::int FROM public.tournament_stage_bags WHERE tournament_id='%s'" % T1: str(sum(100 + i for i in range(6))),
        "SELECT seat_horse_id::text FROM public.tournament_stage_bags WHERE user_id='%s'" % HORSE: HORSE,
        "SELECT count(*) FROM public.tournament_stage_bag_watermarks WHERE tournament_id='%s' AND last_hand_number IS NOT NULL" % T1: '2',
        "SELECT remaining_level_ms || ':' || level_index || ':' || next_level_index || ':' || next_stage_zone FROM public.tournament_stage_clock_snapshots WHERE tournament_id='%s'" % T1: '0:12:13:America/Chicago',
        "SELECT string_agg(stage_no || '=' || state, ',' ORDER BY stage_no) FROM public.tournament_stages WHERE tournament_id='%s'" % T1: '1=bagged,2=scheduled',
    }
    for query, expected in checks.items():
        assert c.val(query) == expected, (query, c.val(query), expected)
    ok('bag_moves_every_stack_seat_to_bag_exactly_once', '6 players, %s chips conserved, horse bagged like a human' % format(total, ','))

    replay = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, LEASE2, '[]'))
    assert replay['ok'] and replay['replay'] and replay['bag_id'] == bag['bag_id'], replay
    assert c.val("SELECT count(*) FROM public.tournament_stage_bags") == '6'
    assert c.val("SELECT count(*) FROM public.tournament_stage_transitions WHERE kind='bag'") == '1'
    ok('replayed_bag_returns_the_same_receipt', bag['bag_id'])

    # ---- chip custody fence --------------------------------------------------
    c.psql("UPDATE public.tournament_players SET chips = chips + 1 WHERE tournament_id='%s' AND user_id='%s';" % (T1, USERS[0]), error='TOURNAMENT_BAGGED_CUSTODY')
    c.psql("UPDATE public.tournament_players SET current_bounty = 0 WHERE tournament_id='%s' AND user_id='%s';" % (T1, USERS[0]), error='TOURNAMENT_BAGGED_CUSTODY')
    c.psql("UPDATE public.tournament_players SET status = 'eliminated' WHERE tournament_id='%s' AND user_id='%s';" % (T1, USERS[0]), error='TOURNAMENT_BAGGED_CUSTODY')
    c.psql("DELETE FROM public.tournament_players WHERE tournament_id='%s' AND user_id='%s';" % (T1, USERS[0]), error='TOURNAMENT_BAGGED_CUSTODY')
    c.psql("INSERT INTO public.tournament_players (tournament_id, user_id, chips, status) VALUES ('%s', gen_random_uuid(), 10000, 'registered');" % T1, error='TOURNAMENT_BAGGED_CUSTODY')
    c.psql("UPDATE public.tournament_players SET chips = chips WHERE tournament_id='%s';" % T1)  # a no-op sync passes
    c.psql("UPDATE public.tournament_players SET chips = chips + 1 WHERE tournament_id='%s' AND status='playing';" % T2)  # other events unaffected
    ok('chip_writes_refused_while_bagged', 'update, bounty, status, delete, insert refused; no-op passes')

    # ---- illegal transitions out of BAGGED ----------------------------------
    for target in ('RUNNING', 'COMPLETING', 'COMPLETED', 'CANCELLED', 'REGISTERING', 'ANNOUNCED'):
        c.psql("UPDATE public.tournaments SET status='%s' WHERE id='%s';" % (target, T1), error='TOURNAMENT_BAGGED_LEAVES_ONLY_BY_STAGE_RESUME')
    ok('every_illegal_transition_out_of_bagged_refused', '6 targets')

    # ---- the thaw leaves a BAGGED event untouched ---------------------------
    before = c.val("SELECT level_started_at::text FROM public.tournaments WHERE id='%s'" % T1)
    control = c.val("SELECT level_started_at::text FROM public.tournaments WHERE id='%s'" % T2)
    thaw = json.loads(c.val("SELECT public.fn_thaw_platform(now() - interval '5 minutes', 300, 'harness')::text"))
    assert thaw.get('ok') and thaw.get('complete'), thaw
    assert c.val("SELECT level_started_at::text FROM public.tournaments WHERE id='%s'" % T1) == before
    assert c.val("SELECT level_started_at - '%s'::timestamptz FROM public.tournaments WHERE id='%s'" % (control, T2)) == '00:05:00'
    ok('thaw_shifts_running_events_and_leaves_bagged_untouched', 'control shifted 00:05:00, bagged unchanged')

    # ---- reschedule invalidates the old deadline ----------------------------
    first = c.val("SELECT scheduled_start_utc FROM public.tournament_stages WHERE tournament_id='%s' AND stage_no=2" % T1)
    assert c.rpc("public.fn_reschedule_tournament_stage('%s', 2, now() - interval '1 minute', 1, 'late')" % T1)['reason'] == 'start_not_in_future'
    moved = c.rpc("public.fn_reschedule_tournament_stage('%s', 2, '2098-06-01T17:00:00Z', 1, 'venue change')" % T1)
    assert moved['ok'] and moved['schedule_generation'] == 2, moved
    assert c.rpc("public.fn_reschedule_tournament_stage('%s', 2, '2098-06-01T17:00:00Z', 1, 'venue change')" % T1)['replay'] is True
    assert c.rpc("public.fn_reschedule_tournament_stage('%s', 2, '2098-07-01T17:00:00Z', 1, 'again')" % T1)['reason'] == 'schedule_generation_stale'
    heartbeat(c)
    level = json.dumps({'index': 13, 'small_blind': 400, 'big_blind': 800, 'ante': 800, 'duration_ms': 1200000})
    got = c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 1, '%s', '%s'::jsonb)" % (T1, LEASE, level))
    assert got['reason'] == 'schedule_generation_stale' and got['schedule_generation'] == 2, got
    got = c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 2, '%s', '%s'::jsonb)" % (T1, LEASE, level))
    assert got['reason'] == 'not_due', got
    # Due now (generation 3): the wake armed for the old start is stale.
    moved = c.rpc("public.fn_reschedule_tournament_stage('%s', 2, clock_timestamp() + interval '2 seconds', 2, 'start now')" % T1)
    assert moved['ok'] and moved['schedule_generation'] == 3, moved
    time.sleep(2.5)
    assert c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 2, '%s', '%s'::jsonb)" % (T1, LEASE, level))['reason'] == 'schedule_generation_stale'
    assert c.val("SELECT count(*) FROM public.tournament_stage_transitions WHERE kind='reschedule'") == '2'
    ok('reschedule_invalidates_the_old_deadline', 'first %s, generations 1 -> 3, stale wakes refused' % first)

    # ---- resume input checks -------------------------------------------------
    heartbeat(c)
    bad_level = json.dumps({'index': 14, 'small_blind': 400, 'big_blind': 800, 'ante': 800, 'duration_ms': 1200000})
    assert c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 3, '%s', '%s'::jsonb)" % (T1, LEASE, bad_level))['reason'] == 'first_level_invalid'
    assert c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 3, '%s', '%s'::jsonb)" % (T1, LEASE2, level))['reason'] == 'lease_lost'
    ok('resume_begin_checks_the_first_level_and_the_lease')

    # ---- a seat cannot be acquired while bagged without the resume ----------
    for tid in DAY2_TABLES:
        c.psql("INSERT INTO public.tables (id, tournament_id, club_id, status) VALUES ('%s','%s','%s','waiting');" % (tid, T1, CLUB))
    c.psql("BEGIN; SELECT public.fn_ca_lock_settlement_lane_for_tournament('%s', NULL);"
           " INSERT INTO public.table_seats (table_id, seat_number, user_id, stack) VALUES ('%s', 9, '%s', 100); COMMIT;"
           % (T1, DAY2_TABLES[0], USERS[0]), error='TOURNAMENT_SEAT_ACQUISITION_CLOSED')
    ok('seat_acquisition_closed_while_bagged_without_resume')

    # ---- two concurrent resume callers ---------------------------------------
    heartbeat(c)
    entitlements = c.psql("SELECT id FROM public.tournament_qualification_entitlements WHERE tournament_id='%s' ORDER BY id;" % T1).splitlines()
    assert len(entitlements) == 6
    scripts = []
    for caller in ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002'):
        lines = ["SET ROLE service_role;",
                 "SELECT (public.fn_begin_stage_resume('%s', 2, '%s', 3, '%s', '%s'::jsonb)) ->> 'resume_id' AS rid \\gset" % (T1, caller, LEASE, level)]
        for n, ent in enumerate(entitlements):
            table = DAY2_TABLES[n % 2]
            seat = n // 2 + 1
            lines.append("SELECT (public.fn_seat_stage_entitlement('%s', :'rid', '%s', '%s', '%s', %d))::text;" % (T1, LEASE, ent, table, seat))
        lines.append("SELECT (public.fn_complete_stage_resume('%s', :'rid', '%s'))::text;" % (T1, LEASE))
        scripts.append('\n'.join(lines) + '\n')
    procs = [subprocess.Popen([str(PG / 'psql'), '-XAtq', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=c.env) for _ in scripts]
    for proc, script in zip(procs, scripts):
        proc.stdin.write(script)
        proc.stdin.flush()
    outputs = []
    for proc in procs:
        proc.stdin.close()
        outputs.append((proc.wait(timeout=60), proc.stdout.read(), proc.stderr.read()))
    seated_fresh = seated_replayed = completed_fresh = completed_replayed = 0
    for code, out, err in outputs:
        assert code == 0 and not err.strip(), (code, out, err)
        results = [json.loads(line) for line in out.splitlines() if line.startswith('{')]
        assert len(results) == 7 and all(r.get('ok') is True for r in results), results
        for r in results[:6]:
            seated_replayed += 1 if r['replay'] else 0
            seated_fresh += 0 if r['replay'] else 1
        completed_replayed += 1 if results[6]['replay'] else 0
        completed_fresh += 0 if results[6]['replay'] else 1
    # Each chair was taken once and answered once more from its receipt.
    assert (seated_fresh, seated_replayed, completed_fresh, completed_replayed) == (6, 6, 1, 1), \
        (seated_fresh, seated_replayed, completed_fresh, completed_replayed)
    after = {
        "SELECT status FROM public.tournaments WHERE id='%s'" % T1: 'RUNNING',
        "SELECT count(*) FROM public.tournament_stage_resume_receipts WHERE tournament_id='%s' AND completed_at IS NOT NULL" % T1: '1',
        "SELECT count(*) FROM public.tournament_stage_transitions WHERE tournament_id='%s' AND kind='resume_complete'" % T1: '1',
        "SELECT count(*) FROM public.tournament_qualification_entitlements WHERE tournament_id='%s' AND state='consumed'" % T1: '6',
        "SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.left_at IS NULL" % T1: '6',
        "SELECT sum(s.stack)::bigint FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.left_at IS NULL" % T1: str(total),
        "SELECT count(*) FROM public.table_seats s JOIN public.tournament_stage_bags b ON b.user_id=s.user_id JOIN public.tables t ON t.id=s.table_id"
        " WHERE t.tournament_id='%s' AND s.left_at IS NULL AND s.stack=b.stack AND s.club_id IS NOT DISTINCT FROM b.seat_club_id AND s.horse_id IS NOT DISTINCT FROM b.seat_horse_id" % T1: '6',
        "SELECT sum(chips) FROM public.tournament_players WHERE tournament_id='%s' AND status='playing'" % T1: str(total),
        "SELECT current_level || ':' || (blind_level_state->>'big_blind') FROM public.tournaments WHERE id='%s'" % T1: '13:800',
        "SELECT level_started_at > now() - interval '1 minute' FROM public.tournaments WHERE id='%s'" % T1: 't',
        "SELECT string_agg(stage_no || '=' || state, ',' ORDER BY stage_no) FROM public.tournament_stages WHERE tournament_id='%s'" % T1: '1=closed,2=running',
        "SELECT sum(current_players) FROM public.tables WHERE id IN ('%s','%s')" % tuple(DAY2_TABLES): '6',
    }
    for query, expected in after.items():
        assert c.val(query) == expected, (query, c.val(query), expected)
    ok('resume_seats_every_stack_exactly_once_under_two_concurrent_callers', 'one receipt, 6 seats, %s chips' % format(total, ','))

    # ---- RUNNING re-entry only through the resume receipt --------------------
    c.psql("UPDATE public.tournaments SET status='RUNNING' WHERE id='%s';" % T3, error='TOURNAMENT_LAUNCH_RECEIPT_REQUIRED')
    rid = c.val("SELECT resume_id FROM public.tournament_stage_resume_receipts WHERE tournament_id='%s'" % T1)
    c.psql("BEGIN; ALTER TABLE public.tournaments DISABLE TRIGGER trg_tournaments_bagged_status_door;"
           " SELECT set_config('app.atomic_stage_resume', '%s:%s', true);"
           " UPDATE public.tournaments SET status='RUNNING' WHERE id='%s'; ROLLBACK;" % (T3, rid, T3),
           error='TOURNAMENT_LAUNCH_RECEIPT_REQUIRED')
    # The patched launch guard itself: BAGGED -> RUNNING with a COMPLETED receipt is refused.
    c.psql("BEGIN; ALTER TABLE public.tournaments DISABLE TRIGGER trg_tournaments_bagged_status_door;"
           " UPDATE public.tournaments SET status='BAGGED' WHERE id='%s';"
           " SELECT set_config('app.atomic_stage_resume', '%s:%s', true);"
           " UPDATE public.tournaments SET status='RUNNING' WHERE id='%s'; ROLLBACK;" % (T1, T1, rid, T1),
           error='TOURNAMENT_LAUNCH_RECEIPT_REQUIRED')
    replay = c.rpc("public.fn_complete_stage_resume('%s', '%s', '%s')" % (T1, rid, LEASE2))
    assert replay['ok'] and replay['replay'], replay
    assert c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 3, '%s', '%s'::jsonb)" % (T1, LEASE, level))['completed'] is True
    c.psql("UPDATE public.tournaments SET status='BAGGED' WHERE id='%s';" % T1, error='TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG')
    ok('running_reentry_only_through_the_resume_receipt', 'second launch and completed-receipt reuse refused')

    # ---- entitlements are consumed once, forever -----------------------------
    c.psql("BEGIN; SELECT set_config('app.multi_day_stage_writer','%s',true);"
           " UPDATE public.tournament_qualification_entitlements SET state='active', consumed_by_resume_id=NULL,"
           " consumed_seat_id=NULL, consumed_table_id=NULL, consumed_seat_number=NULL, consumed_at=NULL"
           " WHERE tournament_id='%s'; COMMIT;" % (T1, T1), error='MULTI_DAY_ENTITLEMENT_IS_CONSUMED_ONCE')
    ok('an_entitlement_is_consumed_exactly_once')

    # ---- capability withdrawn: every RPC refuses again -----------------------
    set_capability(c, 'tested', 2)
    for call in calls:
        assert c.rpc(call) == {'ok': False, 'reason': 'capability_unavailable'}, call
    ok('capability_withdrawn_every_rpc_refuses_again')

    # ---- the unbuilt guard is still the gate after everything ---------------
    c.psql("UPDATE public.tournaments SET is_multi_day = true WHERE id = '%s';" % T1, error='Multi day tournaments are not built yet')
    c.psql("UPDATE public.tournaments SET day_number = 2 WHERE id = '%s';" % T1, error='Multi day tournaments are not built yet')
    ok('unbuilt_guard_still_refuses_after_a_full_two_day_run')


if __name__ == '__main__':
    sys.exit(main())
