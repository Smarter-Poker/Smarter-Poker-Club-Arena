-- Leaderboard reward setup, authority, and funding-source truth.
--
-- This migration deliberately DOES NOT move chips. The live
-- fn_payout_leaderboard overload credited winners without debiting the union
-- promo wallet or a standalone club's promo balance. Automating a replacement
-- before a canonical batch transfer primitive exists would be a new money
-- path, so the unsafe function is retired and this migration is limited to
-- configuration, permission checks, and read-only funding visibility.
--
-- Forward-only and additive data changes:
--   * Adds setup metadata to the existing, empty settings table.
--   * Adds two read RPCs and one validated save RPC.
--   * Removes direct browser writes so every save derives authority and source.
--   * Revokes the unsafe payout RPC from browser roles.
--
-- Rollback (schema only; do not restore the unsafe payout body):
--   DROP FUNCTION public.fn_save_leaderboard_reward_setup(uuid,boolean,text,jsonb,jsonb,text);
--   DROP FUNCTION public.fn_get_leaderboard_reward_setup(uuid);
--   DROP FUNCTION public.fn_leaderboard_reward_contexts();
--   ALTER TABLE public.club_leaderboard_settings DROP COLUMN ... for the
--   columns below, then restore club_lb_settings_write if direct writes are
--   intentionally re-authorized.

ALTER TABLE public.club_leaderboard_settings
  ADD COLUMN IF NOT EXISTS rewards_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payout_metric text NOT NULL DEFAULT 'profit',
  ADD COLUMN IF NOT EXISTS funding_owner_type text NOT NULL DEFAULT 'club',
  ADD COLUMN IF NOT EXISTS funding_union_id uuid REFERENCES public.unions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suggestion_key text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS setup_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS setup_completed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.club_leaderboard_settings
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_payout_metric_check,
  ADD CONSTRAINT club_leaderboard_settings_payout_metric_check
    CHECK (payout_metric IN ('profit', 'hands_played', 'tournaments_won', 'roi')),
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_funding_owner_type_check,
  ADD CONSTRAINT club_leaderboard_settings_funding_owner_type_check
    CHECK (funding_owner_type IN ('union', 'club')),
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_suggestion_key_check,
  ADD CONSTRAINT club_leaderboard_settings_suggestion_key_check
    CHECK (suggestion_key IN ('balanced', 'top_heavy', 'even', 'custom')),
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_funding_scope_check,
  ADD CONSTRAINT club_leaderboard_settings_funding_scope_check
    CHECK (
      (funding_owner_type = 'union' AND funding_union_id IS NOT NULL)
      OR (funding_owner_type = 'club' AND funding_union_id IS NULL)
    );

CREATE OR REPLACE FUNCTION public.fn_leaderboard_prizes_are_valid(p_prizes jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prizes jsonb := COALESCE(p_prizes, '[]'::jsonb);
  v_prize jsonb;
  v_rank integer;
  v_amount numeric;
  v_seen_ranks integer[] := ARRAY[]::integer[];
BEGIN
  IF jsonb_typeof(v_prizes) <> 'array' OR jsonb_array_length(v_prizes) > 10 THEN
    RETURN false;
  END IF;

  FOR v_prize IN SELECT value FROM jsonb_array_elements(v_prizes)
  LOOP
    IF jsonb_typeof(v_prize) <> 'object' OR NOT (v_prize ? 'rank' AND v_prize ? 'amount') THEN
      RETURN false;
    END IF;
    IF (v_prize ->> 'rank') !~ '^[0-9]+$'
       OR length(v_prize ->> 'rank') > 2
       OR (v_prize ->> 'amount') !~ '^[0-9]+([.][0-9]{1,2})?$'
       OR length(v_prize ->> 'amount') > 20 THEN
      RETURN false;
    END IF;

    v_rank := (v_prize ->> 'rank')::integer;
    v_amount := (v_prize ->> 'amount')::numeric;
    IF v_rank NOT BETWEEN 1 AND 10
       OR v_amount <= 0
       OR v_amount > 1000000000
       OR v_rank = ANY(v_seen_ranks) THEN
      RETURN false;
    END IF;
    v_seen_ranks := array_append(v_seen_ranks, v_rank);
  END LOOP;

  RETURN true;
END;
$function$;

ALTER TABLE public.club_leaderboard_settings
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_weekly_prizes_check,
  ADD CONSTRAINT club_leaderboard_settings_weekly_prizes_check
    CHECK (public.fn_leaderboard_prizes_are_valid(weekly_prizes)),
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_monthly_prizes_check,
  ADD CONSTRAINT club_leaderboard_settings_monthly_prizes_check
    CHECK (public.fn_leaderboard_prizes_are_valid(monthly_prizes));

DROP POLICY IF EXISTS club_lb_settings_write ON public.club_leaderboard_settings;

CREATE OR REPLACE FUNCTION public.fn_leaderboard_reward_contexts()
RETURNS TABLE(
  club_id uuid,
  club_name text,
  union_id uuid,
  union_name text,
  funding_owner_type text,
  funding_source text,
  setup_complete boolean,
  rewards_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH candidate AS (
    SELECT
      c.id AS club_id,
      c.name AS club_name,
      COALESCE(c.union_id, uc.union_id) AS union_id,
      ROW_NUMBER() OVER (
        PARTITION BY c.id
        ORDER BY (c.union_id IS NOT NULL) DESC, uc.joined_at DESC NULLS LAST
      ) AS preference
    FROM public.clubs c
    LEFT JOIN public.union_clubs uc ON uc.club_id = c.id
    WHERE COALESCE(c.is_union, false) = false
  )
  SELECT
    candidate.club_id,
    candidate.club_name,
    candidate.union_id,
    u.name AS union_name,
    CASE WHEN candidate.union_id IS NULL THEN 'club' ELSE 'union' END,
    CASE WHEN candidate.union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    (s.setup_completed_at IS NOT NULL),
    COALESCE(s.rewards_enabled, false)
  FROM candidate
  LEFT JOIN public.unions u ON u.id = candidate.union_id
  LEFT JOIN public.club_leaderboard_settings s ON s.club_id = candidate.club_id
  WHERE candidate.preference = 1
    AND (
      (
        candidate.union_id IS NOT NULL
        AND public.fn_union_can_manage_wallets(candidate.union_id, auth.uid())
      )
      OR (
        candidate.union_id IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM public.clubs owned
            WHERE owned.id = candidate.club_id AND owned.owner_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.club_members cm
            WHERE cm.club_id = candidate.club_id
              AND cm.user_id = auth.uid()
              AND cm.role IN ('owner', 'co_owner')
              AND COALESCE(cm.status, 'active') IN ('active', 'approved')
          )
        )
      )
    )
  ORDER BY u.name NULLS LAST, candidate.club_name;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_reward_setup(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_union_id uuid;
  v_union_name text;
  v_can_manage boolean := false;
  v_is_member boolean := false;
  v_balance numeric;
  v_settings public.club_leaderboard_settings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.name, c.owner_id, c.union_id, c.promo_balance
    INTO v_club
    FROM public.clubs c
   WHERE c.id = p_club_id;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  v_union_id := v_club.union_id;
  IF v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id
      FROM public.union_clubs uc
     WHERE uc.club_id = p_club_id
     ORDER BY uc.joined_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
    WHERE cm.club_id = p_club_id
      AND cm.user_id = v_actor
      AND COALESCE(cm.status, 'active') IN ('active', 'approved')
  ) INTO v_is_member;

  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
    SELECT u.name, CASE WHEN v_can_manage THEN COALESCE(uw.promo_wallet, 0) ELSE NULL END
      INTO v_union_name, v_balance
      FROM public.unions u
      LEFT JOIN public.union_wallets uw ON uw.union_id = u.id
     WHERE u.id = v_union_id;
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id
        AND cm.user_id = v_actor
        AND cm.role IN ('owner', 'co_owner')
        AND COALESCE(cm.status, 'active') IN ('active', 'approved')
    );
    IF v_can_manage THEN v_balance := COALESCE(v_club.promo_balance, 0); END IF;
  END IF;

  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Reward Setup Is Not Available For This Club'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings
    FROM public.club_leaderboard_settings s
   WHERE s.club_id = p_club_id;

  RETURN jsonb_build_object(
    'club_id', p_club_id,
    'club_name', v_club.name,
    'union_id', v_union_id,
    'union_name', v_union_name,
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_source', CASE WHEN v_union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    'funding_label', CASE WHEN v_union_id IS NULL THEN v_club.name || ' Promo Wallet' ELSE v_union_name || ' Promo Wallet' END,
    'available_balance', CASE WHEN v_can_manage THEN v_balance ELSE NULL END,
    'can_manage', v_can_manage,
    'setup_complete', v_settings.setup_completed_at IS NOT NULL,
    'rewards_enabled', COALESCE(v_settings.rewards_enabled, false),
    'payout_currency', 'chips',
    'payout_metric', COALESCE(v_settings.payout_metric, 'profit'),
    'weekly_prizes', COALESCE(v_settings.weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(v_settings.monthly_prizes, '[]'::jsonb),
    'suggestion_key', COALESCE(v_settings.suggestion_key, 'balanced'),
    'setup_completed_at', v_settings.setup_completed_at,
    'updated_at', v_settings.updated_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_save_leaderboard_reward_setup(
  p_club_id uuid,
  p_rewards_enabled boolean,
  p_metric text,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb,
  p_suggestion_key text DEFAULT 'custom'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_union_id uuid;
  v_can_manage boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.owner_id, c.union_id INTO v_club
    FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  v_union_id := v_club.union_id;
  IF v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id
      FROM public.union_clubs uc
     WHERE uc.club_id = p_club_id
     ORDER BY uc.joined_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id
        AND cm.user_id = v_actor
        AND cm.role IN ('owner', 'co_owner')
        AND COALESCE(cm.status, 'active') IN ('active', 'approved')
    );
  END IF;

  IF NOT v_can_manage THEN
    RAISE EXCEPTION 'Only The Funding Owner Can Manage Leaderboard Rewards'
      USING ERRCODE = '42501';
  END IF;
  IF p_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Metric';
  END IF;
  IF p_suggestion_key NOT IN ('balanced', 'top_heavy', 'even', 'custom') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Plan';
  END IF;
  IF NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_weekly_prizes, '[]'::jsonb))
     OR NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_monthly_prizes, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Prize Rows Must Use Unique Ranks 1 Through 10 And Positive Amounts With At Most Two Decimals';
  END IF;
  IF COALESCE(p_rewards_enabled, false)
     AND jsonb_array_length(COALESCE(p_weekly_prizes, '[]'::jsonb)) = 0
     AND jsonb_array_length(COALESCE(p_monthly_prizes, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add A Weekly Or Monthly Prize Before Enabling Rewards';
  END IF;

  INSERT INTO public.club_leaderboard_settings (
    club_id, payout_currency, weekly_prizes, monthly_prizes,
    rewards_enabled, payout_metric, funding_owner_type, funding_union_id,
    suggestion_key, setup_completed_at, setup_completed_by, updated_by, updated_at
  ) VALUES (
    p_club_id, 'chips', COALESCE(p_weekly_prizes, '[]'::jsonb), COALESCE(p_monthly_prizes, '[]'::jsonb),
    COALESCE(p_rewards_enabled, false), p_metric,
    CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    p_suggestion_key, now(), v_actor, v_actor, now()
  )
  ON CONFLICT (club_id) DO UPDATE SET
    payout_currency = 'chips',
    weekly_prizes = EXCLUDED.weekly_prizes,
    monthly_prizes = EXCLUDED.monthly_prizes,
    rewards_enabled = EXCLUDED.rewards_enabled,
    payout_metric = EXCLUDED.payout_metric,
    funding_owner_type = EXCLUDED.funding_owner_type,
    funding_union_id = EXCLUDED.funding_union_id,
    suggestion_key = EXCLUDED.suggestion_key,
    setup_completed_at = COALESCE(public.club_leaderboard_settings.setup_completed_at, now()),
    setup_completed_by = COALESCE(public.club_leaderboard_settings.setup_completed_by, v_actor),
    updated_by = v_actor,
    updated_at = now();

  RETURN public.fn_get_leaderboard_reward_setup(p_club_id);
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_payout_leaderboard(uuid, text, text, date, date);

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'Automated Leaderboard Payouts Are Paused Until A Canonical Promo Wallet Batch Transfer Is Available'
    USING ERRCODE = '0A000';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leaderboard_prizes_are_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_prizes_are_valid(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_leaderboard_reward_contexts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_reward_contexts() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_save_leaderboard_reward_setup(uuid, boolean, text, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_save_leaderboard_reward_setup(uuid, boolean, text, jsonb, jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  IS 'Retired safety barrier: legacy payout did not debit the union or standalone club promo source.';
