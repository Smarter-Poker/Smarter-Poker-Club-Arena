-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831133845; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Leaderboard Phase 2 release gate. Forward-only, no money movement.
--
-- This migration closes defects found during the post-publication audit:
--   * browser roles retain no direct settings/version-table write privileges;
--   * hostile JSON null/non-number prize rows fail at the server boundary;
--   * every reward path uses one fail-closed union-affiliation resolver;
--   * an operation UUID is bound to the exact publication intent;
--   * the compatibility FK honestly restricts union deletion instead of
--     declaring SET NULL while a CHECK makes NULL impossible;
--   * the production union-wallet authority helper is replayable from source.
--
-- Rollback: ship another forward migration restoring the prior function bodies.
-- Existing immutable program rows require no data rewrite.

CREATE OR REPLACE FUNCTION public.fn_union_can_manage_wallets(
  p_union_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_union_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  RETURN public.fn_is_union_overseer(p_union_id, p_user_id)
      OR EXISTS (
        SELECT 1 FROM public.club_members member
         WHERE member.club_id = p_union_id
           AND member.user_id = p_user_id
           AND member.role = 'co_owner'
           AND member.status IN ('active', 'approved')
      )
      OR EXISTS (
        SELECT 1 FROM public.union_admins admin
         WHERE admin.union_id = p_union_id
           AND admin.user_id = p_user_id
           AND COALESCE(admin.role, '') IN ('co_owner', 'admin', 'owner')
      );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_can_manage_wallets(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_can_manage_wallets(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_leaderboard_funding_union_id(p_club_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pointer_union_id uuid;
  v_membership_union_id uuid;
  v_membership_count integer;
  v_is_union boolean;
BEGIN
  SELECT club.union_id, COALESCE(club.is_union, false)
    INTO v_pointer_union_id, v_is_union
    FROM public.clubs club
   WHERE club.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  -- A union's own house club is its wallet identity. Ordinary member clubs use
  -- union_clubs as the authoritative relationship and only accept the mirror
  -- pointer when it agrees exactly.
  IF v_is_union THEN RETURN p_club_id; END IF;

  SELECT count(DISTINCT membership.union_id),
         (array_agg(DISTINCT membership.union_id))[1]
    INTO v_membership_count, v_membership_union_id
    FROM public.union_clubs membership
   WHERE membership.club_id = p_club_id;

  IF v_membership_count > 1
     OR (v_membership_count = 1
         AND v_pointer_union_id IS DISTINCT FROM v_membership_union_id)
     OR (v_membership_count = 0 AND v_pointer_union_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Conflicting Union Affiliation For Leaderboard Funding'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_membership_union_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leaderboard_funding_union_id(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_funding_union_id(uuid) TO service_role;

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
    IF jsonb_typeof(v_prize) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_prize)) <> 2
       OR NOT (v_prize ? 'rank' AND v_prize ? 'amount')
       OR jsonb_typeof(v_prize -> 'rank') <> 'number'
       OR jsonb_typeof(v_prize -> 'amount') <> 'number' THEN
      RETURN false;
    END IF;
    IF (v_prize ->> 'rank') IS NULL
       OR (v_prize ->> 'amount') IS NULL
       OR (v_prize ->> 'rank') !~ '^[0-9]+$'
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

DROP POLICY IF EXISTS club_lb_settings_write ON public.club_leaderboard_settings;
DROP POLICY IF EXISTS "Managers can manage leaderboard settings"
  ON public.club_leaderboard_settings;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.club_leaderboard_settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_reward_program_versions FROM authenticated;

ALTER TABLE public.club_leaderboard_settings
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_funding_union_id_fkey,
  ADD CONSTRAINT club_leaderboard_settings_funding_union_id_fkey
    FOREIGN KEY (funding_union_id) REFERENCES public.unions(id) ON DELETE RESTRICT;

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
  WITH manageable_clubs AS MATERIALIZED (
    SELECT
      club.id AS club_id,
      club.name AS club_name
    FROM public.clubs club
    WHERE COALESCE(club.is_union, false) = false
      AND (
        club.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.club_members member
           WHERE member.club_id = club.id
             AND member.user_id = auth.uid()
             AND member.role IN ('owner', 'co_owner')
             AND COALESCE(member.status, 'active') IN ('active', 'approved')
        )
        OR EXISTS (
          SELECT 1 FROM public.union_clubs membership
           WHERE membership.club_id = club.id
             AND public.fn_union_can_manage_wallets(membership.union_id, auth.uid())
        )
      )
  ), candidate AS MATERIALIZED (
    SELECT
      manageable.club_id,
      manageable.club_name,
      public.fn_leaderboard_funding_union_id(manageable.club_id) AS union_id
    FROM manageable_clubs manageable
  )
  SELECT
    candidate.club_id,
    candidate.club_name,
    candidate.union_id,
    union_row.name,
    CASE WHEN candidate.union_id IS NULL THEN 'club' ELSE 'union' END,
    CASE WHEN candidate.union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    settings.setup_completed_at IS NOT NULL,
    COALESCE(settings.rewards_enabled, false)
  FROM candidate
  LEFT JOIN public.unions union_row ON union_row.id = candidate.union_id
  LEFT JOIN public.club_leaderboard_settings settings ON settings.club_id = candidate.club_id
  WHERE (
    candidate.union_id IS NOT NULL
    AND public.fn_union_can_manage_wallets(candidate.union_id, auth.uid())
  ) OR (
    candidate.union_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.clubs owned
         WHERE owned.id = candidate.club_id AND owned.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.club_members member
         WHERE member.club_id = candidate.club_id
           AND member.user_id = auth.uid()
           AND member.role IN ('owner', 'co_owner')
           AND COALESCE(member.status, 'active') IN ('active', 'approved')
      )
    )
  )
  ORDER BY union_row.name NULLS LAST, candidate.club_name;
$function$;

CREATE OR REPLACE FUNCTION public.fn_publish_leaderboard_reward_program(
  p_club_id uuid,
  p_rewards_enabled boolean,
  p_metric text,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb,
  p_suggestion_key text,
  p_expected_version integer,
  p_operation_id uuid
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
  v_current_version integer;
  v_previous_id uuid;
  v_existing public.leaderboard_reward_program_versions%ROWTYPE;
  v_weekly_effective date;
  v_monthly_effective date;
  v_next_version integer;
  v_hash text;
  v_requested_hash text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'A Publication Retry Key Is Required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'A Valid Current Program Version Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id INTO v_club
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member
       WHERE member.club_id = p_club_id
         AND member.user_id = v_actor
         AND member.role IN ('owner', 'co_owner')
         AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
  END IF;
  IF NOT v_can_manage THEN
    RAISE EXCEPTION 'Only The Funding Owner Can Manage Leaderboard Rewards'
      USING ERRCODE = '42501';
  END IF;

  IF p_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Metric' USING ERRCODE = '22023';
  END IF;
  IF p_suggestion_key NOT IN ('balanced', 'top_heavy', 'even', 'custom') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Plan' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_weekly_prizes, '[]'::jsonb))
     OR NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_monthly_prizes, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Prize Rows Must Use Unique Ranks 1 Through 10 And Positive Amounts With At Most Two Decimals'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_rewards_enabled, false)
     AND jsonb_array_length(COALESCE(p_weekly_prizes, '[]'::jsonb)) = 0
     AND jsonb_array_length(COALESCE(p_monthly_prizes, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add A Weekly Or Monthly Prize Before Enabling Rewards'
      USING ERRCODE = '22023';
  END IF;

  SELECT existing.* INTO v_existing
    FROM public.leaderboard_reward_program_versions existing
   WHERE existing.club_id = p_club_id
     AND existing.operation_id = p_operation_id;
  IF v_existing.id IS NOT NULL THEN
    v_requested_hash := md5(jsonb_build_object(
      'club_id', p_club_id,
      'version', v_existing.version,
      'rewards_enabled', COALESCE(p_rewards_enabled, false),
      'payout_metric', p_metric,
      'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
      'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
      'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
      'funding_union_id', v_union_id,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from
    )::text);
    IF v_existing.program_hash <> v_requested_hash
       OR v_existing.suggestion_key <> p_suggestion_key
       OR v_existing.version <> p_expected_version + 1 THEN
      RAISE EXCEPTION 'Leaderboard Publication Retry Key Was Reused For Different Prize Rules'
        USING ERRCODE = '22023';
    END IF;
    RETURN public.fn_get_leaderboard_reward_setup(p_club_id) || jsonb_build_object(
      'rewards_enabled', v_existing.rewards_enabled,
      'payout_metric', v_existing.payout_metric,
      'weekly_prizes', v_existing.weekly_prizes,
      'monthly_prizes', v_existing.monthly_prizes,
      'suggestion_key', v_existing.suggestion_key,
      'program_version', v_existing.version,
      'program_hash', v_existing.program_hash,
      'program_status', v_existing.status,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from,
      'published_at', v_existing.published_at,
      'program_funding_owner_type', v_existing.funding_owner_type,
      'program_funding_union_id', v_existing.funding_union_id,
      'program_funding_label', CASE
        WHEN v_existing.funding_owner_type = 'union' THEN COALESCE(
          (SELECT union_row.name FROM public.unions union_row
            WHERE union_row.id = v_existing.funding_union_id),
          'Recorded Union'
        ) || ' Promo Wallet'
        ELSE (SELECT club.name FROM public.clubs club WHERE club.id = p_club_id)
             || ' Promo Wallet'
      END
    );
  END IF;

  SELECT program.version, program.id INTO v_current_version, v_previous_id
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id
   ORDER BY program.version DESC
   LIMIT 1;
  v_current_version := COALESCE(v_current_version, 0);
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Leaderboard Prize Setup Changed In Another Session'
      USING ERRCODE = '40001',
            DETAIL = format('Expected Version %s But Found Version %s',
                            p_expected_version, v_current_version);
  END IF;

  SELECT bounds.end_date INTO v_weekly_effective
    FROM public.fn_leaderboard_period_window('weekly', 0) bounds;
  SELECT bounds.end_date INTO v_monthly_effective
    FROM public.fn_leaderboard_period_window('monthly', 0) bounds;
  v_next_version := v_current_version + 1;
  v_hash := md5(jsonb_build_object(
    'club_id', p_club_id,
    'version', v_next_version,
    'rewards_enabled', COALESCE(p_rewards_enabled, false),
    'payout_metric', p_metric,
    'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_union_id', v_union_id,
    'weekly_effective_from', v_weekly_effective,
    'monthly_effective_from', v_monthly_effective
  )::text);

  INSERT INTO public.leaderboard_reward_program_versions (
    club_id, version, operation_id, rewards_enabled, payout_metric,
    weekly_prizes, monthly_prizes, suggestion_key,
    funding_owner_type, funding_union_id,
    weekly_effective_from, monthly_effective_from,
    published_by, supersedes_program_id, program_hash
  ) VALUES (
    p_club_id, v_next_version, p_operation_id, COALESCE(p_rewards_enabled, false), p_metric,
    COALESCE(p_weekly_prizes, '[]'::jsonb), COALESCE(p_monthly_prizes, '[]'::jsonb),
    p_suggestion_key, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    v_weekly_effective, v_monthly_effective, v_actor, v_previous_id, v_hash
  );

  INSERT INTO public.club_leaderboard_settings (
    club_id, payout_currency, weekly_prizes, monthly_prizes,
    rewards_enabled, payout_metric, funding_owner_type, funding_union_id,
    suggestion_key, setup_completed_at, setup_completed_by, updated_by, updated_at
  ) VALUES (
    p_club_id, 'chips', COALESCE(p_weekly_prizes, '[]'::jsonb),
    COALESCE(p_monthly_prizes, '[]'::jsonb), COALESCE(p_rewards_enabled, false),
    p_metric, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    p_suggestion_key, now(), v_actor, v_actor, now()
  )
  ON CONFLICT (club_id) DO UPDATE SET
    payout_currency = EXCLUDED.payout_currency,
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
  v_program public.leaderboard_reward_program_versions%ROWTYPE;
  v_program_union_name text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501'; END IF;
  SELECT club.id, club.name, club.owner_id, club.promo_balance INTO v_club
    FROM public.clubs club WHERE club.id = p_club_id;
  IF v_club.id IS NULL THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;

  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  SELECT EXISTS (
    SELECT 1 FROM public.club_members member WHERE member.club_id = p_club_id
      AND member.user_id = v_actor
      AND COALESCE(member.status, 'active') IN ('active', 'approved')
  ) INTO v_is_member;
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
    SELECT union_row.name,
           CASE WHEN v_can_manage THEN COALESCE(wallet.promo_wallet, 0) ELSE NULL END
      INTO v_union_name, v_balance
      FROM public.unions union_row
      LEFT JOIN public.union_wallets wallet ON wallet.union_id = union_row.id
     WHERE union_row.id = v_union_id;
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member WHERE member.club_id = p_club_id
        AND member.user_id = v_actor AND member.role IN ('owner', 'co_owner')
        AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
    IF v_can_manage THEN v_balance := COALESCE(v_club.promo_balance, 0); END IF;
  END IF;
  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Reward Setup Is Not Available For This Club'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings FROM public.club_leaderboard_settings settings
   WHERE settings.club_id = p_club_id;
  SELECT * INTO v_program FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id ORDER BY program.version DESC LIMIT 1;
  IF v_program.funding_owner_type = 'union' THEN
    SELECT union_row.name INTO v_program_union_name FROM public.unions union_row
     WHERE union_row.id = v_program.funding_union_id;
  END IF;

  RETURN jsonb_build_object(
    'club_id', p_club_id, 'club_name', v_club.name,
    'union_id', v_union_id, 'union_name', v_union_name,
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_source', CASE WHEN v_union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    'funding_label', CASE WHEN v_union_id IS NULL THEN v_club.name || ' Promo Wallet' ELSE v_union_name || ' Promo Wallet' END,
    'available_balance', CASE WHEN v_can_manage THEN v_balance ELSE NULL END,
    'can_manage', v_can_manage,
    'setup_complete', v_settings.setup_completed_at IS NOT NULL,
    'rewards_enabled', COALESCE(v_program.rewards_enabled, v_settings.rewards_enabled, false),
    'payout_currency', 'chips',
    'payout_metric', COALESCE(v_program.payout_metric, v_settings.payout_metric, 'profit'),
    'weekly_prizes', COALESCE(v_program.weekly_prizes, v_settings.weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(v_program.monthly_prizes, v_settings.monthly_prizes, '[]'::jsonb),
    'suggestion_key', COALESCE(v_program.suggestion_key, v_settings.suggestion_key, 'balanced'),
    'program_version', COALESCE(v_program.version, 0),
    'program_hash', v_program.program_hash,
    'program_status', CASE WHEN v_program.id IS NULL THEN 'not_published' ELSE 'published' END,
    'weekly_effective_from', v_program.weekly_effective_from,
    'monthly_effective_from', v_program.monthly_effective_from,
    'published_at', v_program.published_at,
    'program_funding_owner_type', v_program.funding_owner_type,
    'program_funding_union_id', v_program.funding_union_id,
    'program_funding_label', CASE
      WHEN v_program.id IS NULL THEN NULL
      WHEN v_program.funding_owner_type = 'union'
        THEN COALESCE(v_program_union_name, 'Recorded Union') || ' Promo Wallet'
      ELSE v_club.name || ' Promo Wallet'
    END,
    'setup_completed_at', v_settings.setup_completed_at,
    'updated_at', COALESCE(v_program.published_at, v_settings.updated_at)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leaderboard_prizes_are_valid(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_prizes_are_valid(jsonb)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_leaderboard_reward_contexts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_reward_contexts()
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_leaderboard_funding_union_id(uuid) IS
  'Fail-closed canonical funding affiliation resolver for leaderboard reward programs.';

