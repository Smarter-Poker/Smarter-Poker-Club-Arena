-- Immutable, period-bound leaderboard reward programs.                    2026-08-31
--
-- Phase 1 gave rankings, history and prize lookups one canonical UTC period.
-- The prize wizard still overwrote one mutable settings row, however. That
-- allowed a mid-period edit to rewrite the advertised prizes, offered no
-- durable answer to "which rules applied", and let two owner sessions silently
-- overwrite each other. This forward-only EXPAND migration adds the immutable
-- publication record without removing the compatibility settings projection.
--
-- This migration MOVES NO MONEY. The retired payout barrier remains in place.
-- A later settlement phase must prove promo-wallet debits, credits, ledgers,
-- conservation, idempotency and partial-failure recovery independently.
--
-- Rollback: ship a new forward migration that revokes the publish/resolver
-- functions and stops client use. Published audit rows are intentionally not
-- deletable or editable.

CREATE TABLE IF NOT EXISTS public.leaderboard_reward_program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Raw owner identifiers are retained even if the operational club/union or
  -- publishing profile is later removed. Foreign-key cascades and an
  -- append-only trigger are incompatible: a normal club deletion would be
  -- blocked by the audit table. The publication remains self-contained.
  club_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  operation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'published' CHECK (status = 'published'),
  rewards_enabled boolean NOT NULL,
  payout_currency text NOT NULL DEFAULT 'chips' CHECK (payout_currency = 'chips'),
  payout_metric text NOT NULL
    CHECK (payout_metric IN ('profit', 'hands_played', 'tournaments_won', 'roi')),
  weekly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (public.fn_leaderboard_prizes_are_valid(weekly_prizes)),
  monthly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (public.fn_leaderboard_prizes_are_valid(monthly_prizes)),
  suggestion_key text NOT NULL
    CHECK (suggestion_key IN ('balanced', 'top_heavy', 'even', 'custom')),
  funding_owner_type text NOT NULL CHECK (funding_owner_type IN ('union', 'club')),
  funding_union_id uuid,
  weekly_effective_from date NOT NULL,
  monthly_effective_from date NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  supersedes_program_id uuid REFERENCES public.leaderboard_reward_program_versions(id)
    ON DELETE RESTRICT,
  program_hash text NOT NULL CHECK (program_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT leaderboard_reward_program_funding_scope CHECK (
    (funding_owner_type = 'union' AND funding_union_id IS NOT NULL)
    OR (funding_owner_type = 'club' AND funding_union_id IS NULL)
  ),
  CONSTRAINT leaderboard_reward_program_enabled_prizes CHECK (
    NOT rewards_enabled
    OR jsonb_array_length(weekly_prizes) > 0
    OR jsonb_array_length(monthly_prizes) > 0
  ),
  UNIQUE (club_id, version),
  UNIQUE (club_id, operation_id)
);

ALTER TABLE public.leaderboard_reward_program_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Leaderboard Reward Programs Are Public After Publication"
  ON public.leaderboard_reward_program_versions;
CREATE POLICY "Leaderboard Reward Programs Are Public After Publication"
  ON public.leaderboard_reward_program_versions
  FOR SELECT TO authenticated
  USING (status = 'published');

CREATE OR REPLACE FUNCTION public.leaderboard_reward_program_versions_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'Published Leaderboard Reward Programs Are Immutable'
    USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS leaderboard_reward_program_versions_are_immutable
  ON public.leaderboard_reward_program_versions;
CREATE TRIGGER leaderboard_reward_program_versions_are_immutable
BEFORE UPDATE OR DELETE ON public.leaderboard_reward_program_versions
FOR EACH ROW EXECUTE FUNCTION public.leaderboard_reward_program_versions_are_immutable();

REVOKE ALL ON TABLE public.leaderboard_reward_program_versions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.leaderboard_reward_program_versions TO authenticated, service_role;

-- Resolve the exact published contract for a period start. A disabled version
-- is a real published rule and therefore participates in resolution; filtering
-- it out would resurrect an older paid plan after an owner disables rewards.
CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_reward_plan(
  p_club_id uuid,
  p_period text,
  p_period_start date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_start date := p_period_start;
  v_program public.leaderboard_reward_program_versions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'Only Weekly And Monthly Reward Programs Are Supported'
      USING ERRCODE = '22023';
  END IF;
  IF v_period_start IS NULL THEN
    SELECT bounds.start_date INTO v_period_start
      FROM public.fn_leaderboard_period_window(p_period, 0) bounds;
  END IF;
  IF (p_period = 'weekly' AND EXTRACT(DOW FROM v_period_start)::integer <> 0)
     OR (p_period = 'monthly' AND EXTRACT(DAY FROM v_period_start)::integer <> 1) THEN
    RAISE EXCEPTION 'Reward Programs Require A Canonical UTC Period Start'
      USING ERRCODE = '22023';
  END IF;

  SELECT program.* INTO v_program
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id
     AND CASE p_period
       WHEN 'weekly' THEN program.weekly_effective_from <= v_period_start
       ELSE program.monthly_effective_from <= v_period_start
     END
   ORDER BY program.version DESC
   LIMIT 1;

  IF v_program.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'program_id', v_program.id,
    'program_version', v_program.version,
    'program_hash', v_program.program_hash,
    'status', v_program.status,
    'rewards_enabled', v_program.rewards_enabled,
    'period', p_period,
    'period_start', v_period_start,
    'payout_metric', v_program.payout_metric,
    'prizes', CASE p_period
      WHEN 'weekly' THEN v_program.weekly_prizes
      ELSE v_program.monthly_prizes
    END,
    'funding_owner_type', v_program.funding_owner_type,
    'funding_union_id', v_program.funding_union_id,
    'published_at', v_program.published_at
  );
END;
$function$;

-- Replace the mutable six-argument writer. Keeping the old overload would let
-- an out-of-date client bypass version checks and the caller-owned retry key.
REVOKE ALL ON FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text
) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text
);

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

  -- Idempotent retry wins before the optimistic-version comparison. If the
  -- first response was lost, the same intent returns the already-published row.
  SELECT existing.* INTO v_existing
    FROM public.leaderboard_reward_program_versions existing
   WHERE existing.club_id = p_club_id
     AND existing.operation_id = p_operation_id;
  IF v_existing.id IS NOT NULL THEN
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
          (SELECT u.name FROM public.unions u WHERE u.id = v_existing.funding_union_id),
          'Recorded Union'
        ) || ' Promo Wallet'
        ELSE (SELECT c.name FROM public.clubs c WHERE c.id = p_club_id) || ' Promo Wallet'
      END
    );
  END IF;

  SELECT program.version, program.id
    INTO v_current_version, v_previous_id
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

  -- Compatibility projection for existing UI/readers. It is no longer the
  -- canonical historical contract; every value here is copied from the new
  -- append-only version inside the same transaction.
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

-- Keep the established RPC name while its body delegates to the publication
-- contract. This minimizes the application change and leaves one server path.
CREATE OR REPLACE FUNCTION public.fn_save_leaderboard_reward_setup(
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
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_publish_leaderboard_reward_program(
    p_club_id, p_rewards_enabled, p_metric, p_weekly_prizes,
    p_monthly_prizes, p_suggestion_key, p_expected_version, p_operation_id
  );
$function$;

-- Add publication metadata to the existing owner/member setup response. The
-- funding balance remains visible only to the authorized funding manager.
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
  SELECT c.id, c.name, c.owner_id, c.union_id, c.promo_balance INTO v_club
    FROM public.clubs c WHERE c.id = p_club_id;
  IF v_club.id IS NULL THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;

  v_union_id := v_club.union_id;
  IF v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id FROM public.union_clubs uc
     WHERE uc.club_id = p_club_id ORDER BY uc.joined_at DESC NULLS LAST LIMIT 1;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm WHERE cm.club_id = p_club_id
      AND cm.user_id = v_actor AND COALESCE(cm.status, 'active') IN ('active', 'approved')
  ) INTO v_is_member;
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
    SELECT u.name, CASE WHEN v_can_manage THEN COALESCE(uw.promo_wallet, 0) ELSE NULL END
      INTO v_union_name, v_balance FROM public.unions u
      LEFT JOIN public.union_wallets uw ON uw.union_id = u.id WHERE u.id = v_union_id;
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members cm WHERE cm.club_id = p_club_id
        AND cm.user_id = v_actor AND cm.role IN ('owner', 'co_owner')
        AND COALESCE(cm.status, 'active') IN ('active', 'approved')
    );
    IF v_can_manage THEN v_balance := COALESCE(v_club.promo_balance, 0); END IF;
  END IF;
  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Reward Setup Is Not Available For This Club'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings FROM public.club_leaderboard_settings s WHERE s.club_id = p_club_id;
  SELECT * INTO v_program FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id ORDER BY program.version DESC LIMIT 1;
  IF v_program.funding_owner_type = 'union' THEN
    SELECT u.name INTO v_program_union_name FROM public.unions u
     WHERE u.id = v_program.funding_union_id;
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

REVOKE ALL ON FUNCTION public.leaderboard_reward_program_versions_are_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_plan(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_plan(uuid, text, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid
) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) TO authenticated, service_role;

COMMENT ON TABLE public.leaderboard_reward_program_versions IS
  'Append-only leaderboard prize publications. One row is the exact metric, prizes and funding owner advertised for future canonical periods.';
COMMENT ON FUNCTION public.fn_get_leaderboard_reward_plan(uuid, text, date) IS
  'Resolves the immutable published reward program for one canonical weekly or monthly period start.';
