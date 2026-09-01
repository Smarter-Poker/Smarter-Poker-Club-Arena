-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828165535; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_sched_state jsonb NULL,
  ADD COLUMN IF NOT EXISTS bomb_pot_manual_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bomb_pot_button_policy text NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS bomb_pot_announce_seconds integer NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tables_bomb_pot_button_policy_check'
  ) THEN
    ALTER TABLE public.tables
      ADD CONSTRAINT tables_bomb_pot_button_policy_check
      CHECK (bomb_pot_button_policy IN ('regular', 'separate'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bomb_pot_award_units (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hand_history_id uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  pot_index integer NOT NULL,
  board smallint NOT NULL,
  side text NOT NULL DEFAULT 'high',
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  hand_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bomb_pot_award_units_side_check CHECK (side IN ('high', 'low')),
  CONSTRAINT bomb_pot_award_units_idem
    UNIQUE (hand_history_id, pot_index, board, side, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bomb_pot_award_units_table_created
  ON public.bomb_pot_award_units (table_id, created_at DESC);

ALTER TABLE public.bomb_pot_award_units ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bomb_pot_award_units'
      AND policyname = 'bomb_pot_award_units_read'
  ) THEN
    CREATE POLICY bomb_pot_award_units_read ON public.bomb_pot_award_units
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bomb_pot_manual_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id uuid NOT NULL,
  club_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bomb_pot_manual_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_request_manual_bomb_pot(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_enabled boolean;
  v_role text;
  v_is_owner boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT club_id, bomb_pot_enabled INTO v_club, v_enabled
  FROM public.tables WHERE id = p_table_id;

  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bomb_pots_disabled');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.owner_id = v_uid)
    INTO v_is_owner;
  SELECT lower(cm.role) INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = v_club AND cm.user_id = v_uid
  LIMIT 1;

  IF NOT (v_is_owner OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  UPDATE public.tables SET bomb_pot_manual_pending = true WHERE id = p_table_id;
  INSERT INTO public.bomb_pot_manual_requests (table_id, club_id, requested_by)
  VALUES (p_table_id, v_club, v_uid);

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'get_club_home' AND n.nspname = 'public';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home not found';
  END IF;

  IF v_def LIKE '%bomb_pot_ante_multiplier%' THEN
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    'bomb_pot_interval_seconds, bomb_pot_variant,',
    'bomb_pot_interval_seconds, bomb_pot_variant, bomb_pot_ante_multiplier, bomb_pot_ante_fixed,'
  );

  IF v_def NOT LIKE '%bomb_pot_ante_multiplier%' THEN
    RAISE EXCEPTION 'get_club_home tables SELECT has been reshaped — splice point not found; extend it by hand';
  END IF;

  EXECUTE v_def;
END $$;

CREATE OR REPLACE VIEW public.v_bomb_pot_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  bomb_pot->>'trigger_reason' AS trigger_reason,
  (bomb_pot->>'board_count')::int AS board_count,
  bomb_pot->>'variant' AS variant,
  count(*) AS hands,
  round(avg(pot_size::numeric), 2) AS avg_pot,
  round(sum(rake_amount::numeric), 2) AS total_rake,
  round(avg((bomb_pot->>'ante_amount')::numeric), 2) AS avg_ante
FROM public.hand_history
WHERE bomb_pot IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2, 3, 4;

CREATE OR REPLACE VIEW public.v_bomb_pot_vs_normal AS
SELECT
  date_trunc('day', created_at) AS day,
  (bomb_pot IS NOT NULL) AS is_bomb,
  count(*) AS hands,
  round(avg(pot_size::numeric), 2) AS avg_pot
FROM public.hand_history
WHERE created_at > now() - interval '7 days'
GROUP BY 1, 2;

CREATE OR REPLACE VIEW public.v_bomb_pot_outcomes AS
SELECT
  day,
  count(*) AS multi_board_hands,
  count(*) FILTER (WHERE distinct_winners = 1) AS full_scoops,
  count(*) FILTER (WHERE distinct_winners > 1) AS split_hands,
  round(avg(award_units), 2) AS avg_award_units
FROM (
  SELECT
    hand_history_id,
    date_trunc('day', min(created_at)) AS day,
    count(DISTINCT user_id) AS distinct_winners,
    count(*) AS award_units
  FROM public.bomb_pot_award_units
  GROUP BY hand_history_id
) per_hand
GROUP BY day;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_sched_state' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_sched_state missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bomb_pot_award_units'
  ) THEN
    RAISE EXCEPTION 'assertion failed: bomb_pot_award_units missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fn_request_manual_bomb_pot' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_request_manual_bomb_pot missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_club_home' AND n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%bomb_pot_ante_multiplier%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: get_club_home does not return the ante columns';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'v_bomb_pot_daily'
  ) THEN
    RAISE EXCEPTION 'assertion failed: v_bomb_pot_daily missing';
  END IF;
END $$;
