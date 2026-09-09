-- Isolated PostgreSQL contract fixture, never a production migration.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,current_players integer,status text DEFAULT 'waiting');
CREATE TABLE tournaments(id uuid PRIMARY KEY);
CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,seat_number integer,
 stack numeric,joined_at timestamptz,left_at timestamptz,leave_pending boolean,club_id uuid,status text,is_sitting_out boolean);
CREATE TABLE wallet_credit_idempotency(key text PRIMARY KEY,user_id uuid,amount numeric);
CREATE TABLE club_members(user_id uuid,club_id uuid,chip_balance numeric,updated_at timestamptz,status text DEFAULT 'active');
CREATE TABLE wallets(user_id uuid,wallet_type text,balance numeric,locked_balance numeric,
 updated_at timestamptz,UNIQUE(user_id,wallet_type));
CREATE TABLE wallet_transactions(user_id uuid,wallet_type text,type text,amount numeric,
 category text,description text,table_id uuid,balance_after numeric);
CREATE TABLE chip_transactions(club_id uuid,to_user_id uuid,amount numeric,
 transaction_type text,notes text,table_id uuid,metadata jsonb);
CREATE TABLE session_closes(user_id uuid,table_id uuid,stack numeric,reason text);
-- Authorization, session policy and wallet provisioning are fixture boundaries.
-- Cashout is loaded from its migration; credit from the pinned installed-function export.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.auth_uid',true),'')::uuid$$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.is_engine',true),''),'true')::boolean$$;
CREATE FUNCTION fn_cash_leave_check(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"allowed":true}'::jsonb$$;
CREATE FUNCTION fn_player_home_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_ensure_club_wallet(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM club_members WHERE user_id=$1 AND club_id=$2 AND status IN ('active','approved'))$$;
CREATE FUNCTION fn_cash_session_close(uuid,uuid,numeric,text) RETURNS void LANGUAGE sql
 AS $$INSERT INTO session_closes VALUES($1,$2,$3,$4)$$;
CREATE FUNCTION reject_test_exit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('test.reject_exit',true)='on' THEN
  RAISE EXCEPTION 'injected seat exit failure after wallet credit';
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER test_exit_failure BEFORE UPDATE ON table_seats
 FOR EACH ROW EXECUTE FUNCTION reject_test_exit();

CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);

-- Read-only production schema inspection: moderation player FK cascades.
ALTER TABLE tables ADD COLUMN club_id uuid DEFAULT 'cccccccc-cccc-cccc-cccc-cccccccccccc';
CREATE TABLE profiles(id uuid PRIMARY KEY);
CREATE TABLE anti_cheat_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text NOT NULL,
 player_id uuid REFERENCES profiles(id) ON DELETE CASCADE,club_id uuid,table_id uuid,
 details jsonb DEFAULT '{}'::jsonb,triggered_by text,created_at timestamptz DEFAULT now()
);

ALTER TABLE tables ADD COLUMN cluster_id uuid;

-- Minimal planner boundary fixture: financial/admission behavior is exercised
-- through the real ownership constraints and real cashout functions above.
CREATE TYPE public.cash_cluster_census_row AS (
 id uuid,role text,main_index integer,lifecycle text,status text,created_at timestamptz,
 max_players integer,seated integer,reserved integer,open_unreserved integer,breaking boolean
);
CREATE TABLE public.cash_games(id uuid PRIMARY KEY,must_move boolean);
CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql
AS $$SELECT coalesce(current_setting('test.platform_frozen',true),'false')='true'$$;

-- Deliberately hostile existing-trigger behavior for the migration rollback test.
CREATE FUNCTION inject_scope_backfill_corruption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('test.scope_backfill_corruption',true)='on'
    AND (to_jsonb(NEW)->'active_game_scope') IS DISTINCT FROM (to_jsonb(OLD)->'active_game_scope')
    OR current_setting('test.admission_backfill_corruption',true)='on'
    AND (to_jsonb(NEW)->'active_parent_key') IS DISTINCT FROM (to_jsonb(OLD)->'active_parent_key') THEN
   NEW.stack := NEW.stack+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER test_scope_backfill_corruption BEFORE UPDATE ON table_seats
FOR EACH ROW EXECUTE FUNCTION inject_scope_backfill_corruption();

ALTER TABLE tables ADD COLUMN lifecycle text DEFAULT 'live';
ALTER TABLE tables ADD COLUMN is_deleted boolean DEFAULT false;

-- Actual production physical-chair and active per-table user keys.
ALTER TABLE table_seats ADD CONSTRAINT table_seats_table_id_seat_number_key UNIQUE(table_id,seat_number);
CREATE UNIQUE INDEX idx_unique_active_user_per_table ON table_seats(table_id,user_id) WHERE left_at IS NULL;

ALTER TABLE tables ADD COLUMN is_template boolean DEFAULT false;
CREATE OR REPLACE FUNCTION public.fn_assert_cash_chip_purchase_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_is_template boolean;
BEGIN
  SELECT t.tournament_id, COALESCE(t.is_template, false)
    INTO v_tournament_id, v_is_template
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: cash chip purchase target does not exist'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION
      'CASH_PURCHASE_ONLY: cash buy-in, rebuy and add-on RPCs cannot fund a tournament table'
      USING ERRCODE = '55000';
  END IF;
  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game'
      USING ERRCODE = '55000';
  END IF;
END;
$function$
;

-- The production seat table has RLS enabled and only service-role write policies.
ALTER TABLE table_seats ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON table_seats TO anon,authenticated,service_role;
CREATE POLICY service_manages_seats ON table_seats FOR ALL TO service_role USING(true) WITH CHECK(true);

ALTER TABLE tables ADD COLUMN role text;
ALTER TABLE tables ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE cash_games ADD COLUMN enabled boolean DEFAULT true;
ALTER TABLE cash_games ADD COLUMN state text DEFAULT 'live';
ALTER TABLE cash_games ADD COLUMN closed_at timestamptz;
ALTER TABLE cash_games ADD COLUMN closed_by uuid;
ALTER TABLE cash_games ADD COLUMN updated_at timestamptz DEFAULT now();
CREATE FUNCTION fn_can_create_games(uuid,uuid) RETURNS boolean LANGUAGE sql AS
 $$SELECT coalesce(current_setting('test.can_create_games',true),'true')='true'$$;
