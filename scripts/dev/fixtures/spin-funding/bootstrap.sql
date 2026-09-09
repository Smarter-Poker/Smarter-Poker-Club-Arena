
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,chip_treasury numeric NOT NULL DEFAULT 1000);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid,buy_in_amount numeric,variant text DEFAULT 'spin',is_premium_spin boolean DEFAULT false,spin_multiplier numeric,status text DEFAULT 'REGISTERING',created_at timestamptz DEFAULT now());
CREATE TABLE public.spin_bonus_pools(club_id uuid PRIMARY KEY,balance numeric,highest_stake numeric DEFAULT 1,total_deposited numeric DEFAULT 0,total_drawn numeric DEFAULT 0,spin_count int DEFAULT 0,bonus_count int DEFAULT 0,seeded_amount numeric DEFAULT 0,seed_source_wallet text,owner_kind text DEFAULT 'club',required_seed_at_activation numeric DEFAULT 0,seed_returned_amount numeric DEFAULT 0,seed_returned_at timestamptz,updated_at timestamptz DEFAULT now());
CREATE TABLE public.spin_reserve_ledger(id bigserial PRIMARY KEY,club_id uuid,tournament_id uuid,kind text,amount numeric,balance_after numeric,multiplier numeric,buy_in numeric,seats int,house_rake numeric,note text,created_at timestamptz DEFAULT now());
CREATE TABLE public.rake_records(hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,pot_size numeric,num_players int,bbj_contribution numeric,is_tournament boolean,tournament_id uuid,source text,metadata jsonb);
CREATE TABLE public.chip_ledger(category text CONSTRAINT chip_ledger_category_check CHECK(category IN ('spin_prize','spin_entry','refund','treasury_transfer')),from_type text CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('prize_liability','spin_reserve')));
CREATE TABLE public.tournament_escrow(tournament_id uuid PRIMARY KEY,enforced boolean DEFAULT true,gross_in numeric DEFAULT 0,fee_entries_in numeric DEFAULT 0,satellite_fee_in numeric DEFAULT 0,bounty_in numeric DEFAULT 0,overlay_in numeric DEFAULT 0,satellite_in numeric DEFAULT 0,prize_out numeric DEFAULT 0,bounty_out numeric DEFAULT 0,fee_out numeric DEFAULT 0,refund_prize numeric DEFAULT 0,refund_bounty numeric DEFAULT 0,refund_fee numeric DEFAULT 0,reserve_out numeric DEFAULT 0,reserve_in numeric DEFAULT 0,prize_balance numeric DEFAULT 0,bounty_balance numeric DEFAULT 0,fee_balance numeric DEFAULT 0,opened_from text,updated_at timestamptz DEFAULT now());
-- Ownership is controlled to one standalone club. The draw, settlement,
-- shortfall trigger, escrow mutation and ledger declaration are exact installed bodies.
CREATE FUNCTION public.fn_spin_reserve_pool(p_club_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_club_id $$;
CREATE FUNCTION public.fn_spin_move_owner_wallet(uuid,text,text,numeric) RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Unexpected seed repayment in an unseeded-pool fixture'; END $$;
