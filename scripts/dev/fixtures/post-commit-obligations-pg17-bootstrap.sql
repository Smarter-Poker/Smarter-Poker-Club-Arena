\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$roles$;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL,
  tournament_id uuid,
  status text NOT NULL DEFAULT 'running'
);

CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id),
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT 30;
$function$;

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  stack numeric NOT NULL,
  status text NOT NULL DEFAULT 'seated',
  left_at timestamptz,
  time_bank_uses_remaining integer,
  time_bank_remaining integer,
  UNIQUE (table_id, seat_number)
);

CREATE TABLE public.table_pending_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  kind text NOT NULL DEFAULT 'addon',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  applied_to_stack numeric,
  refunded numeric
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL UNIQUE,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.hand_projection_outbox (
  hand_id uuid PRIMARY KEY REFERENCES public.hand_atomic_commits(hand_id),
  hand_number bigint NOT NULL
);

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  union_id uuid
);

CREATE TABLE public.bbj_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  union_id uuid,
  main_balance numeric NOT NULL DEFAULT 0,
  backup_balance numeric NOT NULL DEFAULT 0,
  promo_balance numeric NOT NULL DEFAULT 0,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.probe_rake_receipts (
  hand_id uuid PRIMARY KEY,
  amount numeric NOT NULL
);

CREATE TABLE public.probe_promo_balances (
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  wagered numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE public.probe_bbj_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id uuid NOT NULL UNIQUE,
  amount numeric NOT NULL
);

CREATE TABLE public.insurance_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  club_id uuid NOT NULL,
  hand_number integer NOT NULL,
  player_id uuid NOT NULL,
  equity_percent numeric NOT NULL,
  premium numeric NOT NULL,
  insured_amount numeric NOT NULL,
  payout numeric NOT NULL,
  player_won boolean NOT NULL,
  kind varchar(16) NOT NULL,
  UNIQUE (table_id, hand_number, player_id)
);

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_hand_id uuid;
BEGIN
  SELECT c.hand_id INTO v_hand_id
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'atomic_hand_commit', true,
      'history_id', v_hand_id,
      'replay', true
    );
  END IF;

  v_hand_id := gen_random_uuid();
  INSERT INTO public.hand_atomic_commits(table_id, hand_number, hand_id)
  VALUES (p_table_id, p_hand_number, v_hand_id);
  INSERT INTO public.hand_projection_outbox(hand_id, hand_number)
  VALUES (v_hand_id, p_hand_number);

  RETURN jsonb_build_object(
    'success', true,
    'atomic_hand_commit', true,
    'history_id', v_hand_id,
    'replay', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(
  p_table_id uuid,
  p_club_id uuid,
  p_hand_id uuid,
  p_hand_number integer,
  p_rake numeric,
  p_bbj numeric DEFAULT 0,
  p_pot numeric DEFAULT NULL,
  p_num_players integer DEFAULT NULL,
  p_contributions jsonb DEFAULT NULL,
  p_tournament_id uuid DEFAULT NULL,
  p_returned_uncalled jsonb DEFAULT NULL,
  p_rake_method text DEFAULT 'DEALT_EQUAL'
) RETURNS TABLE(applied boolean, already_processed boolean, rake_record_id uuid)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.probe_rake_receipts(hand_id, amount)
  VALUES (p_hand_id, p_rake)
  ON CONFLICT (hand_id) DO NOTHING;
  IF FOUND THEN
    RETURN QUERY SELECT true, false, v_id;
  ELSE
    RETURN QUERY SELECT false, true, p_hand_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(
  p_club_id uuid,
  p_user_id uuid,
  p_wagered numeric
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('probe.fail_promo', true) = 'on' THEN
    RAISE EXCEPTION 'probe promo failure';
  END IF;
  INSERT INTO public.probe_promo_balances(club_id, user_id, wagered)
  VALUES (p_club_id, p_user_id, p_wagered)
  ON CONFLICT (club_id, user_id) DO UPDATE
    SET wagered = probe_promo_balances.wagered + EXCLUDED.wagered;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bbj_record_contribution(
  p_pool_id uuid,
  p_hand_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_main_portion numeric DEFAULT 0,
  p_backup_portion numeric DEFAULT 0,
  p_promo_portion numeric DEFAULT 0,
  p_big_blind numeric DEFAULT 2,
  p_hand_number integer DEFAULT NULL,
  p_club_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.probe_bbj_receipts(hand_id, amount)
  VALUES (p_hand_id, p_amount)
  ON CONFLICT (hand_id) DO UPDATE SET amount = probe_bbj_receipts.amount
  RETURNING probe_bbj_receipts.id INTO v_id;
  RETURN QUERY SELECT v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_insurance_transaction(
  p_table_id uuid,
  p_club_id uuid,
  p_hand_number integer,
  p_player_id uuid,
  p_equity_percent numeric,
  p_premium numeric,
  p_insured_amount numeric,
  p_payout numeric,
  p_player_won boolean,
  p_kind varchar DEFAULT 'insurance'
) RETURNS public.insurance_transactions
LANGUAGE plpgsql
AS $function$
DECLARE
  v_row public.insurance_transactions%ROWTYPE;
BEGIN
  INSERT INTO public.insurance_transactions(
    table_id, club_id, hand_number, player_id, equity_percent,
    premium, insured_amount, payout, player_won, kind
  ) VALUES (
    p_table_id, p_club_id, p_hand_number, p_player_id, p_equity_percent,
    p_premium, p_insured_amount, p_payout, p_player_won, p_kind
  )
  ON CONFLICT (table_id, hand_number, player_id) DO NOTHING
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.insurance_transactions
     WHERE table_id = p_table_id
       AND hand_number = p_hand_number
       AND player_id = p_player_id;
  END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_pending_addon(
  p_pending_id uuid,
  p_max_buy_in numeric DEFAULT NULL
) RETURNS TABLE(applied numeric, refunded numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_addon public.table_pending_addons%ROWTYPE;
  v_stack numeric;
  v_applied numeric;
BEGIN
  SELECT * INTO STRICT v_addon
    FROM public.table_pending_addons
   WHERE id = p_pending_id
     AND resolved_at IS NULL
   FOR UPDATE;
  SELECT stack INTO STRICT v_stack
    FROM public.table_seats
   WHERE table_id = v_addon.table_id
     AND user_id = v_addon.user_id
     AND left_at IS NULL
   FOR UPDATE;
  v_applied := least(v_addon.amount, greatest(p_max_buy_in - v_stack, 0));
  UPDATE public.table_seats
     SET stack = stack + v_applied
   WHERE table_id = v_addon.table_id
     AND user_id = v_addon.user_id
     AND left_at IS NULL;
  UPDATE public.table_pending_addons
     SET resolved_at = clock_timestamp(),
         applied_to_stack = v_applied,
         refunded = v_addon.amount - v_applied
   WHERE id = p_pending_id;
  RETURN QUERY SELECT v_applied, v_addon.amount - v_applied;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects(
  p_hand_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  DELETE FROM public.hand_projection_outbox WHERE hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending');
  END IF;
  RETURN jsonb_build_object('ok', true, 'hand_id', p_hand_id);
END;
$function$;
