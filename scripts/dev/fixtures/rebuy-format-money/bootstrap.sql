-- Minimal schema for the rebuy x format chip-purchase money probe.
--
-- Only the objects public.fn_ca_process_tournament_chip_purchase_money_v1
-- actually reads or writes. Every function body under test is the byte-exact
-- production capture in installed.sql; the stubs below are the neighbours the
-- money core only PERFORMs (wallet provisioning, the felt conservation guard,
-- the funding ledger) or never reaches on a chip event (the Diamond charge).
\set ON_ERROR_STOP on

CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text,
  club_id uuid,
  status text NOT NULL DEFAULT 'RUNNING',
  variant text,
  tournament_type text NOT NULL DEFAULT 'MTT',
  buy_in_amount numeric,
  buy_in_fee numeric,
  starting_chips integer,
  is_rebuy boolean DEFAULT false,
  is_reentry boolean DEFAULT false,
  add_on_available boolean DEFAULT false,
  addon_period_triggered boolean DEFAULT false,
  rebuy_cost numeric,
  rebuy_chips integer,
  rebuy_levels integer,
  late_reg_levels integer,
  max_rebuys integer,
  max_reentries integer,
  addon_cost numeric,
  addon_chips integer,
  addon_levels integer,
  current_level integer DEFAULT 0,
  prize_pool numeric DEFAULT 0,
  bounty_pool numeric DEFAULT 0,
  total_rake numeric DEFAULT 0,
  is_bounty boolean DEFAULT false,
  is_pko boolean DEFAULT false,
  is_mystery_bounty boolean DEFAULT false,
  bounty_amount numeric
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id),
  status text NOT NULL DEFAULT 'running'
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  club_id uuid,
  table_id uuid,
  chips integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'playing',
  prize numeric DEFAULT 0,
  rebuys integer DEFAULT 0,
  add_on boolean DEFAULT false,
  eliminated_at timestamptz,
  position integer,
  current_bounty numeric DEFAULT 0,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid,
  seat_number integer,
  stack numeric,
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz
);

CREATE TABLE public.club_members (
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  chip_balance numeric NOT NULL DEFAULT 0,
  updated_at timestamptz,
  PRIMARY KEY (user_id, club_id)
);

CREATE TABLE public.wallet_credit_idempotency (
  key text PRIMARY KEY,
  user_id uuid,
  amount numeric
);

CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  wallet_type text,
  type text,
  amount numeric,
  category text,
  description text,
  related_entity_id uuid,
  balance_after numeric
);

CREATE TABLE public.rake_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id uuid,
  table_id uuid,
  club_id uuid,
  rake_amount numeric,
  pot_size numeric,
  num_players integer,
  bbj_contribution numeric,
  is_tournament boolean,
  tournament_id uuid,
  source text,
  metadata jsonb
);

CREATE SCHEMA probe;
CREATE TABLE probe.funding (
  participant_id uuid,
  kind text,
  key text,
  amount numeric,
  asset text
);

-- A chip event. The Diamond branch is a separate product and is not under test.
CREATE FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 1 $$;
CREATE FUNCTION public.fn_poker_diamond_tournament_charge(
  uuid, uuid, text, numeric, numeric, numeric, numeric, uuid, text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'probe: a chip event never takes the Diamond charge';
END $$;
CREATE FUNCTION public.fn_ensure_club_wallet(uuid, uuid)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
-- The felt conservation guard is its own authority with its own probes.
CREATE FUNCTION public.fn_ca_assert_tournament_chip_grant(uuid, uuid, uuid, numeric, text)
RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_ca_record_tournament_participant_funding(
  p_participant_id uuid, p_kind text, p_key text, p_amount numeric, p_asset text,
  p_entitlement uuid, p_wallet uuid, p_diamond jsonb)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO probe.funding VALUES (p_participant_id, p_kind, p_key, p_amount, p_asset)
$$;
