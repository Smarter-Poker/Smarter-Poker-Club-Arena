
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
-- auth.role() is the other half of the Supabase auth surface the functions
-- this probe replays actually use, and it was missing here until 2026-09-23
-- (issue #5008). It went unnoticed because this repo's newest copy of those
-- functions was stale: production has been running bodies that call
-- auth.role() since 2026-09-17 and supabase/migrations had no file for them,
-- so the probe was replaying an older atomic_distribute_rake than the one
-- production runs. NULL is what a direct connection sees in production too,
-- so COALESCE(auth.role(),'service_role') takes the engine path, which is the
-- path this probe drives. A test that wants a browser caller sets test.role,
-- exactly as the other fixtures set test.actor for auth.uid().
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
  $$SELECT nullif(current_setting('test.role', true), '')$$;
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(), performed_by uuid,from_type text,from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,amount numeric CHECK(amount>0),category text,club_id uuid,union_id uuid,table_id uuid,hand_id uuid,tournament_id uuid,description text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,idempotency_key text UNIQUE,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE ca_ledger_write_failures(club_id uuid,user_id uuid,delta numeric,sqlstate text,message text);
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,union_id uuid,chip_treasury numeric DEFAULT 100,total_rake numeric DEFAULT 0,updated_at timestamptz,asset text NOT NULL DEFAULT 'chips',is_union boolean);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY,club_id uuid,main_balance numeric DEFAULT 100,backup_balance numeric DEFAULT 10,promo_balance numeric DEFAULT 5);
CREATE TABLE club_members(id uuid PRIMARY KEY,user_id uuid,club_id uuid,chip_balance numeric DEFAULT 100);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,min_buy_in numeric,max_buy_in numeric,is_private boolean DEFAULT true,union_id uuid,tournament_id uuid,is_template boolean DEFAULT false,current_players integer DEFAULT 0,updated_at timestamptz DEFAULT now());
CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number int,stack numeric,is_sitting_out boolean,left_at timestamptz,id uuid DEFAULT gen_random_uuid(),joined_at timestamptz DEFAULT now(),club_id uuid,status text DEFAULT 'active',is_away boolean DEFAULT false,leave_pending boolean DEFAULT false,scheduled_leave_hands integer DEFAULT 0,sit_out_at timestamptz,occupancy_id uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(table_id,user_id),UNIQUE(table_id,seat_number));
CREATE TABLE chip_transactions(id uuid,club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,balance_after numeric,created_at timestamptz);
CREATE TABLE cash_baselines(user_id uuid,table_id uuid,amount numeric);
CREATE TABLE engine_maintenance_break(
 id boolean PRIMARY KEY DEFAULT true,
 phase text NOT NULL,
 announced_at timestamptz NOT NULL,
 break_ends_at timestamptz,
 enforce_freeze boolean NOT NULL DEFAULT true
);
CREATE TABLE entry_purchase_idempotency_receipts(
 key_domain text NOT NULL,
 idempotency_key text NOT NULL,
 request jsonb NOT NULL,
 response jsonb,
 claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 completed_at timestamptz,
 CONSTRAINT entry_purchase_idempotency_receipts_pkey
  PRIMARY KEY(key_domain,idempotency_key),
 CONSTRAINT entry_purchase_idempotency_receipts_domain_nonempty
  CHECK (length(btrim(key_domain)) > 0),
 CONSTRAINT entry_purchase_idempotency_receipts_key_nonempty
  CHECK (length(btrim(idempotency_key)) > 0)
);
CREATE FUNCTION fn_actor_can_manage_club_treasury(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_cash_rejoin_floor(uuid,uuid) RETURNS numeric LANGUAGE sql AS 'SELECT NULL::numeric';
CREATE FUNCTION fn_cash_session_open(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE FUNCTION fn_cash_session_add_baseline(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE TABLE hand_history(id uuid,table_id uuid,hand_number int,started_at timestamptz,created_at timestamptz);
CREATE TABLE tournaments(id uuid,is_private boolean,union_id uuid,status text,prize_pool_finalized boolean,current_level integer,late_reg_levels integer,rebuy_levels integer,late_reg_mins integer,started_at timestamptz,max_players integer);
CREATE TABLE tournament_players(id uuid DEFAULT gen_random_uuid(), tournament_id uuid,user_id uuid,username text,chips numeric,status text,is_satellite_qualifier boolean,source_satellite_id uuid,current_bounty numeric DEFAULT 0,UNIQUE(tournament_id,user_id));
CREATE TABLE rake_records(id uuid DEFAULT gen_random_uuid(),hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,bbj_contribution numeric,pot_size numeric,num_players int,player_contributions jsonb,is_tournament boolean,tournament_id uuid,source text,metadata jsonb,rake_method text,returned_uncalled jsonb,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX rake_hand ON rake_records(hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE rake_distribution_legs(leg_key uuid,leg text,club_id uuid,union_id uuid,amount numeric,UNIQUE(leg_key,leg));
CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,chip_balance numeric DEFAULT 0,period_rake_collected numeric DEFAULT 0,period_bbj_contribution numeric DEFAULT 0,lifetime_rake_collected numeric DEFAULT 0,lifetime_bbj_contribution numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE club_wallet_transactions(club_id uuid,type text,amount numeric,balance_after numeric,related_id uuid,reason text);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric,rake_wallet numeric,total_rake_collected numeric,updated_at timestamptz);
CREATE TABLE union_wallet_transactions(union_id uuid,club_id uuid,amount numeric,tx_type text,wallet text,direction text,balance_after numeric,notes text);
CREATE FUNCTION injected_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fault text:=current_setting('test.journal_sqlstate',true);
BEGIN
 IF COALESCE(fault,'')<>'' THEN RAISE EXCEPTION 'injected journal failure' USING ERRCODE=fault; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fault BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION injected_journal_failure();

-- Journal-only fixtures omit escrow; test_satellite_split.py exercises the real escrow.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN RETURN; END; $function$;
-- The union weekly accounting activation (migration 20260917181100) is the
-- authority for these two; their real DDL, with its foreign keys and check
-- constraints, is in that file. Here they are bare stand-ins like every other
-- table in this fixture, because this probe is about the chip journal and not
-- about accounting referential integrity. The closure that reaches them grew
-- from 23 functions to 27 when that migration's file was recorded; without
-- them the replayed atomic_distribute_rake cannot be created.
CREATE TABLE accounting_cash_bank_receipts(rake_record_id uuid PRIMARY KEY,union_id uuid,club_id uuid,union_transaction_id uuid UNIQUE,club_ledger_id uuid UNIQUE,banked_at timestamptz,amount numeric);
CREATE TABLE accounting_routed_settlement_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz,round_no integer,routing_version integer DEFAULT 3,source_fingerprint text,result jsonb,completed_at timestamptz DEFAULT clock_timestamp(),scope_kind text GENERATED ALWAYS AS(CASE WHEN union_id IS NULL THEN 'club'::text ELSE 'union'::text END) STORED,scope_id uuid GENERATED ALWAYS AS(COALESCE(union_id,standalone_club_id)) STORED,PRIMARY KEY(scope_kind,scope_id,period_start,period_end,round_no));
