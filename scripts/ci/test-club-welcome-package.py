#!/usr/bin/env python3
"""Install and exercise the welcome-package migration in isolated PostgreSQL."""
import argparse, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261001154709_prospective_lifetime_first_club_welcome_package.sql'
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
results = {'migration': MIGRATION.name, 'cases': [], 'passed': False}

def command(argv, sql=None):
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=120)
def run(name, sql, expected=None):
    r=command(psql,sql); got=r.stdout.rstrip('\n'); ok=r.returncode==0 and (expected is None or got==expected)
    (out/f'{name}.log').write_text('-- SQL\n'+sql+'\n-- OUT\n'+r.stdout+'\n-- ERR\n'+r.stderr)
    results['cases'].append({'name':name,'passed':ok,'expected':expected,'observed':got})
    if not ok: raise RuntimeError(name+': '+r.stderr[-2000:]+r.stdout[-1000:])
    return got

SETUP = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL);
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
CREATE TABLE ca_declared_money_triggers(
 table_name text NOT NULL,trigger_name text NOT NULL,note text NOT NULL,
 PRIMARY KEY(table_name,trigger_name));
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,name text,is_union boolean DEFAULT false,union_id uuid,
 chip_treasury numeric DEFAULT 100000,bbj_enabled boolean DEFAULT false,bbj_rake_enabled boolean DEFAULT false,
 spins_enabled boolean DEFAULT false,spins_preseed_amount numeric DEFAULT 0,spins_wallet_funding text,
 created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE club_creation_requests(user_id uuid NOT NULL,request_id uuid NOT NULL,club_id uuid NOT NULL REFERENCES clubs(id),PRIMARY KEY(user_id,request_id));
CREATE TABLE union_clubs(club_id uuid,union_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,chip_balance numeric DEFAULT 0,promo_balance numeric DEFAULT 0);
CREATE TABLE agents(club_id uuid,user_id uuid);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,main_balance numeric,backup_balance numeric,
 promo_balance numeric,pool_amount numeric,status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE spin_bonus_pools(club_id uuid PRIMARY KEY,balance numeric DEFAULT 0);
CREATE TABLE leaderboard_reward_program_versions(club_id uuid,version integer);
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,enabled boolean DEFAULT true,state text DEFAULT 'live',closed_at timestamptz,closed_by uuid,updated_at timestamptz DEFAULT now());
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,schedule_id uuid,status text,started_at timestamptz,ended_at timestamptz,updated_at timestamptz DEFAULT now());
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,cluster_id uuid,tournament_id uuid,status text,current_players integer,updated_at timestamptz DEFAULT now());
CREATE TABLE tournament_schedules(id uuid PRIMARY KEY,club_id uuid,active boolean,updated_at timestamptz DEFAULT now());
CREATE TABLE tournament_schedule_spawns(schedule_id uuid,tournament_id uuid,spawn_key text);
CREATE TABLE table_seats(table_id uuid,left_at timestamptz);
CREATE TABLE table_sessions(table_id uuid,is_active boolean,left_at timestamptz);
CREATE TABLE table_waitlist(table_id uuid,status text);
CREATE TABLE cash_game_waitlist(game_id uuid,status text);
CREATE TABLE cash_seat_moves(game_id uuid,state text);
CREATE TABLE cash_seat_change_requests(game_id uuid,status text);
CREATE TABLE tournament_players(tournament_id uuid);
CREATE TABLE hand_history(table_id uuid,tournament_id uuid);
CREATE TABLE managed_game_schedules(game_kind text,game_id uuid,status text,completed_at timestamptz,result jsonb);
CREATE TABLE club_opening_setups(club_id uuid PRIMARY KEY,completed_at timestamptz,last_operation_id uuid);
CREATE FUNCTION fn_spin_required_seed(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT $1*100$$;
CREATE FUNCTION fn_schedule_time_zone_is_known(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT $1 IS NULL OR $1='UTC'$$;
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
CREATE FUNCTION fn_spin_activate(uuid,numeric,numeric,text,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('ok',true,'balance',$2)$$;
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
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id) THEN
    RETURN jsonb_build_object('success',false,'error','this club has played: it is not a fixture');
  END IF;
  RETURN jsonb_build_object('success',true,'club_id',p_club_id);
END$fn$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO clubs(id,owner_id) VALUES('00000000-0000-4000-9000-000000000099','00000000-0000-4000-8000-000000000002');
"""

try:
    r=command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    if r.returncode: raise RuntimeError(r.stderr)
    with (cluster/'data/postgresql.conf').open('a') as f: f.write(f"\nlisten_addresses=''\nunix_socket_directories='{socket}'\nport={port}\ndynamic_shared_memory_type=mmap\nshared_buffers='16MB'\n")
    r=command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-w','start'])
    if r.returncode: raise RuntimeError(r.stderr+'\n'+(cluster/'server.log').read_text())
    run('setup',SETUP)
    run('opening-definition-before', "SELECT pg_get_functiondef('fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure);")
    run('install',MIGRATION.read_text())
    owner1='00000000-0000-4000-8000-000000000001'; owner2='00000000-0000-4000-8000-000000000002'
    c1='00000000-0000-4000-9000-000000000001'; c2='00000000-0000-4000-9000-000000000002'; c3='00000000-0000-4000-9000-000000000003'
    owner3='00000000-0000-4000-8000-000000000003'; c4='00000000-0000-4000-9000-000000000004'
    owner4='00000000-0000-4000-8000-000000000004'; c5='00000000-0000-4000-9000-000000000005'
    owner5='00000000-0000-4000-8000-000000000005'; c6='00000000-0000-4000-9000-000000000006'
    owner6='00000000-0000-4000-8000-000000000006'; c7='a0000000-0000-0000-0000-000000000001'
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
    run('certification-cleanup-exact-fixture',f"INSERT INTO auth.users VALUES('{owner4}','ca-customization-cert-postdeploy-native@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c5}','{owner4}','Crest Cert Native'); INSERT INTO club_members(club_id,user_id) VALUES('{c5}','{owner4}'); SET request.jwt.claim.sub='{owner4}'; INSERT INTO club_creation_requests VALUES('{owner4}',gen_random_uuid(),'{c5}'); SET request.jwt.claim.role='service_role'; SELECT fn_ca_prepare_unused_welcome_certification_fixture('{c5}')->>'prepared'; SELECT count(*),(SELECT count(*) FROM club_welcome_entitlements WHERE club_id='{c5}'),(SELECT count(*) FROM club_owner_creation_history WHERE owner_id='{owner4}') FROM tables WHERE club_id='{c5}';",'true\n0|0|0')
    run('certification-cleanup-refuses-activity',f"INSERT INTO auth.users VALUES('{owner5}','ca-customization-cert-postdeploy-active@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c6}','{owner5}','Crest Cert Active'); INSERT INTO club_members(club_id,user_id) VALUES('{c6}','{owner5}'); SET request.jwt.claim.sub='{owner5}'; INSERT INTO club_creation_requests VALUES('{owner5}',gen_random_uuid(),'{c6}'); INSERT INTO table_seats(table_id) SELECT initial_table_id FROM club_welcome_package_items WHERE club_id='{c6}' AND entity_kind='cash_game' LIMIT 1; SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_prepare_unused_welcome_certification_fixture('{c6}'); RAISE EXCEPTION 'activity_not_refused'; EXCEPTION WHEN sqlstate '55000' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY' THEN RAISE; END IF; END $x$; SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c6}') FROM club_welcome_package_items WHERE club_id='{c6}';",'10|9')
    run('certification-cleanup-refuses-protected-estate',f"INSERT INTO auth.users VALUES('{owner6}','ca-customization-cert-postdeploy-protected@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{c7}','{owner6}','Crest Cert Protected'); INSERT INTO club_members(club_id,user_id) VALUES('{c7}','{owner6}'); SET request.jwt.claim.sub='{owner6}'; INSERT INTO club_creation_requests VALUES('{owner6}',gen_random_uuid(),'{c7}'); SET request.jwt.claim.role='service_role'; DO $x$ BEGIN PERFORM fn_ca_prepare_unused_welcome_certification_fixture('{c7}'); RAISE EXCEPTION 'protected_not_refused'; EXCEPTION WHEN sqlstate '42501' THEN IF SQLERRM<>'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED' THEN RAISE; END IF; END $x$; SELECT count(*),(SELECT count(*) FROM tables WHERE club_id='{c7}') FROM club_welcome_package_items WHERE club_id='{c7}';",'10|9')
    run('acl',"SELECT has_function_privilege('anon','fn_provision_first_club_welcome_package(uuid,uuid)','EXECUTE'),has_function_privilege('authenticated','fn_provision_first_club_welcome_package(uuid,uuid)','EXECUTE');",'f|t')
    results['passed']=all(c['passed'] for c in results['cases'])
finally:
    command([pg/'pg_ctl','-D',cluster/'data','-m','immediate','stop'])
    (out/'RESULT.json').write_text(json.dumps(results,indent=2)+'\n')
    shutil.rmtree(cluster,ignore_errors=True)
if not results['passed']: raise SystemExit(1)
print(json.dumps({'passed':True,'cases':len(results['cases']),'output':str(out)}))
