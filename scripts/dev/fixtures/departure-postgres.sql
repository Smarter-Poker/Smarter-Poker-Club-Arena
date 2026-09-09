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
