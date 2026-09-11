-- The minimum schema the knockout door, the standings normalizer and the place
-- prepare read and write, with production's column types, constraints and the
-- two roster triggers that decide what an elimination is. Nothing here is a
-- copy of production data. The functions themselves are loaded from
-- installed.sql, which is a byte-exact capture of the live bodies.
\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$roles$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'probe',
  variant text,
  buy_in_amount numeric NOT NULL DEFAULT 1,
  guaranteed_prize numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'RUNNING',
  current_players integer DEFAULT 0,
  payout_structure text DEFAULT 'Standard',
  club_id uuid,
  prize_pool numeric DEFAULT 0,
  tournament_type text DEFAULT 'MTT',
  is_bounty boolean DEFAULT false,
  is_pko boolean DEFAULT false,
  is_mystery_bounty boolean DEFAULT false,
  spin_multiplier numeric DEFAULT 0,
  is_premium_spin boolean DEFAULT false,
  prize_pool_finalized boolean DEFAULT false,
  satellite_target uuid,
  satellite_target_id uuid,
  bubble_protection boolean NOT NULL DEFAULT false
);

CREATE SEQUENCE public.tournament_player_elimination_sequence;

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  username text,
  chips integer DEFAULT 0,
  status text DEFAULT 'registered',
  position integer,
  prize numeric DEFAULT 0,
  rebuys integer DEFAULT 0,
  eliminated_at timestamptz,
  club_id uuid,
  rebuy_prompt_until timestamptz,
  elimination_sequence bigint,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'probe',
  tournament_id uuid,
  current_players integer DEFAULT 0
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  seat_number integer NOT NULL,
  user_id uuid,
  stack numeric DEFAULT 0,
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz,
  status text DEFAULT 'active'
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  seat_joined_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  stack_before numeric NOT NULL CHECK (stack_before > 0),
  stack_after numeric NOT NULL CHECK (stack_after = 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state = ANY (ARRAY['pending', 'rebought', 'eliminated', 'winner'])),
  rebuy_prompt_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
  UNIQUE (tournament_id, hand_number, eliminated_user_id)
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL UNIQUE CHECK (hand_number >= 1000000),
  hand_id uuid NOT NULL UNIQUE,
  payload_hash text NOT NULL DEFAULT repeat('0', 64) CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  stack_result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_flight',
  result jsonb,
  completed_at timestamptz,
  PRIMARY KEY (table_id, hand_id)
);

CREATE TABLE public.chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type text NOT NULL,
  from_entity_id uuid,
  to_type text NOT NULL,
  to_entity_id uuid,
  amount numeric NOT NULL,
  category text NOT NULL,
  tournament_id uuid,
  status text NOT NULL DEFAULT 'posted',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tournament_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  position integer,
  amount numeric NOT NULL DEFAULT 0,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE
);

CREATE TABLE public.tournament_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  kind text NOT NULL,
  place integer,
  user_id uuid,
  amount_owed numeric NOT NULL DEFAULT 0 CHECK (amount_owed >= 0),
  amount_paid numeric NOT NULL DEFAULT 0,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (amount_paid >= 0 AND amount_paid <= amount_owed),
  CHECK (place IS NOT NULL OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_tournament_obligations_place
  ON public.tournament_obligations (tournament_id, kind, place) WHERE place IS NOT NULL;
CREATE UNIQUE INDEX ux_tournament_obligations_user
  ON public.tournament_obligations (tournament_id, kind, user_id) WHERE place IS NULL;

CREATE TABLE public.tournament_place_settlement_batches (
  tournament_id uuid PRIMARY KEY,
  mode text NOT NULL DEFAULT 'structure',
  plan_fingerprint text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  place_count integer NOT NULL,
  amount_owed numeric NOT NULL,
  escrow_required numeric NOT NULL,
  escrow_available numeric NOT NULL,
  bubble_contract_required boolean NOT NULL DEFAULT false,
  bubble_obligation_id uuid,
  bubble_user_id uuid,
  bubble_source text,
  bubble_amount_owed numeric NOT NULL DEFAULT 0,
  bubble_amount_paid_before numeric NOT NULL DEFAULT 0,
  source text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE public.tournament_escrow (
  tournament_id uuid PRIMARY KEY,
  enforced boolean NOT NULL DEFAULT true,
  prize_balance numeric NOT NULL DEFAULT 0
);

CREATE TABLE public.spin_payout_ladder (
  multiplier numeric PRIMARY KEY,
  structure jsonb NOT NULL
);
INSERT INTO public.spin_payout_ladder (multiplier, structure) VALUES
  (2, '[{"place": 1, "percentage": 100}]'),
  (10, '[{"place": 1, "percentage": 80}, {"place": 2, "percentage": 20}]'),
  (25, '[{"place": 1, "percentage": 80}, {"place": 2, "percentage": 12}, {"place": 3, "percentage": 8}]');

-- The seat-first player-count mirror is not what these probes are about.
CREATE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
