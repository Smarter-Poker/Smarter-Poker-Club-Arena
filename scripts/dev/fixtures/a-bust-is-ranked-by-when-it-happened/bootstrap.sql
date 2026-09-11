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

-- ---------------------------------------------------------------------------
-- The place settlement and the bounty door (2026-09-11, second pass). The
-- columns and tables they read, with production's types and constraints.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tournaments
  ADD COLUMN bounty_amount numeric DEFAULT 0,
  ADD COLUMN bounty_pool numeric NOT NULL DEFAULT 0,
  ADD COLUMN mystery_bounty_stage text NOT NULL DEFAULT 'pending',
  ADD COLUMN mystery_bounty_activation_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN started_at timestamptz;
ALTER TABLE public.tournament_players
  ADD COLUMN current_bounty numeric DEFAULT 0;

CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  table_id uuid,
  tournament_id uuid,
  hand_number integer,
  players jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE public.tournament_bounty_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  settlement_completed_at timestamptz NOT NULL,
  seat_joined_at timestamptz NOT NULL,
  position integer NOT NULL CHECK (position >= 2),
  prize numeric NOT NULL CHECK (prize >= 0),
  bubble_refund numeric NOT NULL DEFAULT 0 CHECK (bubble_refund >= 0),
  mode text NOT NULL CHECK (mode = ANY (ARRAY['regular', 'pko', 'mystery_pre', 'mystery_chest'])),
  activation_generation bigint NOT NULL DEFAULT 0 CHECK (activation_generation >= 0),
  head_amount numeric NOT NULL CHECK (head_amount > 0),
  knocker_user_id uuid NOT NULL,
  claimants jsonb NOT NULL CHECK (jsonb_typeof(claimants) = 'array'),
  state text NOT NULL DEFAULT 'pending' CHECK (state = ANY (ARRAY['pending', 'settled'])),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((mode = 'mystery_chest' AND activation_generation > 0)
         OR (mode <> 'mystery_chest' AND activation_generation = 0)),
  UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
  UNIQUE (tournament_id, hand_number, eliminated_user_id)
);

CREATE TABLE public.tournament_pko_settlement_watermarks (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  last_settled_hand_number bigint NOT NULL CHECK (last_settled_hand_number >= 1000000),
  last_obligation_id uuid NOT NULL REFERENCES public.tournament_bounty_obligations(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tournament_mystery_activation_receipts (
  tournament_id uuid NOT NULL,
  activation_generation bigint NOT NULL,
  activated_at timestamptz NOT NULL,
  chest_count integer NOT NULL,
  pool_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL CHECK (severity = ANY (ARRAY['critical', 'warning', 'info'])),
  source text NOT NULL,
  message text NOT NULL,
  context jsonb DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.wallet_credit_idempotency (
  key text PRIMARY KEY,
  user_id uuid,
  amount numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- TEST DOUBLES. These stand in for money authorities the settlement calls;
-- they are what these probes are NOT about, and none of them is md5-pinned.
-- The one global settlement lane.
CREATE FUNCTION public.fn_ca_lock_settlement_lane_global()
RETURNS void LANGUAGE sql AS $$ SELECT $$;
-- Guarantee funding: finalize the pool at no less than the guarantee.
CREATE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pool numeric;
BEGIN
  UPDATE public.tournaments
     SET prize_pool = GREATEST(prize_pool, COALESCE(guaranteed_prize, 0)),
         prize_pool_finalized = true
   WHERE id = p_tournament_id
  RETURNING prize_pool INTO v_pool;
  RETURN jsonb_build_object('ok', true, 'overlay', 0, 'prize_pool', v_pool);
END;
$$;
-- One place paid from its exact obligation, idempotently: a wallet-credit
-- identity and a payout row for whatever is still owed.
CREATE FUNCTION public.fn_ca_settle_tournament_place_raw(
  p_tournament_id uuid, p_place integer, p_user_id uuid, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_ob public.tournament_obligations%ROWTYPE;
  v_due numeric;
  v_key text;
BEGIN
  SELECT * INTO v_ob FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place' AND o.place = p_place
   FOR UPDATE;
  IF NOT FOUND OR v_ob.user_id IS DISTINCT FROM p_user_id OR v_ob.amount_owed <> p_amount THEN
    RAISE EXCEPTION 'probe payer: no exact obligation for place %', p_place;
  END IF;
  v_due := v_ob.amount_owed - v_ob.amount_paid;
  IF v_due > 0 THEN
    v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':place';
    INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
    VALUES (v_key, p_user_id, v_due);
    INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source, idempotency_key)
    VALUES (p_tournament_id, p_user_id, p_place, v_due, 'structure', v_key);
    UPDATE public.tournament_obligations
       SET amount_paid = amount_owed, settled_at = now()
     WHERE id = v_ob.id;
  END IF;
  RETURN jsonb_build_object('fully_settled', true);
END;
$$;
CREATE FUNCTION public.fn_ca_settle_tournament_bubble_raw(
  p_tournament_id uuid, p_user_id uuid, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'probe: no scenario here carries Bubble Protection';
END;
$$;
-- The exact winner of the busted player's last pot: the probe names it in
-- probe.claimants.
CREATE TABLE public.probe_claimants (
  hand_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  claimants jsonb NOT NULL,
  PRIMARY KEY (hand_id, eliminated_user_id)
);
CREATE FUNCTION public.fn_exact_tournament_knockout_claimants(
  p_tournament_id uuid, p_hand_id uuid, p_eliminated_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT c.claimants FROM public.probe_claimants c
   WHERE c.hand_id = p_hand_id AND c.eliminated_user_id = p_eliminated_user_id;
$$;

-- What a bounty obligation's complete marker reads (the marker itself is
-- captured byte-exact in installed.sql).
CREATE TABLE public.tournament_bounties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  eliminated_player_id uuid NOT NULL,
  collector_player_id uuid NOT NULL,
  bounty_amount numeric NOT NULL,
  added_to_collector_bounty numeric DEFAULT 0,
  is_mystery_revealed boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  bounty_obligation_id uuid
);
CREATE TABLE public.tournament_bounty_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  chest_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  tier text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  op_id uuid NOT NULL,
  bounty_obligation_id uuid
);
CREATE TABLE public.tournament_bounty_award_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  paid_at timestamptz
);
