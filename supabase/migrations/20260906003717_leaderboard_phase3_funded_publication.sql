-- LEADERBOARD PHASE 3: FUNDED PUBLICATION.
--
-- Before this migration, reward-program publication validated authority,
-- idempotency, versions, and prize-row shape, but never checked the Promo
-- Wallet. One union could therefore publish more weekly and monthly promises
-- across its clubs than its shared Promo Wallet held. The client warned that a
-- plan was unfunded and still let the owner publish it.
--
-- This migration adds derived, rolling funding commitments. One enabled
-- program commits the sum of its weekly and monthly prize rows. Only the latest
-- immutable version for each club counts, so publishing a replacement releases
-- that club's previous commitment without mutating history. Union commitments
-- aggregate across every club using the same recorded union funding owner;
-- standalone commitments remain isolated to their club.
--
-- The insert trigger is the authority. It locks the canonical funding wallet,
-- calculates every other club's latest commitment, and rejects an unfunded
-- version before either the immutable program or compatibility settings row is
-- written. The summary function supplies owner telemetry and is not browser
-- callable. No chip balance moves in this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_leaderboard_program_commitment(
  p_rewards_enabled boolean,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN COALESCE(p_rewards_enabled, false) THEN
    COALESCE((
      SELECT sum((prize ->> 'amount')::numeric)
      FROM jsonb_array_elements(COALESCE(p_weekly_prizes, '[]'::jsonb)) prize
    ), 0)
    + COALESCE((
      SELECT sum((prize ->> 'amount')::numeric)
      FROM jsonb_array_elements(COALESCE(p_monthly_prizes, '[]'::jsonb)) prize
    ), 0)
  ELSE 0 END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_leaderboard_funding_summary(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_union_id uuid;
  v_owner_type text;
  v_balance numeric := 0;
  v_total numeric := 0;
  v_current numeric := 0;
  v_other numeric := 0;
  v_committed_clubs integer := 0;
  v_current_exists boolean := false;
  v_current_enabled boolean := false;
BEGIN
  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  v_owner_type := CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END;

  IF v_owner_type = 'union' THEN
    SELECT COALESCE(wallet.promo_wallet, 0)
      INTO v_balance
      FROM public.union_wallets wallet
     WHERE wallet.union_id = v_union_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Leaderboard Funding Union Has No Promo Wallet'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT COALESCE(club.promo_balance, 0)
      INTO v_balance
      FROM public.clubs club
     WHERE club.id = p_club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (program.club_id)
      program.club_id,
      program.rewards_enabled,
      program.weekly_prizes,
      program.monthly_prizes,
      program.funding_owner_type,
      program.funding_union_id
    FROM public.leaderboard_reward_program_versions program
    ORDER BY program.club_id, program.version DESC
  ), scoped AS (
    SELECT
      latest.club_id,
      latest.rewards_enabled,
      public.fn_leaderboard_program_commitment(
        latest.rewards_enabled,
        latest.weekly_prizes,
        latest.monthly_prizes
      ) AS commitment
    FROM latest
    WHERE (
      v_owner_type = 'union'
      AND latest.funding_owner_type = 'union'
      AND latest.funding_union_id = v_union_id
    ) OR (
      v_owner_type = 'club'
      AND latest.funding_owner_type = 'club'
      AND latest.club_id = p_club_id
    )
  )
  SELECT
    COALESCE(sum(scoped.commitment), 0),
    COALESCE(sum(scoped.commitment) FILTER (WHERE scoped.club_id = p_club_id), 0),
    count(*) FILTER (WHERE scoped.rewards_enabled),
    COALESCE(bool_or(scoped.club_id = p_club_id), false),
    COALESCE(bool_or(scoped.club_id = p_club_id AND scoped.rewards_enabled), false)
  INTO v_total, v_current, v_committed_clubs, v_current_exists, v_current_enabled
  FROM scoped;

  v_other := GREATEST(v_total - v_current, 0);
  RETURN jsonb_build_object(
    'funding_owner_type', v_owner_type,
    'funding_union_id', v_union_id,
    'wallet_balance', round(v_balance, 2),
    'committed_balance', round(v_total, 2),
    'current_program_commitment', round(v_current, 2),
    'other_program_commitments', round(v_other, 2),
    'publication_capacity', round(GREATEST(v_balance - v_other, 0), 2),
    'available_uncommitted_balance', round(GREATEST(v_balance - v_total, 0), 2),
    'committed_club_count', v_committed_clubs,
    'funding_status', CASE
      WHEN NOT v_current_exists THEN 'not_published'
      WHEN NOT v_current_enabled THEN 'disabled'
      WHEN v_balance >= v_total THEN 'funded'
      ELSE 'underfunded'
    END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_leaderboard_program_funding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric := 0;
  v_other_commitments numeric := 0;
  v_requested_commitment numeric := 0;
BEGIN
  v_requested_commitment := public.fn_leaderboard_program_commitment(
    NEW.rewards_enabled,
    NEW.weekly_prizes,
    NEW.monthly_prizes
  );

  IF NOT NEW.rewards_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.funding_owner_type = 'union' THEN
    IF NEW.funding_union_id IS NULL THEN
      RAISE EXCEPTION 'A Union-Funded Leaderboard Requires A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(wallet.promo_wallet, 0)
      INTO v_balance
      FROM public.union_wallets wallet
     WHERE wallet.union_id = NEW.funding_union_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Leaderboard Funding Union Has No Promo Wallet'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.funding_owner_type = 'club' THEN
    IF NEW.funding_union_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Standalone Club Leaderboard Cannot Name A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(club.promo_balance, 0)
      INTO v_balance
      FROM public.clubs club
     WHERE club.id = NEW.club_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    RAISE EXCEPTION 'Leaderboard Funding Owner Must Be A Union Or Club'
      USING ERRCODE = '23514';
  END IF;

  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (program.club_id)
      program.club_id,
      program.rewards_enabled,
      program.weekly_prizes,
      program.monthly_prizes,
      program.funding_owner_type,
      program.funding_union_id
    FROM public.leaderboard_reward_program_versions program
    WHERE program.club_id <> NEW.club_id
    ORDER BY program.club_id, program.version DESC
  )
  SELECT COALESCE(sum(public.fn_leaderboard_program_commitment(
    latest.rewards_enabled,
    latest.weekly_prizes,
    latest.monthly_prizes
  )), 0)
  INTO v_other_commitments
  FROM latest
  WHERE NEW.funding_owner_type = 'union'
    AND latest.funding_owner_type = 'union'
    AND latest.funding_union_id = NEW.funding_union_id;

  IF v_requested_commitment + v_other_commitments > v_balance THEN
    RAISE EXCEPTION
      'Leaderboard Prize Program Requires % Promo Chips But Only % Are Available After Other Published Commitments',
      round(v_requested_commitment, 2),
      round(GREATEST(v_balance - v_other_commitments, 0), 2)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS leaderboard_program_funding_gate
  ON public.leaderboard_reward_program_versions;
CREATE TRIGGER leaderboard_program_funding_gate
BEFORE INSERT ON public.leaderboard_reward_program_versions
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_leaderboard_program_funding();

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
  v_settings public.club_leaderboard_settings%ROWTYPE;
  v_program public.leaderboard_reward_program_versions%ROWTYPE;
  v_program_union_name text;
  v_funding jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501'; END IF;
  SELECT club.id, club.name, club.owner_id INTO v_club
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
    SELECT union_row.name INTO v_union_name
      FROM public.unions union_row
     WHERE union_row.id = v_union_id;
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member WHERE member.club_id = p_club_id
        AND member.user_id = v_actor AND member.role IN ('owner', 'co_owner')
        AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
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
  v_funding := public.fn_leaderboard_funding_summary(p_club_id);

  RETURN jsonb_build_object(
    'club_id', p_club_id, 'club_name', v_club.name,
    'union_id', v_union_id, 'union_name', v_union_name,
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_source', CASE WHEN v_union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    'funding_label', CASE WHEN v_union_id IS NULL THEN v_club.name || ' Promo Wallet' ELSE v_union_name || ' Promo Wallet' END,
    'available_balance', CASE WHEN v_can_manage THEN v_funding -> 'publication_capacity' ELSE NULL END,
    'wallet_balance', CASE WHEN v_can_manage THEN v_funding -> 'wallet_balance' ELSE NULL END,
    'committed_balance', CASE WHEN v_can_manage THEN v_funding -> 'committed_balance' ELSE NULL END,
    'current_program_commitment', CASE WHEN v_can_manage THEN v_funding -> 'current_program_commitment' ELSE NULL END,
    'other_program_commitments', CASE WHEN v_can_manage THEN v_funding -> 'other_program_commitments' ELSE NULL END,
    'available_uncommitted_balance', CASE WHEN v_can_manage THEN v_funding -> 'available_uncommitted_balance' ELSE NULL END,
    'publication_capacity', CASE WHEN v_can_manage THEN v_funding -> 'publication_capacity' ELSE NULL END,
    'committed_club_count', CASE WHEN v_can_manage THEN v_funding -> 'committed_club_count' ELSE NULL END,
    'funding_status', v_funding ->> 'funding_status',
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

REVOKE ALL ON FUNCTION public.fn_leaderboard_program_commitment(boolean, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_program_commitment(boolean, jsonb, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_leaderboard_funding_summary(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_funding_summary(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_enforce_leaderboard_program_funding()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enforce_leaderboard_program_funding()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_leaderboard_funding_summary(uuid) IS
  'Derived rolling leaderboard commitment for the current funding owner. The latest enabled program for each club commits one weekly plus one monthly prize plan; replacement capacity excludes the requested club commitment.';
COMMENT ON TRIGGER leaderboard_program_funding_gate
  ON public.leaderboard_reward_program_versions IS
  'Locks the canonical Promo Wallet and rejects any newly published program that would make the funding owner overcommitted.';

COMMIT;
