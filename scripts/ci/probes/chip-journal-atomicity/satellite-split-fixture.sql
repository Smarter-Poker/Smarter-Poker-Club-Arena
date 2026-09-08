ALTER TABLE tournaments ADD PRIMARY KEY(id), ADD name text, ADD club_id uuid, ADD buy_in_amount numeric, ADD buy_in_fee numeric, ADD current_players integer DEFAULT 0,
 ADD prize_pool numeric DEFAULT 0, ADD total_rake numeric DEFAULT 0, ADD tournament_type text,
 ADD bounty_amount numeric DEFAULT 0, ADD bounty_pool numeric DEFAULT 0, ADD is_bounty boolean DEFAULT false,
 ADD is_pko boolean DEFAULT false, ADD is_mystery_bounty boolean DEFAULT false,
 ADD variant text, ADD is_premium_spin boolean DEFAULT false;
CREATE TABLE profiles(id uuid,display_name text,username text);
CREATE TABLE tournament_payouts(id uuid DEFAULT gen_random_uuid(),tournament_id uuid,user_id uuid,position integer,amount numeric,source text,idempotency_key text UNIQUE,paid_at timestamptz,tournament_type text,field_size integer,prize_pool numeric,recorded_by text,metadata jsonb);
CREATE TABLE financial_alerts(severity text,source text,message text,context jsonb,resolved boolean);
CREATE TABLE wallet_transactions(related_entity_id uuid,type text,category text,amount numeric);
CREATE TABLE tournament_guarantee_overlays(tournament_id uuid,amount numeric);
CREATE TABLE tournament_rake_settlements(tournament_id uuid,amount numeric,settled_at timestamptz);
CREATE TABLE spin_reserve_ledger(tournament_id uuid,amount numeric,kind text);
CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY,enforced boolean DEFAULT true,
 gross_in numeric DEFAULT 0,fee_entries_in numeric DEFAULT 0,satellite_fee_in numeric DEFAULT 0,
 bounty_in numeric DEFAULT 0,overlay_in numeric DEFAULT 0,satellite_in numeric DEFAULT 0,
 prize_out numeric DEFAULT 0,bounty_out numeric DEFAULT 0,fee_out numeric DEFAULT 0,
 refund_prize numeric DEFAULT 0,refund_bounty numeric DEFAULT 0,refund_fee numeric DEFAULT 0,
 reserve_out numeric DEFAULT 0,reserve_in numeric DEFAULT 0,prize_balance numeric DEFAULT 0,
 bounty_balance numeric DEFAULT 0,fee_balance numeric DEFAULT 0,opened_from text,updated_at timestamptz);
