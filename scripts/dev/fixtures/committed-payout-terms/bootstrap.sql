-- Synthetic inputs only. Captured production functions are loaded separately.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE tournaments (
 id uuid PRIMARY KEY,status text,started_at timestamptz,current_level integer,
 level_started_at timestamptz,starting_chips numeric,max_players integer,current_players integer,
 prize_pool numeric,prize_pool_finalized boolean,variant text DEFAULT 'freezeout',
 tournament_type text DEFAULT 'MTT',buy_in_amount numeric DEFAULT 5,spin_multiplier numeric,
 payout_structure text,payout_percent integer DEFAULT 10,guaranteed_prize numeric DEFAULT 0,
 satellite_target_id uuid,satellite_target uuid,satellite_seats integer,buy_in_fee numeric,
 name text,union_id uuid,club_id uuid,is_private boolean DEFAULT false,
 is_premium_spin boolean DEFAULT false,bubble_protection boolean DEFAULT false,
 payout_math_version integer DEFAULT 1,payout_unit_cents integer DEFAULT 1
);
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,status text,current_players integer,
 max_players integer,small_blind numeric,big_blind numeric);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,status text,chips numeric,
 table_id uuid,seat_number integer,position integer,prize numeric DEFAULT 0,eliminated_at timestamptz);
CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number integer,stack numeric,left_at timestamptz);
CREATE TABLE hand_history(table_id uuid,tournament_id uuid,created_at timestamptz);
CREATE TABLE tournament_launch_receipts(tournament_id uuid PRIMARY KEY,launch_id uuid NOT NULL,
 started_at timestamptz NOT NULL,claimed_at timestamptz DEFAULT transaction_timestamp(),
 completed_at timestamptz,lease_generation uuid NOT NULL DEFAULT gen_random_uuid());
CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,lease_generation uuid,
 protocol_version integer,heartbeat_at timestamptz);
CREATE TABLE tournament_entry_close_receipts(tournament_id uuid PRIMARY KEY,close_mode text,
 entry_closed_at timestamptz,final_prize_pool numeric,payout_structure_snapshot jsonb,
 reprice_completed_at timestamptz,updated_at timestamptz,manager_wake_id bigint);
CREATE TABLE tournament_manager_wakes(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tournament_id uuid,reason text,generation bigint,created_at timestamptz DEFAULT clock_timestamp(),consumed_at timestamptz);
CREATE UNIQUE INDEX pending_wake ON tournament_manager_wakes(tournament_id,reason) WHERE consumed_at IS NULL;
CREATE TABLE tournament_place_settlement_batches(tournament_id uuid);
CREATE TABLE tournament_satellite_settlement_batches(tournament_id uuid);
CREATE TABLE tournament_final_table_deal_batches(tournament_id uuid);
CREATE TABLE tournament_terminal_settlements(tournament_id uuid);
CREATE TABLE tournament_cancellation_receipts(tournament_id uuid);
CREATE TABLE tournament_obligations(id uuid DEFAULT gen_random_uuid(),tournament_id uuid,user_id uuid,kind text,place integer,amount_owed numeric,amount_paid numeric);
CREATE TABLE tournament_payouts(tournament_id uuid,user_id uuid,position integer,source text,amount numeric,idempotency_key text);
CREATE TABLE clubs(id uuid PRIMARY KEY,chip_treasury numeric,updated_at timestamptz,asset text DEFAULT 'chips',is_platform boolean DEFAULT false,union_id uuid);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric,updated_at timestamptz);
CREATE TABLE chip_ledger(performed_by uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,club_id uuid,tournament_id uuid,description text);
CREATE TABLE fixture_provider_calls(kind text);
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_prove_played_spin_launch_recovery(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":false}'::jsonb$$;
-- These explicit stand-ins delimit provider/maintenance scope, not proof of it.
CREATE FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb,text) RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_provider_calls VALUES('alert')$$;
CREATE FUNCTION fn_apply_prize_guarantee(p_tournament_id uuid,p_source text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pool numeric;
BEGIN
 INSERT INTO fixture_provider_calls VALUES('guarantee');
 UPDATE tournaments SET prize_pool_finalized=true WHERE id=p_tournament_id RETURNING prize_pool INTO v_pool;
 RETURN jsonb_build_object('ok',true,'prize_pool',v_pool);
END$$;
