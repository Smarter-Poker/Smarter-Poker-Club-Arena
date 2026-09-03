-- =====================================================================
-- 20260821_ca_player_class_hands.sql
-- Tier 2: one new function. No DROP, no ALTER, no data change.
--
-- Drill-down for the 13x13 starting-hand grid: the individual hands
-- behind one cell.
--
-- WHY THIS FILE EXISTS SEPARATELY: the function was first applied
-- directly against production while the grid drill-down was being
-- built, which left it live but absent from the migration history.
-- CLAUDE.md RULE 2 requires schema to be reproducible from
-- supabase/migrations alone - without this file, a rebuild from
-- migrations would silently lose the function and the drill-down would
-- degrade to "no hands stored" (StatsFactsService.callRpc swallows the
-- error into its fallback, so it would fail quietly rather than
-- loudly). CREATE OR REPLACE, so re-applying over the live copy is a
-- no-op.
--
-- SECURITY: reads ca_hand_facts, which holds hole cards that NEVER went
-- to showdown. SECURITY DEFINER bypasses RLS, so the very first
-- statement asserts the caller is the subject. Do not relax this.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ca_player_class_hands(
  p_user       uuid,
  p_hand_class text,
  p_position   text DEFAULT NULL,
  p_variant    text DEFAULT NULL,
  p_days       int  DEFAULT NULL,
  p_limit      int  DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  -- Bounded server-side as well as client-side: a client is free to ask
  -- for a million rows, and this table is retained indefinitely.
  v_cap    int := least(greatest(coalesce(p_limit, 20), 1), 100);
BEGIN
  PERFORM public.ca_assert_self(p_user);

  IF p_hand_class IS NULL OR btrim(p_hand_class) = '' THEN
    RETURN jsonb_build_object('hands', '[]'::jsonb, 'hand_class', NULL);
  END IF;

  SELECT jsonb_build_object(
    'hand_class', p_hand_class,
    'hands', coalesce((
      SELECT jsonb_agg(h ORDER BY (h->>'played_at') DESC)
      FROM (
        SELECT jsonb_build_object(
          'hand_id',    f.hand_id,
          'played_at',  f.played_at,
          'position',   f.position,
          'net',        round(f.net, 2),
          'net_bb',     round(f.net_bb, 2),
          'big_blind',  f.big_blind,
          'variant',    f.game_variant,
          'was_all_in', f.was_all_in,
          'showdown',   f.went_to_showdown,
          'won',        (f.net > 0),
          'hole_cards', f.hole_cards
        ) AS h
        FROM public.ca_hand_facts f
        WHERE f.user_id = p_user
          AND f.hand_class = p_hand_class
          AND (p_position IS NULL OR f.position = p_position)
          AND (p_variant  IS NULL OR f.game_variant = p_variant)
          AND (p_days     IS NULL OR f.played_at >= now() - make_interval(days => p_days))
        ORDER BY f.played_at DESC
        LIMIT v_cap
      ) sub
    ), '[]'::jsonb),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.ca_player_class_hands(uuid, text, text, text, int, int)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Post-apply assertions
-- ---------------------------------------------------------------------
DO $$
DECLARE v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ca_player_class_hands';

  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_player_class_hands was not created.';
  END IF;

  -- The identity gate only matters because this is DEFINER. If it ever
  -- stops being DEFINER the RLS policy takes over and the assertion is
  -- redundant, but silently flipping between the two is how a leak
  -- happens, so pin it.
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_player_class_hands is not SECURITY DEFINER.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ca_assert_self'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_assert_self missing - the identity gate this function calls does not exist.';
  END IF;

  RAISE NOTICE 'ca_player_class_hands installed and gated.';
END $$;
