-- Applied to production 2026-08-20 (Supabase migration
-- `challenge_catalog_is_single_source_of_truth`). Recorded here so a fresh
-- branch database reproduces it.
--
-- The client kept its OWN copy of every challenge's name, description,
-- requirement and rewards and rendered from that copy, while the server paid
-- from daily_challenge_catalog. Two copies of the same numbers drift, and drift
-- here is not cosmetic: it is a card promising 7 diamonds beside a balance that
-- received 3. It had already bitten once -- ids were added to the client pool
-- that the catalog had never heard of, and claim_daily_challenge rejected every
-- one of them, so those challenges were unclaimable by construction.
--
-- The catalog now owns everything the card displays.

ALTER TABLE public.daily_challenge_catalog
  ADD COLUMN IF NOT EXISTS name        text,
  ADD COLUMN IF NOT EXISTS description text;

-- Values are generated from src/services/DailyChallengeService.ts, not retyped.
-- (Population UPDATE omitted here; it is data, and the NOT NULL assertion below
-- fails loudly on any environment where it did not run.)

DO $$
DECLARE v_missing int;
BEGIN
  SELECT count(*) INTO v_missing FROM public.daily_challenge_catalog
   WHERE name IS NULL OR btrim(name) = '' OR description IS NULL OR btrim(description) = '';
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'ABORT: % catalog rows have no name/description. Populate them before this migration; a card with a blank title is worse than no card.', v_missing;
  END IF;
END $$;

ALTER TABLE public.daily_challenge_catalog
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN description SET NOT NULL;

-- One round trip for the whole page. The client previously needed up to SIX
-- calls to paint /challenges (a SELECT plus a possible assign RPC per tier).
-- The INNER JOIN to the catalog is load-bearing twice over: it makes the shown
-- reward BY CONSTRUCTION the one claim_daily_challenge will pay, and it hides
-- any row whose challenge_id the catalog does not know rather than rendering it
-- as a blank card the player can never claim.
CREATE OR REPLACE FUNCTION public.get_or_assign_challenges(
  p_daily_key text, p_daily_ids text[],
  p_weekly_key text, p_weekly_ids text[],
  p_monthly_key text, p_monthly_ids text[]
)
RETURNS TABLE (
  id uuid, challenge_id text, assigned_date text, progress integer,
  completed boolean, claimed boolean, completed_at timestamptz,
  name text, description text, challenge_type text,
  requirement integer, chip_reward numeric, diamond_reward integer, tier text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- assign_user_challenges is already idempotent and already validates every id
  -- against the catalog and the period-key shape. Reuse it rather than
  -- reimplementing those checks here, where they would drift.
  PERFORM public.assign_user_challenges(p_daily_key,   p_daily_ids);
  PERFORM public.assign_user_challenges(p_weekly_key,  p_weekly_ids);
  PERFORM public.assign_user_challenges(p_monthly_key, p_monthly_ids);

  RETURN QUERY
  SELECT u.id, u.challenge_id, u.assigned_date, COALESCE(u.progress, 0),
         COALESCE(u.completed, false), COALESCE(u.claimed, false), u.completed_at,
         c.name, c.description, c.challenge_type, c.requirement,
         COALESCE(c.chip_reward, 0), COALESCE(c.diamond_reward, 0), c.tier
    FROM public.user_daily_challenges u
    JOIN public.daily_challenge_catalog c ON c.id = u.challenge_id
   WHERE u.user_id = v_uid
     AND u.assigned_date IN (p_daily_key, p_weekly_key, p_monthly_key);
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[]) TO authenticated, service_role;
