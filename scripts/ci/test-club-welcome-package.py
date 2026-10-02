#!/usr/bin/env python3
"""Install and exercise the welcome-package migration in isolated PostgreSQL."""
import argparse, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261001154709_prospective_lifetime_first_club_welcome_package.sql'
CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261001212300_welcome_certification_cleanup_runs_after_core.sql'
HOT_TRIGGER_MIGRATION = ROOT / 'supabase/migrations/20261001224720_welcome_schedule_spawn_trigger_runs_after_core.sql'
CLUB_HISTORY_MIGRATION = ROOT / 'supabase/migrations/20261001232445_welcome_club_owner_history_runs_after_core.sql'
REQUEST_ACTIVATION_MIGRATION = ROOT / 'supabase/migrations/20261001232452_welcome_request_activation_runs_last.sql'
LEDGER_COUNTERPARTY_REPAIR_MIGRATION = ROOT / 'supabase/migrations/20261002002030_welcome_allocations_use_the_declared_opening_clearing_store.sql'
LEDGER_CATEGORY_REPAIR_MIGRATION = ROOT / 'supabase/migrations/20261002010726_welcome_allocations_use_the_declared_opening_category.sql'
DERIVED_TABLE_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002021610_welcome_certification_retires_package_derived_cash_tables.sql'
AUTHORITATIVE_LEASE_REPAIR_MIGRATION = ROOT / 'supabase/migrations/20261002030900_welcome_certification_reads_the_authoritative_engine_lease.sql'
CONTROLLER_PROVENANCE_REPAIR_MIGRATION = ROOT / 'supabase/migrations/20261002051400_welcome_certification_accepts_its_controller_created_tables.sql'
SCHEDULE_SPAWN_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002065156_welcome_certification_retires_idle_schedule_spawns.sql'
UNMATERIALIZED_SPAWN_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002073521_welcome_certification_retires_unmaterialized_schedule_claims.sql'
BOARD_GAME_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002085447_welcome_certification_retires_idle_orphan_tournaments.sql'
BOARD_LEASE_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002102542_welcome_certification_retires_stale_board_tournament_leases.sql'
BOARD_ORIGIN_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002111120_welcome_certification_accepts_exact_prelaunch_origins.sql'
BOARD_DELETE_PERMIT_MIGRATION = ROOT / 'supabase/migrations/20261002115605_welcome_certification_deletes_only_its_unused_board_tables.sql'
FRESH_BOARD_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002205511_welcome_certification_accepts_fresh_exact_board.sql'
POST_RESET_CLEANUP_MIGRATION = ROOT / 'supabase/migrations/20261002210559_post_reset_welcome_certification_cleanup.sql'
POST_RESET_UUID_ORDER_MIGRATION = ROOT / 'supabase/migrations/20261002223819_post_reset_cleanup_orders_uuid_values.sql'
POST_RESET_ATOMIC_BOARD_MIGRATION = ROOT / 'supabase/migrations/20261002231724_post_reset_cleanup_accepts_atomic_board_absence.sql'
TERMINAL_TABLE_GUARD_MIGRATION = ROOT / 'supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
_terminal_guard_source = TERMINAL_TABLE_GUARD_MIGRATION.read_text()
TERMINAL_TABLE_GUARD_FIXTURE = _terminal_guard_source[
    _terminal_guard_source.index('CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()'):
    _terminal_guard_source.index('-- Hand stack settlement', _terminal_guard_source.index('CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()'))
]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/club-welcome-package-postgres')
args = parser.parse_args()
out = args.output.resolve(); out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
local_scratch = Path('/Volumes/SmarterWork/agent-work')
cluster = Path(tempfile.mkdtemp(prefix='wpg-', dir=local_scratch if local_scratch.is_dir() else None))
socket = cluster / 'socket'; socket.mkdir(mode=0o700)
port = '55479'
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}; env['LC_ALL']='C'
psql = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-p',port,'-U','postgres','-d','postgres']
results = {'migrations': [MIGRATION.name, CLEANUP_MIGRATION.name, HOT_TRIGGER_MIGRATION.name, CLUB_HISTORY_MIGRATION.name, REQUEST_ACTIVATION_MIGRATION.name, LEDGER_COUNTERPARTY_REPAIR_MIGRATION.name, LEDGER_CATEGORY_REPAIR_MIGRATION.name, DERIVED_TABLE_CLEANUP_MIGRATION.name, AUTHORITATIVE_LEASE_REPAIR_MIGRATION.name, CONTROLLER_PROVENANCE_REPAIR_MIGRATION.name, SCHEDULE_SPAWN_CLEANUP_MIGRATION.name, UNMATERIALIZED_SPAWN_CLEANUP_MIGRATION.name, BOARD_GAME_CLEANUP_MIGRATION.name, BOARD_LEASE_CLEANUP_MIGRATION.name, BOARD_ORIGIN_CLEANUP_MIGRATION.name, BOARD_DELETE_PERMIT_MIGRATION.name, FRESH_BOARD_CLEANUP_MIGRATION.name, POST_RESET_CLEANUP_MIGRATION.name, POST_RESET_UUID_ORDER_MIGRATION.name, POST_RESET_ATOMIC_BOARD_MIGRATION.name], 'cases': [], 'passed': False}

def command(argv, sql=None):
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=120)
def run(name, sql, expected=None):
    r=command(psql,sql); got=r.stdout.rstrip('\n'); ok=r.returncode==0 and (expected is None or got==expected)
    (out/f'{name}.log').write_text('-- SQL\n'+sql+'\n-- OUT\n'+r.stdout+'\n-- ERR\n'+r.stderr)
    results['cases'].append({'name':name,'passed':ok,'expected':expected,'observed':got})
    if not ok: raise RuntimeError(name+': '+r.stderr[-2000:]+r.stdout[-1000:])
    return got
def run_refusal(name, sql, expected_error):
    r=command(psql,sql); got=r.stdout.rstrip('\n'); ok=r.returncode!=0 and expected_error in r.stderr
    (out/f'{name}.log').write_text('-- SQL\n'+sql+'\n-- OUT\n'+r.stdout+'\n-- ERR\n'+r.stderr)
    results['cases'].append({'name':name,'passed':ok,'expected':expected_error,'observed':r.stderr.rstrip('\n')[-2000:]})
    if not ok: raise RuntimeError(name+': '+r.stderr[-2000:]+r.stdout[-1000:])

SETUP = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA smarter_private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL);
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
CREATE TABLE ca_declared_money_triggers(
 table_name text NOT NULL,trigger_name text NOT NULL,note text NOT NULL,
 PRIMARY KEY(table_name,trigger_name));
CREATE TABLE ca_money_rpc_registry(
 proname text PRIMARY KEY,status text NOT NULL,notes text NOT NULL);
CREATE TABLE ca_chip_store_coverage(
 store text PRIMARY KEY,treatment text NOT NULL,counted_by text,notes text,added_at timestamptz DEFAULT now());
INSERT INTO ca_chip_store_coverage(store,treatment,counted_by,notes)
VALUES('opening_setup','counted','leaderboard_liability','fixture mirrors production clearing coverage');
CREATE TABLE chip_ledger(
 performed_by uuid,from_type text,from_entity_id uuid,from_label text,
 to_type text,to_entity_id uuid,to_label text,amount numeric NOT NULL DEFAULT 0,
 category text NOT NULL,club_id uuid,union_id uuid,description text,idempotency_key text,
 pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,
 metadata jsonb NOT NULL DEFAULT '{}',
 CONSTRAINT chip_ledger_category_check CHECK(category IN ('club_opening_allocation','reversal'))
);
CREATE FUNCTION fn_fixture_money_registry_guard() RETURNS event_trigger LANGUAGE plpgsql AS $guard$
DECLARE command record;
BEGIN
  FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF command.object_identity LIKE 'public.fn_apply_club_welcome_economics(%'
       AND NOT EXISTS(
         SELECT 1 FROM ca_money_rpc_registry
          WHERE proname='fn_apply_club_welcome_economics' AND status='approved'
       ) THEN
      RAISE EXCEPTION 'fixture refused unregistered welcome money writer';
    ELSIF command.object_identity LIKE 'public.fn_ca_prepare_unused_welcome_certification_board_games(%'
       AND NOT EXISTS(
         SELECT 1 FROM ca_money_rpc_registry
          WHERE proname='fn_ca_prepare_unused_welcome_certification_board_games' AND status='system'
       ) THEN
      RAISE EXCEPTION 'fixture refused undeclared audited certification cleanup';
    END IF;
  END LOOP;
END $guard$;
CREATE EVENT TRIGGER fixture_money_registry_guard ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION fn_fixture_money_registry_guard();
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,name text,is_union boolean DEFAULT false,union_id uuid,
 chip_treasury numeric DEFAULT 100000,chip_pool numeric DEFAULT 0,promo_balance numeric DEFAULT 0,
 insurance_balance numeric DEFAULT 0,bbj_enabled boolean DEFAULT false,bbj_rake_enabled boolean DEFAULT false,
 spins_enabled boolean DEFAULT false,spins_preseed_amount numeric DEFAULT 0,spins_wallet_funding text,
 created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE club_creation_requests(user_id uuid NOT NULL,request_id uuid NOT NULL,club_id uuid NOT NULL REFERENCES clubs(id),PRIMARY KEY(user_id,request_id));
CREATE TABLE union_clubs(club_id uuid,union_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,chip_balance numeric DEFAULT 0,promo_balance numeric DEFAULT 0);
CREATE TABLE agents(club_id uuid,user_id uuid);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,union_id uuid,main_balance numeric,backup_balance numeric,
 promo_balance numeric,pool_amount numeric,hands_contributed integer DEFAULT 0,total_contributed numeric DEFAULT 0,
 total_paid_out numeric DEFAULT 0,hit_count integer DEFAULT 0,status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE bbj_contributions(pool_id uuid);
CREATE TABLE bbj_payouts(pool_id uuid);
CREATE TABLE spin_bonus_pools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid UNIQUE,balance numeric DEFAULT 0,seeded_amount numeric DEFAULT 0,
 seed_source_wallet text,owner_kind text,offered_max_stake numeric DEFAULT 0,highest_stake numeric DEFAULT 0,
 total_deposited numeric DEFAULT 0,total_drawn numeric DEFAULT 0,spin_count integer DEFAULT 0,bonus_count integer DEFAULT 0,
 surplus_returned numeric DEFAULT 0,seed_returned_amount numeric DEFAULT 0,is_active boolean DEFAULT true,activated_at timestamptz,
 deactivated_at timestamptz,
 updated_at timestamptz DEFAULT now());
CREATE TABLE spin_reserve_ledger(club_id uuid,kind text,amount numeric,balance_after numeric,note text,tournament_id uuid);
CREATE TABLE chip_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,amount numeric,
 transaction_type text,notes text,balance_after numeric,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
CREATE TABLE wheel_configs(host_id uuid PRIMARY KEY,host_kind text,enabled boolean);
CREATE TABLE wheel_pools(host_id uuid PRIMARY KEY,spins bigint DEFAULT 0,intake_diamonds numeric DEFAULT 0,
 chips_minted numeric DEFAULT 0,chips_paid numeric DEFAULT 0,diamonds_paid numeric DEFAULT 0);
CREATE TABLE diamond_game_configs(host_id uuid,game text,host_kind text,enabled boolean,PRIMARY KEY(host_id,game));
CREATE TABLE diamond_game_pools(host_id uuid,game text,rounds bigint DEFAULT 0,intake_diamonds numeric DEFAULT 0,
 chips_minted numeric DEFAULT 0,chips_paid numeric DEFAULT 0,reserved_chips numeric DEFAULT 0,PRIMARY KEY(host_id,game));
CREATE TABLE wheel_spins(host_id uuid);
CREATE TABLE plinko_drops(host_id uuid);
CREATE TABLE crash_rounds(host_id uuid);
CREATE TABLE diamond_choice_rounds(host_id uuid);
CREATE TABLE leaderboard_reward_program_versions(club_id uuid,version integer);
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,enabled boolean DEFAULT true,state text DEFAULT 'live',closed_at timestamptz,closed_by uuid,updated_at timestamptz DEFAULT now());
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,schedule_id uuid,name text,
 game_type text,variant text,tournament_type text,buy_in_amount numeric,buy_in_fee numeric,
 max_players integer,min_players integer,table_size integer,starting_chips integer,current_players integer DEFAULT 0,
 status text,started_at timestamptz,ended_at timestamptz,created_at timestamptz DEFAULT now(),
 updated_at timestamptz DEFAULT now(),restart_source_id uuid,satellite_target_id uuid,satellite_target text);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,cluster_id uuid,tournament_id uuid,
 name text,game_type text DEFAULT 'cash',created_by uuid,role text DEFAULT 'main',main_index integer DEFAULT 1,
 lifecycle text DEFAULT 'opening',status text,current_players integer,
 max_players integer,is_deleted boolean DEFAULT false,created_at timestamptz DEFAULT now(),
 engine_lease_owner text,engine_lease_expires_at timestamptz,updated_at timestamptz DEFAULT now(),
 terminal_closed_at timestamptz);
CREATE TABLE tournament_table_origins(
 table_id uuid PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
 tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
 origin_kind text NOT NULL,launch_id uuid,launch_lease_generation uuid,
 recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tournament_schedules(id uuid PRIMARY KEY,club_id uuid,active boolean,updated_at timestamptz DEFAULT now());
CREATE TABLE tournament_schedule_spawns(id bigserial PRIMARY KEY,schedule_id uuid,tournament_id uuid,spawn_key text,created_at timestamptz DEFAULT now());
CREATE TABLE table_seats(table_id uuid,left_at timestamptz);
CREATE TABLE table_sessions(table_id uuid,is_active boolean,left_at timestamptz);
CREATE TABLE table_waitlist(table_id uuid,status text);
CREATE TABLE cash_game_waitlist(game_id uuid,status text);
CREATE TABLE cash_seat_moves(game_id uuid,state text);
CREATE TABLE cash_seat_change_requests(game_id uuid,status text);
CREATE TABLE cash_game_roster(game_id uuid,user_id uuid,left_at timestamptz);
CREATE TABLE table_pending_addons(table_id uuid,resolved_at timestamptz);
CREATE TABLE cash_cluster_events(id bigserial PRIMARY KEY,game_id uuid,table_id uuid,kind text DEFAULT 'fixture',payload jsonb DEFAULT '{}',at timestamptz DEFAULT now());
CREATE TABLE engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,engine_version text,
 acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);
CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
 instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,
 lease_generation uuid,protocol_version integer);
CREATE TABLE tournament_players(tournament_id uuid);
CREATE TABLE tournament_rebuys(tournament_id uuid REFERENCES tournaments(id) ON DELETE CASCADE);
CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY);
CREATE TABLE tournament_payouts(tournament_id uuid);
CREATE TABLE tournament_obligations(tournament_id uuid);
CREATE TABLE tournament_registrations(tournament_id uuid);
CREATE TABLE tournament_registration_approvals(tournament_id uuid);
CREATE TABLE tournament_waitlists(tournament_id uuid);
CREATE TABLE tournament_tickets(club_id uuid,source_tournament_id uuid,source_satellite_id uuid);
CREATE TABLE hand_history(table_id uuid,tournament_id uuid);
CREATE TABLE table_hole_cards(table_id uuid);
CREATE TABLE hand_state_snapshots(table_id uuid);
CREATE TABLE table_cashout_history(table_id uuid);
CREATE TABLE insurance_transactions(table_id uuid);
CREATE TABLE managed_game_schedules(schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_kind text,game_id uuid,status text,completed_at timestamptz,result jsonb);
CREATE TABLE club_opening_setups(club_id uuid PRIMARY KEY,completed_at timestamptz,last_operation_id uuid);
CREATE FUNCTION fn_spin_required_seed(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT $1*100*2$$;
CREATE FUNCTION fn_schedule_time_zone_is_known(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT $1 IS NULL OR $1='UTC'$$;
CREATE FUNCTION smarter_private.f06_lease_has_pending_custody(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.pending_custody',true),'')='on'$$;
CREATE FUNCTION fn_club_membership_lock(uuid) RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
CREATE FUNCTION fn_ca_lock_settlement_lane_global() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_ca_settlement_lane_doctrine() RETURNS jsonb LANGUAGE plpgsql AS $doctrine$
DECLARE
  v_global_allowed CONSTANT text[] := ARRAY['fn_poker_diamond_tournament_cancel','some_other_reviewed_authority'];
  v_unknown text;
BEGIN
  SELECT string_agg(p.proname::text,',' ORDER BY p.proname::text) INTO v_unknown
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosrc LIKE '%fn_ca_lock_settlement_lane_' || 'global(%'
     AND p.proname<>'fn_ca_lock_settlement_lane_global'
     AND NOT (p.proname::text=ANY(v_global_allowed));
  RETURN jsonb_build_object('ok',v_unknown IS NULL,'violations',
    CASE WHEN v_unknown IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_unknown) END);
END $doctrine$;
CREATE FUNCTION fn_ca_declare_ledger(text,text,uuid DEFAULT NULL,uuid DEFAULT NULL,text DEFAULT NULL,text[] DEFAULT NULL) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_spin_activate(p_club uuid,p_seed numeric,p_stake numeric,p_source text,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN UPDATE clubs SET chip_treasury=chip_treasury-p_seed WHERE id=p_club AND chip_treasury>=p_seed; IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','insufficient'); END IF; INSERT INTO spin_bonus_pools(club_id,balance,seeded_amount,seed_source_wallet,owner_kind,offered_max_stake,highest_stake,activated_at) VALUES(p_club,p_seed,p_seed,p_source,'club',p_stake,p_stake,now()); INSERT INTO spin_reserve_ledger(club_id,kind,amount,balance_after) VALUES(p_club,'seed',p_seed,p_seed),(p_club,'activation',0,p_seed); RETURN jsonb_build_object('ok',true,'balance',p_seed); END$$;
CREATE FUNCTION fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('ok',true)$$;
CREATE FUNCTION fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE g uuid:=gen_random_uuid();t uuid:=gen_random_uuid();BEGIN INSERT INTO cash_games(id,club_id) VALUES(g,$1);INSERT INTO tables(id,club_id,cluster_id,status,current_players) VALUES(t,$1,g,'waiting',0);RETURN jsonb_build_object('ok',true,'game_id',g,'table_id',t);END$$;
CREATE FUNCTION fn_upsert_tournament_schedule(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE s uuid:=gen_random_uuid();BEGIN INSERT INTO tournament_schedules VALUES(s,($1->>'clubId')::uuid,true,now());RETURN jsonb_build_object('ok',true,'schedule_id',s);END$$;
CREATE FUNCTION fn_complete_club_opening_setup(p_club_id uuid,p_operation_id uuid,p_tagline text,p_rake_percent numeric,p_rake_cap_bb numeric,p_bbj_enabled boolean,p_bbj_seed numeric,p_spins_enabled boolean,p_spin_seed numeric,p_spin_max_stake numeric,p_promo_enabled boolean,p_promo_type text,p_promo_name text,p_promo_description text,p_promo_budget numeric,p_leaderboard_rewards_enabled boolean,p_leaderboard_metric text,p_leaderboard_prize_budget numeric,p_leaderboard_overlay_enabled boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $fn$DECLARE
  v_rake numeric:=0; v_bbj_seed numeric:=p_bbj_seed; v_spin_seed numeric:=p_spin_seed;
  v_promo_budget numeric:=0; v_leaderboard_budget numeric:=0; v_other_allocation numeric; v_total_allocation numeric;
  v_spin_result jsonb; v_pool_id uuid;
  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '')), '\s+', ' ', 'g'), 72);
BEGIN
  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN NULL; END IF;
  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;
  v_total_allocation:=v_other_allocation+v_spin_seed;
  IF p_spins_enabled THEN
    v_spin_result := public.fn_spin_activate(
      p_club_id,v_spin_seed,p_spin_max_stake,'chip_treasury',auth.uid());
  END IF;
  UPDATE public.clubs SET
      spins_preseed_amount = v_spin_seed,
      updated_at=now()
  WHERE id=p_club_id;
  IF p_bbj_enabled THEN
    SELECT pool.id INTO v_pool_id FROM public.bbj_pools pool WHERE pool.club_id=p_club_id;
  END IF;
  INSERT INTO club_opening_setups(club_id,last_operation_id)
  VALUES(p_club_id,p_operation_id);
  PERFORM
    p_bbj_enabled, v_bbj_seed,
    p_spins_enabled, v_spin_seed, CASE WHEN p_spins_enabled THEN p_spin_max_stake ELSE 0 END;
  RETURN '{}'::jsonb;
END$fn$;
CREATE FUNCTION fn_ca_retire_certification_club(p_club_id uuid,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_retired numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id) THEN
    RETURN jsonb_build_object('success',false,'error','this club has played: it is not a fixture');
  END IF;
  SELECT chip_treasury INTO v_retired FROM clubs WHERE id=p_club_id FOR UPDATE;
  UPDATE clubs SET chip_treasury=0 WHERE id=p_club_id;
  RETURN jsonb_build_object('success',true,'club_id',p_club_id,'chips_retired',v_retired);
END$fn$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO clubs(id,owner_id) VALUES('00000000-0000-4000-9000-000000000099','00000000-0000-4000-8000-000000000002');
"""

try:
    r=command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8','-c','shared_memory_type=mmap'])
    if r.returncode: raise RuntimeError(r.stderr)
    with (cluster/'data/postgresql.conf').open('a') as f: f.write(f"\nlisten_addresses=''\nunix_socket_directories='{socket}'\nport={port}\nshared_memory_type=mmap\ndynamic_shared_memory_type=mmap\nshared_buffers='16MB'\n")
    r=command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-w','start'])
    if r.returncode: raise RuntimeError(r.stderr+'\n'+(cluster/'server.log').read_text())
    run('setup',SETUP)
    run('install-terminal-table-durability-guard-preimage',TERMINAL_TABLE_GUARD_FIXTURE)
    run('opening-definition-before', "SELECT pg_get_functiondef('fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure);")
    run('install-core',MIGRATION.read_text())
    run('core-leaves-hot-table-triggers-detached',"SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_fence_welcome_package_schedule_spawn','trg_remember_club_owner_transfer','trg_offer_lifetime_first_club_welcome') AND NOT tgisinternal;",'0')
    run('core-leaves-hot-foreign-keys-detached',"SELECT count(*) FROM pg_constraint WHERE conname IN ('club_welcome_entitlements_club_fkey','club_welcome_entitlements_owner_request_fkey');",'0')
    run('core-leaves-owner-history-empty',"SELECT count(*) FROM club_owner_creation_history;",'0')
    run('install-certification-cleanup',CLEANUP_MIGRATION.read_text())
    run('install-hot-trigger',HOT_TRIGGER_MIGRATION.read_text())
    run('hot-trigger-installed-once',"SELECT count(*),(SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='tournaments' AND trigger_name='trg_fence_welcome_package_schedule_spawn') FROM pg_trigger WHERE tgname='trg_fence_welcome_package_schedule_spawn' AND NOT tgisinternal;",'1|1')
    run('offer-stays-detached-after-tournament-fence',"SELECT count(*) FROM pg_trigger WHERE tgname='trg_offer_lifetime_first_club_welcome' AND NOT tgisinternal;",'0')
    run('install-club-history',CLUB_HISTORY_MIGRATION.read_text())
    run('owner-transfer-trigger-and-club-fk-installed-once',"SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trg_remember_club_owner_transfer' AND NOT tgisinternal),(SELECT count(*) FROM pg_constraint WHERE conname='club_welcome_entitlements_club_fkey' AND convalidated);",'1|1')
    run('offer-stays-detached-after-club-history',"SELECT count(*) FROM pg_trigger WHERE tgname='trg_offer_lifetime_first_club_welcome' AND NOT tgisinternal;",'0')
    run('install-request-activation',REQUEST_ACTIVATION_MIGRATION.read_text())
    run('install-ledger-counterparty-repair',LEDGER_COUNTERPARTY_REPAIR_MIGRATION.read_text())
    run('install-ledger-category-repair',LEDGER_CATEGORY_REPAIR_MIGRATION.read_text())
    run('install-derived-table-cleanup',DERIVED_TABLE_CLEANUP_MIGRATION.read_text())
    run('install-authoritative-lease-repair',AUTHORITATIVE_LEASE_REPAIR_MIGRATION.read_text())
    controller_old = 't.created_by IS NOT NULL'
    controller_new = '(t.created_by IS NOT NULL AND t.created_by IS DISTINCT FROM v_club.owner_id)'
    controller_unknown = '(t.created_by IS DISTINCT FROM v_club.owner_id)'
    controller_signature = "'public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure"
    downgrade_controller_provenance = f"""
DO $downgrade$
DECLARE v_source text;
BEGIN
  SELECT pg_get_functiondef({controller_signature}) INTO v_source;
  IF position('{controller_new}' IN v_source)=0 THEN
    RAISE EXCEPTION 'fixture expected the controller-owner guard';
  END IF;
  EXECUTE replace(v_source,'{controller_new}','{controller_old}');
END
$downgrade$;
CREATE TEMP TABLE controller_provenance_before AS
SELECT replace(pg_get_functiondef(p.oid),'{controller_old}','{controller_new}') AS expected_definition,
       p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,p.proparallel,p.procost,p.prorows
  FROM pg_proc p WHERE p.oid={controller_signature};
"""
    verify_controller_provenance = f"""
SELECT pg_get_functiondef(p.oid)=b.expected_definition,
       (p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,p.proparallel,p.procost,p.prorows)
         IS NOT DISTINCT FROM
       (b.proowner,b.proacl,b.proconfig,b.prosecdef,b.provolatile,b.proparallel,b.procost,b.prorows),
       position('{controller_new}' IN pg_get_functiondef(p.oid))>0
  FROM pg_proc p CROSS JOIN controller_provenance_before b
 WHERE p.oid={controller_signature};
"""
    run('install-controller-provenance-repair-from-old-definition',
        downgrade_controller_provenance+CONTROLLER_PROVENANCE_REPAIR_MIGRATION.read_text()+verify_controller_provenance,
        't|t|t')
    run('install-schedule-spawn-cleanup',SCHEDULE_SPAWN_CLEANUP_MIGRATION.read_text())
    run('install-unmaterialized-spawn-cleanup',UNMATERIALIZED_SPAWN_CLEANUP_MIGRATION.read_text())
    run('install-board-game-cleanup',BOARD_GAME_CLEANUP_MIGRATION.read_text())
    run('install-board-lease-cleanup',BOARD_LEASE_CLEANUP_MIGRATION.read_text())
    run('install-board-origin-cleanup',BOARD_ORIGIN_CLEANUP_MIGRATION.read_text())
    run('durability-guard-preimage',"""
SELECT r.rolname,p.prosecdef,p.proconfig::text,
       has_function_privilege('anon',p.oid,'EXECUTE'),
       has_function_privilege('authenticated',p.oid,'EXECUTE'),
       has_function_privilege('service_role',p.oid,'EXECUTE')
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='fn_tournament_table_terminal_close_is_irreversible()'::regprocedure;
SELECT pg_get_triggerdef(t.oid,true),t.tgenabled
  FROM pg_trigger t WHERE t.tgname='tournament_table_terminal_close_is_irreversible';
""")
    run('install-board-delete-permit',BOARD_DELETE_PERMIT_MIGRATION.read_text())
    run('install-fresh-board-cleanup',FRESH_BOARD_CLEANUP_MIGRATION.read_text())
    run('install-post-reset-cleanup',POST_RESET_CLEANUP_MIGRATION.read_text())
    run('install-post-reset-uuid-order',POST_RESET_UUID_ORDER_MIGRATION.read_text())
    run('reinstall-post-reset-uuid-order',POST_RESET_UUID_ORDER_MIGRATION.read_text())
    run('post-reset-uuid-order-catalog-contract',r"""
SELECT md5(p.prosrc),p.prosecdef,r.rolname,
       p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql'),
       p.prorettype='jsonb'::regtype,
       NOT p.proretset,p.provolatile,p.prokind,
       p.proconfig=ARRAY['search_path=public, pg_temp']::text[],
       NOT EXISTS(
         SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
       ),
       NOT EXISTS(
         SELECT 1 FROM pg_proc a
          WHERE a.prokind='a' AND a.proname='min'
            AND pg_get_function_identity_arguments(a.oid)='uuid'
       )
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
""",'f3e2ae948cbf344220873311a7cc10aa|t|postgres|t|t|t|v|f|t|t|t')
    run('tamper-post-reset-uuid-order-source',r"""
DO $tamper$
DECLARE v_definition text;
BEGIN
  v_definition:=pg_get_functiondef(
    'fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure
  );
  IF strpos(v_definition,E'BEGIN\n  IF COALESCE')=0 THEN
    RAISE EXCEPTION 'fixture source preimage missing';
  END IF;
  EXECUTE replace(v_definition,E'BEGIN\n  IF COALESCE',
                  E'BEGIN\n  -- digest drift\n  IF COALESCE');
END
$tamper$;
""")
    run_refusal('refuse-tampered-post-reset-uuid-order-source',
                POST_RESET_UUID_ORDER_MIGRATION.read_text(),
                'POST_RESET_UUID_ORDER_SOURCE_DIGEST_REFUSED')
    run('restore-post-reset-uuid-order-source',r"""
DO $restore$
DECLARE v_definition text;
BEGIN
  v_definition:=pg_get_functiondef(
    'fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure
  );
  EXECUTE replace(v_definition,E'BEGIN\n  -- digest drift\n  IF COALESCE',
                  E'BEGIN\n  IF COALESCE');
END
$restore$;
""")
    run('tamper-post-reset-uuid-order-config',
        "ALTER FUNCTION fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) SET search_path TO public;")
    run_refusal('refuse-tampered-post-reset-uuid-order-config',
                POST_RESET_UUID_ORDER_MIGRATION.read_text(),
                'POST_RESET_UUID_ORDER_POSTIMAGE_REFUSED')
    run('restore-post-reset-uuid-order-config',
        "ALTER FUNCTION fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) SET search_path TO public,pg_temp;")
    run('verify-restored-post-reset-uuid-order',POST_RESET_UUID_ORDER_MIGRATION.read_text())
    run('install-post-reset-atomic-board',POST_RESET_ATOMIC_BOARD_MIGRATION.read_text())
    run('reinstall-post-reset-atomic-board',POST_RESET_ATOMIC_BOARD_MIGRATION.read_text())
    run('post-reset-atomic-board-catalog-contract',r"""
SELECT md5(p.prosrc),p.prosecdef,r.rolname,p.proconfig,
       NOT p.proleakproof,p.proparallel='u',
       has_function_privilege('anon',p.oid,'EXECUTE'),
       has_function_privilege('authenticated',p.oid,'EXECUTE'),
       has_function_privilege('service_role',p.oid,'EXECUTE'),
       EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
               WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner),
       p.prosrc LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%',
       p.prosrc LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%'
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
""",'d784a67061328a136e0ec6da61c1973e|t|postgres|{"search_path=public, pg_temp"}|t|t|f|f|f|f|t|t')
    run('tamper-post-reset-atomic-board-source',r"""
DO $tamper$
DECLARE v_definition text;
BEGIN
  v_definition:=pg_get_functiondef(
    'fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure
  );
  IF strpos(v_definition,E'BEGIN\n  IF COALESCE')=0 THEN
    RAISE EXCEPTION 'fixture source preimage missing';
  END IF;
  EXECUTE replace(v_definition,E'BEGIN\n  IF COALESCE',
                  E'BEGIN\n  -- atomic board digest drift\n  IF COALESCE');
END
$tamper$;
""")
    run_refusal('refuse-tampered-post-reset-atomic-board-source',
                POST_RESET_ATOMIC_BOARD_MIGRATION.read_text(),
                'POST_RESET_ATOMIC_BOARD_SOURCE_DIGEST_REFUSED')
    run('restore-post-reset-atomic-board-source',r"""
DO $restore$
DECLARE v_definition text;
BEGIN
  v_definition:=pg_get_functiondef(
    'fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure
  );
  EXECUTE replace(v_definition,E'BEGIN\n  -- atomic board digest drift\n  IF COALESCE',
                  E'BEGIN\n  IF COALESCE');
END
$restore$;
""")
    run('verify-restored-post-reset-atomic-board',POST_RESET_ATOMIC_BOARD_MIGRATION.read_text())
    run('tamper-post-reset-atomic-board-config',
        "ALTER FUNCTION fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) SET search_path TO public;")
    run_refusal('refuse-tampered-post-reset-atomic-board-config',
                POST_RESET_ATOMIC_BOARD_MIGRATION.read_text(),
                'POST_RESET_ATOMIC_BOARD_POSTIMAGE_REFUSED')
    run('restore-post-reset-atomic-board-config',
        "ALTER FUNCTION fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) SET search_path TO public,pg_temp;")
    run('verify-restored-post-reset-atomic-board-config',POST_RESET_ATOMIC_BOARD_MIGRATION.read_text())
    run('install-post-reset-fixture-builder',r"""
CREATE FUNCTION test_shape_post_reset_welcome_fixture(
  p_club uuid,p_owner uuid,p_board_count integer DEFAULT 12,
  p_materialize_schedule boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql AS $fixture$
DECLARE
  v_operation uuid:=gen_random_uuid();
  v_schedule uuid;
  v_scheduled uuid;
  v_cash uuid[];
  v_initial_tables uuid[];
  v_tournaments uuid[];
  v_tables uuid[];
  v_bbj uuid;
  v_spin uuid;
BEGIN
  IF p_board_count NOT BETWEEN 0 AND 12 THEN
    RAISE EXCEPTION 'invalid post-reset board count';
  END IF;
  SELECT entity_id INTO v_schedule FROM club_welcome_package_items
   WHERE club_id=p_club AND entity_kind='tournament_schedule';
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}'),
         COALESCE(array_agg(initial_table_id ORDER BY initial_table_id),'{}')
    INTO v_cash,v_initial_tables FROM club_welcome_package_items
   WHERE club_id=p_club AND entity_kind='cash_game';

  IF p_materialize_schedule THEN
    INSERT INTO tournaments(id,club_id,schedule_id,name,game_type,variant,tournament_type,
      buy_in_amount,buy_in_fee,max_players,min_players,table_size,starting_chips,current_players,status)
    VALUES(gen_random_uuid(),p_club,v_schedule,'Daily 7 PM $25','NLH','freezeout','MTT',25,0,10000,2,9,20000,0,'REGISTERING')
    RETURNING id INTO v_scheduled;
    INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key,created_at)
    VALUES(v_schedule,v_scheduled,'post-reset-scheduled',now()-interval '20 minutes');
  END IF;

  WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
    ('NLH Heads-Up 1','NLH','sng','SNG',.95::numeric,.05::numeric,2,1000),
    ('PLO4 Heads-Up 1','PLO4','sng','SNG',.95::numeric,.05::numeric,2,1000),
    ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',.95::numeric,.05::numeric,2,300),
    ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',.95::numeric,.05::numeric,2,300),
    ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
    ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
    ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
    ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
    ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
    ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
    ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
    ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  )
  INSERT INTO tournaments(id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
    max_players,min_players,table_size,starting_chips,current_players,status)
  SELECT gen_random_uuid(),p_club,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
    seats,seats,seats,stack,0,'REGISTERING' FROM expected;
  DELETE FROM tournaments
   WHERE id IN (
     SELECT id FROM tournaments WHERE club_id=p_club AND schedule_id IS NULL
      ORDER BY name,id OFFSET p_board_count
   );

  INSERT INTO tables(id,club_id,tournament_id,name,game_type,status,lifecycle,current_players,max_players,is_deleted)
  SELECT gen_random_uuid(),p_club,t.id,t.name,'tournament','waiting','opening',0,t.max_players,false
    FROM tournaments t WHERE t.club_id=p_club;
  INSERT INTO tournament_table_origins(table_id,tournament_id,origin_kind)
  SELECT id,tournament_id,'prelaunch' FROM tables
   WHERE club_id=p_club AND tournament_id IS NOT NULL;
  INSERT INTO engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,
    heartbeat_at,lease_generation,protocol_version)
  SELECT id,'retired-post-reset-cert','fixture',now()-interval '20 minutes',
    now()-interval '20 minutes',gen_random_uuid(),2 FROM tournaments WHERE club_id=p_club;

  UPDATE tournaments SET status='CANCELLED',ended_at=now(),started_at=NULL,current_players=0
   WHERE club_id=p_club;
  UPDATE tables SET status='closed',lifecycle='closed',current_players=0 WHERE club_id=p_club;
  IF p_materialize_schedule THEN
    INSERT INTO managed_game_schedules(game_kind,game_id,status,completed_at,result)
    VALUES('tournament',v_scheduled,'cancelled',now(),'{"reason":"welcome_package_reset"}'),
          ('table',(SELECT id FROM tables WHERE club_id=p_club AND tournament_id=v_scheduled),
           'cancelled',now(),'{"reason":"welcome_package_reset"}');
  END IF;

  UPDATE cash_games SET enabled=false,state='dormant',closed_at=now(),closed_by=p_owner
   WHERE id=ANY(v_cash);
  UPDATE tournament_schedules SET active=false WHERE id=v_schedule;
  UPDATE clubs SET chip_treasury=100000,chip_pool=0,promo_balance=0,insurance_balance=0,
    spins_enabled=false,bbj_enabled=false,bbj_rake_enabled=false WHERE id=p_club;
  UPDATE bbj_pools SET main_balance=0,backup_balance=0,promo_balance=0,pool_amount=0,
    hands_contributed=0,total_contributed=0,total_paid_out=0,hit_count=0,status='retired'
   WHERE club_id=p_club RETURNING id INTO v_bbj;
  UPDATE spin_bonus_pools SET balance=0,seeded_amount=0,seed_returned_amount=200,
    total_deposited=0,total_drawn=0,spin_count=0,bonus_count=0,surplus_returned=0,
    is_active=false,deactivated_at=now() WHERE club_id=p_club RETURNING id INTO v_spin;
  INSERT INTO spin_reserve_ledger(club_id,kind,amount,balance_after,note)
  VALUES(p_club,'seed_return',-200,0,'welcome_package_reset'),
        (p_club,'deactivation',0,0,'welcome_package_reset');
  INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,
    to_label,amount,category,club_id,description,idempotency_key,pre_from_balance,
    post_from_balance,pre_to_balance,post_to_balance,metadata)
  VALUES(p_owner,'spin_reserve',v_spin,'Spin Reserve','club_treasury',p_club,'Club Treasury',
    200,'reversal',p_club,'Welcome reset Spin seed return',
    'spin-deactivation-seed-return:'||p_club::text||':200',200,0,99800,100000,
    jsonb_build_object('reason','welcome_package_reset','operation_id',v_operation));
  INSERT INTO chip_transactions(club_id,amount,transaction_type,notes,balance_after,metadata)
  VALUES(p_club,100,'bbj_promo_sweep','Welcome reset BBJ return',100000,
    jsonb_build_object('reason','welcome_package_reset','pool_id',v_bbj,
                       'operation_id',v_operation));

  INSERT INTO wheel_configs(host_id,host_kind,enabled) VALUES(p_club,'club',false);
  INSERT INTO wheel_pools(host_id) VALUES(p_club);
  INSERT INTO diamond_game_configs(host_id,game,host_kind,enabled)
  SELECT p_club,game,'club',false FROM unnest(ARRAY['plinko','crash','crossing','mines']) game;
  INSERT INTO diamond_game_pools(host_id,game)
  SELECT p_club,game FROM unnest(ARRAY['plinko','crash','crossing','mines']) game;

  UPDATE club_welcome_package_items SET retired_at=now(),reset_operation_id=v_operation
   WHERE club_id=p_club;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tournaments
    FROM tournaments WHERE club_id=p_club;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tables
    FROM tables WHERE club_id=p_club;
  INSERT INTO club_welcome_reset_receipts(club_id,operation_id,actor_id,result)
  VALUES(p_club,v_operation,p_owner,jsonb_build_object(
    'ok',true,'operation_id',v_operation,'package_version','welcome-v1',
    'opening_grant_unwound',false,'owner_acceptance_receipts_preserved',true,
    'returned_to_treasury',jsonb_build_object('bbj',100,'spin',200),
    'removed',jsonb_build_object('cash_game_ids',to_jsonb(v_cash),
      'schedule_ids',to_jsonb(ARRAY[v_schedule]),'tournament_ids',to_jsonb(v_tournaments),
      'table_ids',to_jsonb(v_tables))));
END
$fixture$;
""")
    controller_authority = run('controller-provenance-repair-authority-before-refusal',f"""
SELECT md5(pg_get_functiondef(p.oid)),p.proowner,p.proacl::text,p.proconfig::text,
       p.prosecdef,p.provolatile,p.proparallel,p.procost,p.prorows
  FROM pg_proc p WHERE p.oid={controller_signature};
""")
    mismatch_controller_provenance = f"""
BEGIN;
DO $mismatch$
DECLARE v_source text;
BEGIN
  SELECT pg_get_functiondef({controller_signature}) INTO v_source;
  IF position('{controller_new}' IN v_source)=0 THEN
    RAISE EXCEPTION 'fixture expected the repaired controller-owner guard';
  END IF;
  EXECUTE replace(v_source,'{controller_new}','{controller_unknown}');
END
$mismatch$;
"""+CONTROLLER_PROVENANCE_REPAIR_MIGRATION.read_text()
    run_refusal('controller-provenance-repair-refuses-unknown-definition',
                mismatch_controller_provenance,
                'WELCOME_CERTIFICATION_CONTROLLER_PROVENANCE_GUARD_NOT_FOUND')
    run('controller-provenance-repair-refusal-rolls-back-definition-and-authority',f"""
SELECT md5(pg_get_functiondef(p.oid)),p.proowner,p.proacl::text,p.proconfig::text,
       p.prosecdef,p.provolatile,p.proparallel,p.procost,p.prorows
  FROM pg_proc p WHERE p.oid={controller_signature};
""",controller_authority)
    run('welcome-ledger-counterparty-is-declared-clearing-store',"SELECT position('welcome_package' in prosrc),position('opening_setup' in prosrc)>0 FROM pg_proc WHERE oid='fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure;",'0|t')
    run('welcome-ledger-category-is-declared-opening-allocation',"SELECT position('club_welcome_allocation' in prosrc),position('club_opening_allocation' in prosrc)>0 FROM pg_proc WHERE oid='fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)'::regprocedure;",'0|t')
    run('offer-trigger-installed-once',"SELECT count(*) FROM pg_trigger WHERE tgname='trg_offer_lifetime_first_club_welcome' AND NOT tgisinternal;",'1')
    run('request-fk-installed-once',"SELECT count(*) FROM pg_constraint WHERE conname='club_welcome_entitlements_owner_request_fkey' AND convalidated;",'1')
    run('money-registry-before-create',"SELECT status,length(notes)>80 FROM ca_money_rpc_registry WHERE proname='fn_apply_club_welcome_economics';",'approved|t')
    run('board-cleanup-registry-before-create',"SELECT status,length(notes)>80 FROM ca_money_rpc_registry WHERE proname='fn_ca_prepare_unused_welcome_certification_board_games';",'system|t')
    run('durability-guard-still-refuses-ordinary-direct-delete',"""
BEGIN;
INSERT INTO tournaments(id,club_id,status)
VALUES('00000000-0000-4000-a000-000000000001','00000000-0000-4000-9000-000000000099','REGISTERING');
INSERT INTO tables(id,club_id,tournament_id,status,current_players)
VALUES('00000000-0000-4000-b000-000000000001','00000000-0000-4000-9000-000000000099',
       '00000000-0000-4000-a000-000000000001','waiting',0);
SET request.jwt.claim.role='service_role';
DO $x$ BEGIN
  DELETE FROM tables WHERE id='00000000-0000-4000-b000-000000000001';
  RAISE EXCEPTION 'ordinary_durable_table_delete_not_refused';
EXCEPTION WHEN sqlstate '55000' THEN
  IF SQLERRM NOT LIKE 'tournament table % is durable and cannot be deleted' THEN RAISE; END IF;
END $x$;
SELECT count(*),(SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM tables WHERE id='00000000-0000-4000-b000-000000000001';
ROLLBACK;
""",'1|0')
    run('durability-permit-is-bound-to-its-original-transaction',"""
INSERT INTO tournaments(id,club_id,status)
VALUES('00000000-0000-4000-a000-000000000002','00000000-0000-4000-9000-000000000099','REGISTERING');
INSERT INTO tables(id,club_id,tournament_id,status,current_players)
VALUES('00000000-0000-4000-b000-000000000002','00000000-0000-4000-9000-000000000099',
       '00000000-0000-4000-a000-000000000002','waiting',0);
INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits(
  transaction_id,table_id,tournament_id,club_id
) VALUES(
  pg_current_xact_id(),'00000000-0000-4000-b000-000000000002',
  '00000000-0000-4000-a000-000000000002','00000000-0000-4000-9000-000000000099'
);
""")
    run('stale-durability-permit-cannot-authorize-a-later-transaction',"""
SET request.jwt.claim.role='service_role';
DO $x$ BEGIN
  DELETE FROM tables WHERE id='00000000-0000-4000-b000-000000000002';
  RAISE EXCEPTION 'stale_permit_was_reused';
EXCEPTION WHEN sqlstate '55000' THEN
  IF SQLERRM NOT LIKE 'tournament table % is durable and cannot be deleted' THEN RAISE; END IF;
END $x$;
SELECT count(*),(SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM tables WHERE id='00000000-0000-4000-b000-000000000002';
BEGIN;
RESET request.jwt.claim.role;
DELETE FROM smarter_private.ca_welcome_certification_table_delete_permits
 WHERE table_id='00000000-0000-4000-b000-000000000002';
INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits(
  transaction_id,table_id,tournament_id,club_id
) VALUES(
  pg_current_xact_id(),'00000000-0000-4000-b000-000000000002',
  '00000000-0000-4000-a000-000000000002','00000000-0000-4000-9000-000000000099'
);
DELETE FROM tables WHERE id='00000000-0000-4000-b000-000000000002';
DELETE FROM tournaments WHERE id='00000000-0000-4000-a000-000000000002';
SELECT count(*),(SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM tables WHERE id='00000000-0000-4000-b000-000000000002';
COMMIT;
""",'1|1\n0|0')
    owner1='00000000-0000-4000-8000-000000000001'; owner2='00000000-0000-4000-8000-000000000002'
    c1='00000000-0000-4000-9000-000000000001'; c2='00000000-0000-4000-9000-000000000002'; c3='00000000-0000-4000-9000-000000000003'
    owner3='00000000-0000-4000-8000-000000000003'; c4='00000000-0000-4000-9000-000000000004'
    owner4='00000000-0000-4000-8000-000000000004'; c5='00000000-0000-4000-9000-000000000005'
    owner5='00000000-0000-4000-8000-000000000005'; c6='00000000-0000-4000-9000-000000000006'
    owner6='00000000-0000-4000-8000-000000000006'; c7='a0000000-0000-0000-0000-000000000001'
    owner7='00000000-0000-4000-8000-000000000007'; c8='00000000-0000-4000-9000-000000000008'
    owner8='00000000-0000-4000-8000-000000000008'; c9='00000000-0000-4000-9000-000000000009'
    owner9='00000000-0000-4000-8000-000000000009'; c10='00000000-0000-4000-9000-000000000010'
    owner10='00000000-0000-4000-8000-000000000010'; c11='00000000-0000-4000-9000-000000000011'
    owner11='00000000-0000-4000-8000-000000000011'; c12='00000000-0000-4000-9000-000000000012'
    owner12='00000000-0000-4000-8000-000000000012'; c13='00000000-0000-4000-9000-000000000013'
    owner13='00000000-0000-4000-8000-000000000013'; c14='00000000-0000-4000-9000-000000000014'
    owner14='00000000-0000-4000-8000-000000000014'; c15='00000000-0000-4000-9000-000000000015'
    owner15='00000000-0000-4000-8000-000000000015'; c16='00000000-0000-4000-9000-000000000016'
    owner16='00000000-0000-4000-8000-000000000016'; c17='00000000-0000-4000-9000-000000000017'
    owner17='00000000-0000-4000-8000-000000000017'; c18='00000000-0000-4000-9000-000000000018'
    owner18='00000000-0000-4000-8000-000000000018'; c19='00000000-0000-4000-9000-000000000019'
    owner19='00000000-0000-4000-8000-000000000019'; c20='00000000-0000-4000-9000-000000000020'
    owner20='00000000-0000-4000-8000-000000000020'; c21='00000000-0000-4000-9000-000000000021'
    owner21='00000000-0000-4000-8000-000000000021'; c22='00000000-0000-4000-9000-000000000022'
    owner22='00000000-0000-4000-8000-000000000022'; c23='00000000-0000-4000-9000-000000000023'
    owner23='00000000-0000-4000-8000-000000000023'; c24='00000000-0000-4000-9000-000000000024'
    owner24='00000000-0000-4000-8000-000000000024'; c25='00000000-0000-4000-9000-000000000025'
    def shape_post_reset_fixture(case,owner,club,board_count=12,materialize_schedule=True):
        tournament_count=board_count+(1 if materialize_schedule else 0)
        table_count=9+tournament_count
        command_count=2 if materialize_schedule else 0
        run(case,f"""
INSERT INTO auth.users VALUES('{owner}','ca-customization-cert-postdeploy-{club[-2:]}@example.invalid');
INSERT INTO clubs(id,owner_id,name) VALUES('{club}','{owner}','Crest Cert Post Reset {club[-2:]}');
INSERT INTO club_members(club_id,user_id) VALUES('{club}','{owner}');
SET request.jwt.claim.sub='{owner}';
INSERT INTO club_creation_requests VALUES('{owner}',gen_random_uuid(),'{club}');
SELECT test_shape_post_reset_welcome_fixture('{club}','{owner}',{board_count},{str(materialize_schedule).lower()});
SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{club}'),
       (SELECT count(*) FROM tables WHERE club_id='{club}'),
       (SELECT count(*) FROM managed_game_schedules
         WHERE game_id IN (SELECT id FROM tournaments WHERE club_id='{club}')
            OR game_id IN (SELECT id FROM tables WHERE club_id='{club}'))
  FROM club_welcome_package_items WHERE club_id='{club}' AND retired_at IS NOT NULL;
""",f'\n10|{tournament_count}|{table_count}|{command_count}')
    run('prospective-first',f"SET request.jwt.claim.sub='{owner1}'; INSERT INTO clubs(id,owner_id) VALUES('{c1}','{owner1}'); INSERT INTO club_creation_requests VALUES('{owner1}',gen_random_uuid(),'{c1}'); SELECT count(*),count(*) FILTER(WHERE r.club_id IS NOT NULL),(SELECT count(*) FROM club_welcome_package_items WHERE club_id='{c1}') FROM club_welcome_entitlements e LEFT JOIN club_welcome_package_receipts r USING(club_id) WHERE e.owner_id='{owner1}';",'1|1|10')
    run('lifetime-second-ineligible',f"SET request.jwt.claim.sub='{owner1}'; INSERT INTO clubs(id,owner_id) VALUES('{c2}','{owner1}'); INSERT INTO club_creation_requests VALUES('{owner1}',gen_random_uuid(),'{c2}'); SELECT count(*) FROM club_welcome_entitlements WHERE owner_id='{owner1}';",'1')
    run('existing-owner-ineligible',f"SET request.jwt.claim.sub='{owner2}'; INSERT INTO clubs(id,owner_id) VALUES('{c3}','{owner2}'); INSERT INTO club_creation_requests VALUES('{owner2}',gen_random_uuid(),'{c3}'); SELECT count(*) FROM club_welcome_entitlements WHERE owner_id='{owner2}';",'0')
    run('matrix',"SELECT jsonb_array_length(fn_club_welcome_package_config()->'cash_games'),fn_club_welcome_package_config()->>'time_zone',fn_club_welcome_package_config()->>'display_time_label',fn_club_welcome_package_config()->'tournament_schedule'->'config'->>'maxPlayers',fn_club_welcome_package_config()->'economics'->>'diamond_spins_status';",'9||7:00 PM UTC|10000|owner_acceptance_required')
    run('history-backfill',f"SELECT welcome_eligible,provenance FROM club_owner_creation_history WHERE owner_id='{owner2}';",'f|historical')
    run('transfer-cannot-requalify',f"UPDATE clubs SET owner_id='{owner3}' WHERE id='00000000-0000-4000-9000-000000000099'; SET request.jwt.claim.sub='{owner3}'; INSERT INTO clubs(id,owner_id) VALUES('{c4}','{owner3}'); INSERT INTO club_creation_requests VALUES('{owner3}',gen_random_uuid(),'{c4}'); SELECT count(*) FROM club_welcome_entitlements WHERE owner_id='{owner3}';",'0')
    run('hand-history-blocks-reset',f"SET request.jwt.claim.sub='{owner1}'; INSERT INTO hand_history(table_id) SELECT initial_table_id FROM club_welcome_package_items WHERE club_id='{c1}' AND entity_kind='cash_game' ORDER BY slot_key LIMIT 1; SELECT fn_get_club_welcome_package_reset_impact('{c1}')->>'can_reset',fn_get_club_welcome_package_reset_impact('{c1}')#>>'{{blocking,hand_history}}';",'false|1')
    run('reset-discovers-both-schedule-links',f"SET request.jwt.claim.sub='{owner1}'; DELETE FROM hand_history; WITH s AS(SELECT entity_id FROM club_welcome_package_items WHERE club_id='{c1}' AND entity_kind='tournament_schedule'), a AS(INSERT INTO tournaments(id,club_id,schedule_id,status) SELECT gen_random_uuid(),'{c1}',entity_id,'REGISTERING' FROM s RETURNING id), b AS(INSERT INTO tournaments(id,club_id,status) VALUES(gen_random_uuid(),'{c1}','REGISTERING') RETURNING id) INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key) SELECT s.entity_id,b.id,'backlink' FROM s,b; SELECT jsonb_array_length(fn_get_club_welcome_package_reset_impact('{c1}')->'tournament_ids');",'2')
    run('owner-reset-soft-retires',f"SET request.jwt.claim.sub='{owner1}'; SELECT fn_remove_first_club_welcome_games('{c1}',gen_random_uuid())->>'ok'; SELECT count(*) FROM tournaments WHERE club_id='{c1}' AND status='CANCELLED'; SELECT count(*) FROM club_welcome_package_items WHERE club_id='{c1}' AND retired_at IS NOT NULL;",'true\n2\n10')
    run('retired-schedule-fences-spawn',f"SET request.jwt.claim.sub='{owner1}'; DO $x$ DECLARE s uuid; BEGIN SELECT entity_id INTO s FROM club_welcome_package_items WHERE club_id='{c1}' AND entity_kind='tournament_schedule'; BEGIN INSERT INTO tournaments(id,club_id,schedule_id,status) VALUES(gen_random_uuid(),'{c1}',s,'REGISTERING'); RAISE EXCEPTION 'spawn_not_fenced'; EXCEPTION WHEN sqlstate '55000' THEN NULL; END; END $x$; SELECT 'refused';",'refused')
    run('certification-cleanup-package-derived-table-setup',f"INSERT INTO auth.users VALUES('{owner4}','ca-customization-cert-postdeploy-native@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c5}','{owner4}','Crest Cert Native'); INSERT INTO club_members(club_id,user_id) VALUES('{c5}','{owner4}'); SET request.jwt.claim.sub='{owner4}'; INSERT INTO club_creation_requests VALUES('{owner4}',gen_random_uuid(),'{c5}'); INSERT INTO tables(id,club_id,cluster_id,game_type,created_by,role,main_index,lifecycle,status,current_players) SELECT gen_random_uuid(),'{c5}',entity_id,'cash','{owner4}','feeder',NULL,'opening','waiting',0 FROM club_welcome_package_items WHERE club_id='{c5}' AND entity_kind='cash_game' ORDER BY slot_key LIMIT 1; INSERT INTO cash_cluster_events(game_id,table_id) SELECT cluster_id,id FROM tables WHERE club_id='{c5}' ORDER BY id DESC LIMIT 1; SELECT is_active,activated_at IS NOT NULL,deactivated_at IS NULL,balance,seeded_amount,offered_max_stake,highest_stake,(SELECT count(*) FROM spin_reserve_ledger WHERE club_id='{c5}') FROM spin_bonus_pools WHERE club_id='{c5}';",'t|t|t|200.00|200.00|1|1|2')
    run('certification-cleanup-package-derived-table',f"SET request.jwt.claim.role='service_role'; SELECT fn_ca_retire_welcome_certification_club('{c5}','native-cert')->>'chips_retired'; SELECT count(*),(SELECT count(*) FROM club_welcome_entitlements WHERE club_id='{c5}'),(SELECT count(*) FROM club_owner_creation_history WHERE owner_id='{owner4}'),(SELECT count(*) FROM cash_cluster_events),(SELECT sum(amount) FROM spin_reserve_ledger WHERE club_id='{c5}') FROM tables WHERE club_id='{c5}';",'100000.00\n0|0|0|0|0.00')
    run('certification-cleanup-refuses-activity',f"INSERT INTO auth.users VALUES('{owner5}','ca-customization-cert-postdeploy-active@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c6}','{owner5}','Crest Cert Active'); INSERT INTO club_members(club_id,user_id) VALUES('{c6}','{owner5}'); SET request.jwt.claim.sub='{owner5}'; INSERT INTO club_creation_requests VALUES('{owner5}',gen_random_uuid(),'{c6}'); INSERT INTO table_seats(table_id) SELECT initial_table_id FROM club_welcome_package_items WHERE club_id='{c6}' AND entity_kind='cash_game' LIMIT 1; SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_prepare_unused_welcome_certification_fixture('{c6}'); RAISE EXCEPTION 'activity_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY' THEN RAISE; END IF; END $x$; SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c6}') FROM club_welcome_package_items WHERE club_id='{c6}';",'10|9')
    run('certification-cleanup-refuses-protected-estate',f"INSERT INTO auth.users VALUES('{owner6}','ca-customization-cert-postdeploy-protected@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c7}','{owner6}','Crest Cert Protected'); INSERT INTO club_members(club_id,user_id) VALUES('{c7}','{owner6}'); SET request.jwt.claim.sub='{owner6}'; INSERT INTO club_creation_requests VALUES('{owner6}',gen_random_uuid(),'{c7}'); SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_prepare_unused_welcome_certification_fixture('{c7}'); RAISE EXCEPTION 'protected_not_refused'; EXCEPTION WHEN sqlstate '42501' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED' THEN RAISE; END IF; END $x$; SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c7}') FROM club_welcome_package_items WHERE club_id='{c7}';",'10|9')
    run('certification-cleanup-removes-idle-schedule-spawns',f"INSERT INTO auth.users VALUES('{owner7}','ca-customization-cert-postdeploy-schedule@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c8}','{owner7}','Crest Cert Schedule'); INSERT INTO club_members(club_id,user_id) VALUES('{c8}','{owner7}'); SET request.jwt.claim.sub='{owner7}'; INSERT INTO club_creation_requests VALUES('{owner7}',gen_random_uuid(),'{c8}'); WITH s AS(SELECT entity_id FROM club_welcome_package_items WHERE club_id='{c8}' AND entity_kind='tournament_schedule'), a AS(INSERT INTO tournaments(id,club_id,schedule_id,status) SELECT gen_random_uuid(),'{c8}',entity_id,'REGISTERING' FROM s RETURNING id), b AS(INSERT INTO tournaments(id,club_id,status) VALUES(gen_random_uuid(),'{c8}','REGISTERING') RETURNING id), spawn AS(INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key) SELECT s.entity_id,b.id,'backlink' FROM s,b), unmaterialized AS(INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key,created_at) SELECT entity_id,NULL,'unmaterialized',now()-interval '10 minutes' FROM s) INSERT INTO tables(id,club_id,tournament_id,game_type,status,current_players) SELECT gen_random_uuid(),'{c8}'::uuid,id,'tournament','waiting',0 FROM a UNION ALL SELECT gen_random_uuid(),'{c8}'::uuid,id,'tournament','waiting',0 FROM b; SET request.jwt.claim.role='service_role'; SELECT fn_ca_retire_welcome_certification_club('{c8}','schedule-cert')->>'schedule_tournaments_removed'; SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{c8}'),(SELECT count(*) FROM tournament_schedule_spawns) FROM tables WHERE club_id='{c8}';",'2\n0|0|1')
    run('certification-schedule-cleanup-refuses-registration-atomically',f"INSERT INTO auth.users VALUES('{owner8}','ca-customization-cert-postdeploy-schedule-active@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c9}','{owner8}','Crest Cert Schedule Active'); INSERT INTO club_members(club_id,user_id) VALUES('{c9}','{owner8}'); SET request.jwt.claim.sub='{owner8}'; INSERT INTO club_creation_requests VALUES('{owner8}',gen_random_uuid(),'{c9}'); WITH s AS(SELECT entity_id FROM club_welcome_package_items WHERE club_id='{c9}' AND entity_kind='tournament_schedule'), t AS(INSERT INTO tournaments(id,club_id,schedule_id,status) SELECT gen_random_uuid(),'{c9}',entity_id,'REGISTERING' FROM s RETURNING id), seat AS(INSERT INTO tournament_players(tournament_id) SELECT id FROM t) INSERT INTO tables(id,club_id,tournament_id,game_type,status,current_players) SELECT gen_random_uuid(),'{c9}',id,'tournament','waiting',0 FROM t; SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c9}','active-schedule-cert'); RAISE EXCEPTION 'registration_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_SCHEDULE_FIXTURE_HAS_ACTIVITY' THEN RAISE; END IF; END $x$; SELECT active,(SELECT count(*) FROM tournaments WHERE club_id='{c9}'),(SELECT count(*) FROM tables WHERE club_id='{c9}'),(SELECT count(*) FROM tournament_players) FROM tournament_schedules WHERE club_id='{c9}';",'t|1|10|1')
    run('certification-schedule-cleanup-refuses-fresh-claim-atomically',f"INSERT INTO auth.users VALUES('{owner9}','ca-customization-cert-postdeploy-fresh-claim@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c10}','{owner9}','Crest Cert Fresh Claim'); INSERT INTO club_members(club_id,user_id) VALUES('{c10}','{owner9}'); SET request.jwt.claim.sub='{owner9}'; INSERT INTO club_creation_requests VALUES('{owner9}',gen_random_uuid(),'{c10}'); INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key) SELECT entity_id,NULL,'fresh-claim' FROM club_welcome_package_items WHERE club_id='{c10}' AND entity_kind='tournament_schedule'; SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c10}','fresh-claim-cert'); RAISE EXCEPTION 'fresh_claim_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED' THEN RAISE; END IF; END $x$; SELECT active,(SELECT count(*) FROM tournament_schedule_spawns WHERE spawn_key='fresh-claim') FROM tournament_schedules WHERE club_id='{c10}';",'t|1')
    run('certification-cleanup-retires-exact-idle-owner-board',f"""
INSERT INTO auth.users VALUES('{owner10}','ca-customization-cert-postdeploy-board@example.invalid');
INSERT INTO clubs(id,owner_id,name) VALUES('{c11}','{owner10}','Crest Cert Board');
INSERT INTO club_members(club_id,user_id) VALUES('{c11}','{owner10}');
SET request.jwt.claim.sub='{owner10}';
INSERT INTO club_creation_requests VALUES('{owner10}',gen_random_uuid(),'{c11}');
WITH s AS(
  SELECT entity_id FROM club_welcome_package_items
   WHERE club_id='{c11}' AND entity_kind='tournament_schedule'
), games AS(
  INSERT INTO tournaments(id,club_id,schedule_id,status,created_at,updated_at)
  SELECT gen_random_uuid(),'{c11}',entity_id,'REGISTERING',now()-interval '10 minutes',now()-interval '10 minutes'
    FROM s CROSS JOIN generate_series(1,3)
  RETURNING id
), spawns AS(
  INSERT INTO tournament_schedule_spawns(schedule_id,tournament_id,spawn_key,created_at)
  SELECT s.entity_id,g.id,'scheduled-'||row_number() OVER(),now()-interval '10 minutes' FROM s,games g
)
INSERT INTO tables(id,club_id,tournament_id,game_type,status,current_players,created_at,updated_at)
SELECT gen_random_uuid(),'{c11}',id,'tournament','waiting',0,now()-interval '10 minutes',now()-interval '10 minutes' FROM games;
WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
 VALUES
 ('NLH Heads-Up 1','NLH','sng','SNG',0.95,0.05,2,1000),('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95,0.05,2,1000),
 ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95,0.05,2,300),('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95,0.05,2,300),
 ('1 Chip Spin NLH','NLH','spin','SPIN',1,0,3,300),('1 Chip Spin PLO4','PLO4','spin','SPIN',1,0,3,300),
 ('1 Chip Spin PLO5','PLO5','spin','SPIN',1,0,3,300),('1 Chip Spin PLO6','PLO6','spin','SPIN',1,0,3,300),
 ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1,0,3,1000),('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1,0,3,1000),
 ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1,0,3,1000),('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1,0,3,1000)
), games AS(
 INSERT INTO tournaments(id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  max_players,min_players,table_size,starting_chips,current_players,status,created_at,updated_at)
 SELECT gen_random_uuid(),'{c11}',name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  seats,seats,seats,stack,0,'REGISTERING',now(),now()
 FROM expected RETURNING id,name,max_players
)
INSERT INTO tables(id,club_id,tournament_id,name,game_type,status,current_players,max_players,is_deleted,created_at,updated_at)
SELECT gen_random_uuid(),'{c11}',id,name,'tournament','waiting',0,max_players,false,
 now(),now() FROM games;
INSERT INTO engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
SELECT id,'retired-cert-engine','test',now()-interval '11 minutes',now()-interval '11 minutes',gen_random_uuid(),2
  FROM tournaments WHERE club_id='{c11}' AND schedule_id IS NULL;
INSERT INTO tournament_table_origins(table_id,tournament_id,origin_kind)
SELECT id,tournament_id,'prelaunch' FROM tables
 WHERE club_id='{c11}' AND tournament_id IN
   (SELECT id FROM tournaments WHERE club_id='{c11}' AND schedule_id IS NULL);
SET request.jwt.claim.role='service_role';
DO $x$ BEGIN
  DELETE FROM tables WHERE id=(SELECT id FROM tables WHERE club_id='{c11}' AND tournament_id IS NOT NULL LIMIT 1);
  RAISE EXCEPTION 'certification_shaped_direct_delete_not_refused';
EXCEPTION WHEN sqlstate '55000' THEN
  IF SQLERRM NOT LIKE 'tournament table % is durable and cannot be deleted' THEN RAISE; END IF;
END $x$;
WITH retired AS (
 SELECT fn_ca_retire_welcome_certification_club('{c11}','board-cert') AS result
)
SELECT result->>'board_tournaments_removed',result->>'board_tournament_leases_removed',
       result->>'board_origins_removed',result->>'schedule_tournaments_removed' FROM retired;
SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{c11}'),
       (SELECT count(*) FROM tables WHERE club_id='{c11}'),
       (SELECT count(*) FROM engine_tournament_leases),
       (SELECT count(*) FROM tournament_table_origins),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits),
       (SELECT NOT is_active AND balance=0 FROM spin_bonus_pools WHERE club_id='{c11}')
  FROM club_welcome_package_items WHERE club_id='{c11}';
""",'12|12|12|3\n0|0|0|0|0|0|t')
    run('certification-board-cleanup-refuses-fresh-and-active-atomically',f"""
INSERT INTO auth.users VALUES('{owner11}','ca-customization-cert-postdeploy-board-active@example.invalid');
INSERT INTO clubs(id,owner_id,name) VALUES('{c12}','{owner11}','Crest Cert Board Active');
INSERT INTO club_members(club_id,user_id) VALUES('{c12}','{owner11}');
SET request.jwt.claim.sub='{owner11}'; INSERT INTO club_creation_requests VALUES('{owner11}',gen_random_uuid(),'{c12}');
WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
 VALUES
 ('NLH Heads-Up 1','NLH','sng','SNG',0.95,0.05,2,1000),('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95,0.05,2,1000),
 ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95,0.05,2,300),('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95,0.05,2,300),
 ('1 Chip Spin NLH','NLH','spin','SPIN',1,0,3,300),('1 Chip Spin PLO4','PLO4','spin','SPIN',1,0,3,300),
 ('1 Chip Spin PLO5','PLO5','spin','SPIN',1,0,3,300),('1 Chip Spin PLO6','PLO6','spin','SPIN',1,0,3,300),
 ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1,0,3,1000),('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1,0,3,1000),
 ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1,0,3,1000),('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1,0,3,1000)
), g AS(
 INSERT INTO tournaments(id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  max_players,min_players,table_size,starting_chips,current_players,status)
 SELECT gen_random_uuid(),'{c12}',name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  seats,seats,seats,stack,0,'REGISTERING' FROM expected
 RETURNING id,name,max_players
)
INSERT INTO tables(id,club_id,tournament_id,name,game_type,status,current_players,max_players,is_deleted)
SELECT gen_random_uuid(),'{c12}',id,name,'tournament','waiting',0,max_players,false FROM g;
INSERT INTO tournament_table_origins(table_id,tournament_id,origin_kind)
SELECT id,tournament_id,'prelaunch'
FROM tables
WHERE club_id='{c12}' AND tournament_id IS NOT NULL;
SET request.jwt.claim.role='service_role';
INSERT INTO engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
SELECT id,'live-cert-engine','test',now(),now(),gen_random_uuid(),2 FROM tournaments WHERE club_id='{c12}';
DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c12}','fresh-lease-board-cert');
 RAISE EXCEPTION 'fresh_lease_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN
 IF SQLERRM<>'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED' THEN RAISE; END IF; END $x$;
SELECT is_active,(SELECT count(*) FROM tournaments WHERE club_id='{c12}'),
       (SELECT count(*) FROM engine_tournament_leases WHERE tournament_id IN
         (SELECT id FROM tournaments WHERE club_id='{c12}')) FROM spin_bonus_pools WHERE club_id='{c12}';
UPDATE engine_tournament_leases SET acquired_at=now()-interval '11 minutes',heartbeat_at=now()-interval '11 minutes'
 WHERE tournament_id IN (SELECT id FROM tournaments WHERE club_id='{c12}');
SET test.pending_custody='on';
DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c12}','custody-lease-board-cert');
 RAISE EXCEPTION 'custody_lease_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN
 IF SQLERRM<>'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED' THEN RAISE; END IF; END $x$;
SELECT is_active,(SELECT count(*) FROM tournaments WHERE club_id='{c12}'),
       (SELECT count(*) FROM engine_tournament_leases WHERE tournament_id IN
         (SELECT id FROM tournaments WHERE club_id='{c12}')) FROM spin_bonus_pools WHERE club_id='{c12}';
SET test.pending_custody='off';
DELETE FROM engine_tournament_leases WHERE tournament_id IN (SELECT id FROM tournaments WHERE club_id='{c12}');
UPDATE tournament_table_origins SET origin_kind='capacity'
 WHERE table_id IN (SELECT id FROM tables WHERE club_id='{c12}');
DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c12}','bad-origin-board-cert');
 RAISE EXCEPTION 'bad_origin_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN
 IF SQLERRM<>'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED' THEN RAISE; END IF; END $x$;
SELECT is_active,(SELECT count(*) FROM tournaments WHERE club_id='{c12}'),
       (SELECT count(*) FROM tournament_table_origins) FROM spin_bonus_pools WHERE club_id='{c12}';
UPDATE tournament_table_origins SET origin_kind='prelaunch'
 WHERE table_id IN (SELECT id FROM tables WHERE club_id='{c12}');
INSERT INTO tournament_rebuys(tournament_id) SELECT id FROM tournaments WHERE club_id='{c12}';
DO $x$ BEGIN PERFORM fn_ca_retire_welcome_certification_club('{c12}','active-board-cert');
 RAISE EXCEPTION 'active_board_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN
 IF SQLERRM<>'WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY' THEN RAISE; END IF; END $x$;
SELECT is_active,(SELECT count(*) FROM tournaments WHERE club_id='{c12}'),
       (SELECT count(*) FROM tournament_rebuys),
       (SELECT count(*) FROM tournament_table_origins),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM spin_bonus_pools WHERE club_id='{c12}';
""",'t|12|12\nt|12|12\nt|12|12\nt|12|12|12|0')
    shape_post_reset_fixture('post-reset-success-setup',owner12,c13)
    run('post-reset-success-cleans-only-mutable-fixture-state',f"""
SET request.jwt.claim.role='service_role';
WITH retired AS (
  SELECT fn_ca_retire_welcome_certification_club('{c13}','post-reset-cert') result
)
SELECT result->>'cleanup_state',result->>'chips_retired' FROM retired;
SELECT (SELECT count(*) FROM tables WHERE club_id='{c13}'),
       (SELECT count(*) FROM tournaments WHERE club_id='{c13}'),
       (SELECT count(*) FROM cash_games WHERE club_id='{c13}'),
       (SELECT count(*) FROM tournament_schedules WHERE club_id='{c13}'),
       (SELECT count(*) FROM club_welcome_entitlements WHERE club_id='{c13}'),
       (SELECT count(*) FROM wheel_configs WHERE host_id='{c13}'),
       (SELECT count(*) FROM diamond_game_configs WHERE host_id='{c13}'),
       (SELECT count(*) FROM engine_tournament_leases l JOIN tournaments t ON t.id=l.tournament_id WHERE t.club_id='{c13}'),
       (SELECT count(*) FROM tournament_schedule_spawns s JOIN tournament_schedules ts ON ts.id=s.schedule_id WHERE ts.club_id='{c13}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits),
       (SELECT count(*) FROM spin_reserve_ledger WHERE club_id='{c13}'),
       (SELECT count(*) FROM chip_ledger WHERE club_id='{c13}' AND category='reversal'),
       (SELECT count(*) FROM chip_transactions WHERE club_id='{c13}' AND transaction_type='bbj_promo_sweep'),
       (SELECT count(*) FROM spin_bonus_pools WHERE club_id='{c13}' AND seed_returned_amount=200),
       (SELECT count(*) FROM bbj_pools WHERE club_id='{c13}' AND status='retired');
""",'post_reset|100000.00\n0|0|0|0|0|0|0|0|0|0|4|1|1|1|1')

    shape_post_reset_fixture('post-reset-cross-club-spawn-setup',owner13,c14)
    run_refusal('post-reset-refuses-cross-club-schedule-backlink-atomically',f"""
SET request.jwt.claim.role='service_role';
INSERT INTO tournaments(id,club_id,name,status,ended_at,current_players)
VALUES('00000000-0000-4000-a000-000000000014','00000000-0000-4000-9000-000000000099',
       'Foreign Scheduled Tournament','CANCELLED',now(),0);
UPDATE tournament_schedule_spawns SET tournament_id='00000000-0000-4000-a000-000000000014'
 WHERE schedule_id=(SELECT entity_id FROM club_welcome_package_items
                     WHERE club_id='{c14}' AND entity_kind='tournament_schedule');
SELECT fn_ca_retire_welcome_certification_club('{c14}','cross-club-spawn-cert');
""",'POST_RESET_CERTIFICATION_SCHEDULE_LINEAGE_REFUSED')
    run('post-reset-cross-club-spawn-refusal-preserves-fixture',f"""
SELECT (SELECT count(*) FROM club_welcome_package_items WHERE club_id='{c14}'),
       (SELECT count(*) FROM tournaments WHERE club_id='{c14}'),
       (SELECT count(*) FROM tables WHERE club_id='{c14}'),
       (SELECT chip_treasury FROM clubs WHERE id='{c14}');
""",'10|13|22|100000')

    shape_post_reset_fixture('post-reset-board-shape-refusal-setup',owner14,c15)
    run_refusal('post-reset-refuses-missing-board-shape-atomically',f"""
SET request.jwt.claim.role='service_role';
UPDATE tournaments SET name='Broken Duplicate Board Slot'
 WHERE id=(SELECT id FROM tournaments WHERE club_id='{c15}' AND schedule_id IS NULL ORDER BY id LIMIT 1);
SELECT fn_ca_retire_welcome_certification_club('{c15}','bad-board-cert');
""",'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED')
    run('post-reset-board-shape-refusal-preserves-fixture',f"SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c15}'),(SELECT chip_treasury FROM clubs WHERE id='{c15}') FROM tournaments WHERE club_id='{c15}';",'13|22|100000')

    shape_post_reset_fixture('post-reset-unknown-activity-refusal-setup',owner15,c16)
    run_refusal('post-reset-refuses-new-fk-bearing-tournament-activity-atomically',f"""
SET request.jwt.claim.role='service_role';
INSERT INTO tournament_rebuys(tournament_id)
SELECT id FROM tournaments WHERE club_id='{c16}' AND schedule_id IS NULL ORDER BY id LIMIT 1;
SELECT fn_ca_retire_welcome_certification_club('{c16}','activity-cert');
""",'POST_RESET_CERTIFICATION_UNKNOWN_TOURNAMENT_ACTIVITY')
    run('post-reset-activity-refusal-preserves-fixture',f"SELECT count(*),(SELECT count(*) FROM tournament_rebuys r JOIN tournaments t ON t.id=r.tournament_id WHERE t.club_id='{c16}'),(SELECT chip_treasury FROM clubs WHERE id='{c16}') FROM tournaments WHERE club_id='{c16}';",'13|1|100000')

    shape_post_reset_fixture('post-reset-f06-refusal-setup',owner16,c17)
    run_refusal('post-reset-refuses-pending-f06-custody-atomically',f"""
SET request.jwt.claim.role='service_role';
SET test.pending_custody='on';
SELECT fn_ca_retire_welcome_certification_club('{c17}','f06-cert');
""",'POST_RESET_CERTIFICATION_ACTIVE_LEASE_REFUSED')
    run('post-reset-f06-refusal-preserves-fixture',f"SET test.pending_custody='off'; SELECT count(*),(SELECT count(*) FROM engine_tournament_leases l JOIN tournaments t ON t.id=l.tournament_id WHERE t.club_id='{c17}'),(SELECT chip_treasury FROM clubs WHERE id='{c17}') FROM tables WHERE club_id='{c17}';",'22|13|100000')

    shape_post_reset_fixture('post-reset-financial-refusal-setup',owner17,c18)
    run_refusal('post-reset-refuses-bad-seed-return-lineage-atomically',f"""
SET request.jwt.claim.role='service_role';
DELETE FROM spin_reserve_ledger WHERE club_id='{c18}' AND kind='seed_return';
SELECT fn_ca_retire_welcome_certification_club('{c18}','financial-cert');
""",'POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED')
    run('post-reset-financial-refusal-preserves-fixture',f"SELECT count(*),(SELECT count(*) FROM spin_reserve_ledger WHERE club_id='{c18}'),(SELECT chip_treasury FROM clubs WHERE id='{c18}') FROM tables WHERE club_id='{c18}';",'22|3|100000')

    shape_post_reset_fixture('post-reset-managed-command-refusal-setup',owner18,c19)
    run_refusal('post-reset-refuses-nonterminal-managed-command-atomically',f"""
SET request.jwt.claim.role='service_role';
UPDATE managed_game_schedules SET status='pending',completed_at=NULL
 WHERE schedule_id=(SELECT m.schedule_id FROM managed_game_schedules m
   WHERE m.game_id IN (SELECT id FROM tournaments WHERE club_id='{c19}') LIMIT 1);
SELECT fn_ca_retire_welcome_certification_club('{c19}','managed-cert');
""",'POST_RESET_CERTIFICATION_MANAGED_COMMAND_REFUSED')
    run('post-reset-managed-command-refusal-preserves-fixture',f"SELECT count(*),(SELECT count(*) FROM managed_game_schedules WHERE game_id IN (SELECT id FROM tournaments WHERE club_id='{c19}')),(SELECT chip_treasury FROM clubs WHERE id='{c19}') FROM tables WHERE club_id='{c19}';",'22|1|100000')

    shape_post_reset_fixture('post-reset-zero-board-zero-schedule-setup',owner19,c20,0,False)
    run('post-reset-zero-board-zero-schedule-cleans',f"""
SET request.jwt.claim.role='service_role';
WITH retired AS (
  SELECT fn_ca_retire_welcome_certification_club('{c20}','zero-board-cert') result
)
SELECT result->>'cleanup_state',result->>'chips_retired' FROM retired;
SELECT (SELECT count(*) FROM clubs WHERE id='{c20}' AND chip_treasury=0),
       (SELECT count(*) FROM tables WHERE club_id='{c20}'),
       (SELECT count(*) FROM tournaments WHERE club_id='{c20}'),
       (SELECT count(*) FROM cash_games WHERE club_id='{c20}'),
       (SELECT count(*) FROM tournament_schedules WHERE club_id='{c20}'),
       (SELECT count(*) FROM club_welcome_entitlements WHERE club_id='{c20}'),
       (SELECT count(*) FROM wheel_configs WHERE host_id='{c20}'),
       (SELECT count(*) FROM diamond_game_configs WHERE host_id='{c20}'),
       (SELECT count(*) FROM engine_tournament_leases l JOIN tournaments t ON t.id=l.tournament_id WHERE t.club_id='{c20}'),
       (SELECT count(*) FROM tournament_schedule_spawns s JOIN tournament_schedules ts ON ts.id=s.schedule_id WHERE ts.club_id='{c20}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits),
       (SELECT count(*) FROM spin_reserve_ledger WHERE club_id='{c20}'),
       (SELECT count(*) FROM chip_ledger WHERE club_id='{c20}' AND category='reversal'),
       (SELECT count(*) FROM chip_transactions WHERE club_id='{c20}' AND transaction_type='bbj_promo_sweep'),
       (SELECT count(*) FROM spin_bonus_pools WHERE club_id='{c20}' AND seed_returned_amount=200),
       (SELECT count(*) FROM bbj_pools WHERE club_id='{c20}' AND status='retired');
""",'post_reset|100000.00\n1|0|0|0|0|0|0|0|0|0|0|4|1|1|1|1')

    shape_post_reset_fixture('post-reset-full-board-zero-schedule-setup',owner20,c21,12,False)
    run('post-reset-full-board-zero-schedule-cleans',f"""
SET request.jwt.claim.role='service_role';
WITH retired AS (
  SELECT fn_ca_retire_welcome_certification_club('{c21}','full-board-no-schedule-cert') result
)
SELECT result->>'cleanup_state',result->>'chips_retired' FROM retired;
SELECT (SELECT count(*) FROM clubs WHERE id='{c21}' AND chip_treasury=0),
       (SELECT count(*) FROM tables WHERE club_id='{c21}'),
       (SELECT count(*) FROM tournaments WHERE club_id='{c21}'),
       (SELECT count(*) FROM cash_games WHERE club_id='{c21}'),
       (SELECT count(*) FROM tournament_schedules WHERE club_id='{c21}'),
       (SELECT count(*) FROM club_welcome_entitlements WHERE club_id='{c21}'),
       (SELECT count(*) FROM wheel_configs WHERE host_id='{c21}'),
       (SELECT count(*) FROM diamond_game_configs WHERE host_id='{c21}'),
       (SELECT count(*) FROM engine_tournament_leases l JOIN tournaments t ON t.id=l.tournament_id WHERE t.club_id='{c21}'),
       (SELECT count(*) FROM tournament_schedule_spawns s JOIN tournament_schedules ts ON ts.id=s.schedule_id WHERE ts.club_id='{c21}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits),
       (SELECT count(*) FROM spin_reserve_ledger WHERE club_id='{c21}'),
       (SELECT count(*) FROM chip_ledger WHERE club_id='{c21}' AND category='reversal'),
       (SELECT count(*) FROM chip_transactions WHERE club_id='{c21}' AND transaction_type='bbj_promo_sweep'),
       (SELECT count(*) FROM spin_bonus_pools WHERE club_id='{c21}' AND seed_returned_amount=200),
       (SELECT count(*) FROM bbj_pools WHERE club_id='{c21}' AND status='retired');
""",'post_reset|100000.00\n1|0|0|0|0|0|0|0|0|0|0|4|1|1|1|1')

    shape_post_reset_fixture('post-reset-partial-board-refusal-setup',owner21,c22,5,False)
    run_refusal('post-reset-refuses-partial-board-atomically',f"""
SET request.jwt.claim.role='service_role';
SELECT fn_ca_retire_welcome_certification_club('{c22}','partial-board-cert');
""",'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED')
    run('post-reset-partial-board-refusal-preserves-fixture',f"SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c22}'),(SELECT chip_treasury FROM clubs WHERE id='{c22}') FROM tournaments WHERE club_id='{c22}';",'5|14|100000')

    shape_post_reset_fixture('post-reset-duplicate-board-refusal-setup',owner22,c23,12,False)
    run_refusal('post-reset-refuses-duplicate-board-slot-atomically',f"""
SET request.jwt.claim.role='service_role';
WITH source AS (
  SELECT * FROM tournaments WHERE club_id='{c23}' ORDER BY name,id LIMIT 1
), target AS (
  SELECT id FROM tournaments WHERE club_id='{c23}' ORDER BY name,id OFFSET 1 LIMIT 1
)
UPDATE tournaments t SET name=s.name,game_type=s.game_type,variant=s.variant,
  tournament_type=s.tournament_type,buy_in_amount=s.buy_in_amount,buy_in_fee=s.buy_in_fee,
  max_players=s.max_players,min_players=s.min_players,table_size=s.table_size,
  starting_chips=s.starting_chips
 FROM source s,target x WHERE t.id=x.id;
SELECT fn_ca_retire_welcome_certification_club('{c23}','duplicate-board-cert');
""",'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED')
    run('post-reset-duplicate-board-refusal-preserves-fixture',f"""
SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{c23}'),
       (SELECT count(*) FROM tables WHERE club_id='{c23}'),
       (SELECT chip_treasury FROM clubs WHERE id='{c23}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM club_welcome_package_items WHERE club_id='{c23}';
""",'10|12|21|100000|0')

    shape_post_reset_fixture('post-reset-extra-tournament-refusal-setup',owner23,c24,12,False)
    run_refusal('post-reset-refuses-extra-tournament-atomically',f"""
SET request.jwt.claim.role='service_role';
INSERT INTO tournaments(id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  max_players,min_players,table_size,starting_chips,current_players,status,ended_at)
VALUES(gen_random_uuid(),'{c24}','Unrelated Tournament','NLH','freezeout','MTT',25,0,
  10000,2,9,20000,0,'CANCELLED',now());
SELECT fn_ca_retire_welcome_certification_club('{c24}','extra-tournament-cert');
""",'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED')
    run('post-reset-extra-tournament-refusal-preserves-fixture',f"""
SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{c24}'),
       (SELECT count(*) FROM tables WHERE club_id='{c24}'),
       (SELECT chip_treasury FROM clubs WHERE id='{c24}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM club_welcome_package_items WHERE club_id='{c24}';
""",'10|13|21|100000|0')

    shape_post_reset_fixture('post-reset-receipt-mismatch-refusal-setup',owner24,c25,12,False)
    run_refusal('post-reset-refuses-tournament-receipt-mismatch-atomically',f"""
SET request.jwt.claim.role='service_role';
UPDATE club_welcome_reset_receipts
 SET result=jsonb_set(result,'{{removed,tournament_ids}}','[]'::jsonb)
 WHERE club_id='{c25}';
SELECT fn_ca_retire_welcome_certification_club('{c25}','receipt-mismatch-cert');
""",'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED')
    run('post-reset-receipt-mismatch-refusal-preserves-fixture',f"""
SELECT count(*),(SELECT count(*) FROM tournaments WHERE club_id='{c25}'),
       (SELECT count(*) FROM tables WHERE club_id='{c25}'),
       (SELECT chip_treasury FROM clubs WHERE id='{c25}'),
       (SELECT count(*) FROM smarter_private.ca_welcome_certification_table_delete_permits)
  FROM club_welcome_package_items WHERE club_id='{c25}';
""",'10|12|21|100000|0')
    run('acl',"SELECT has_function_privilege('anon','fn_provision_first_club_welcome_package(uuid,uuid)','EXECUTE'),has_function_privilege('authenticated','fn_provision_first_club_welcome_package(uuid,uuid)','EXECUTE');",'f|t')
    results['passed']=all(c['passed'] for c in results['cases'])
finally:
    command([pg/'pg_ctl','-D',cluster/'data','-m','immediate','stop'])
    (out/'RESULT.json').write_text(json.dumps(results,indent=2)+'\n')
    shutil.rmtree(cluster,ignore_errors=True)
if not results['passed']: raise SystemExit(1)
print(json.dumps({'passed':True,'cases':len(results['cases']),'output':str(out)}))
