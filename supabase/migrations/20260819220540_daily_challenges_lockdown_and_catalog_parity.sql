-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819220540 "daily_challenges_lockdown_and_catalog_parity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b59766fcce8e3b391e1fc2ce729bb2ee of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- DAILY CHALLENGES — SERVER AUTHORITY + CATALOG PARITY          Tier 3
-- ============================================================================
-- Closes an unbounded chip-minting exploit and repairs a latent unclaimable-
-- challenge bug introduced when the client pool grew from 11 to 20 entries.
--
-- EXPLOIT (live before this migration):
--   `authenticated` held INSERT + UPDATE on user_daily_challenges, and the
--   UPDATE policy had USING (auth.uid() = user_id) with NO WITH CHECK and no
--   column restriction. Any logged-in user could
--     PATCH /user_daily_challenges?id=eq.<own row> {progress: 999999, completed: true}
--   then claim. claim_daily_challenge's guard (progress >= catalog.requirement)
--   could not hold, because progress was client-writable. assigned_date is
--   free-form text, so INSERT let a user mint unlimited rows of the highest
--   paying challenge (monthly_tourneys_50 = 15,000 chips) at made-up period
--   keys and claim each one.
--
--   Second vector: increment_challenge_progress took p_requirement FROM THE
--   CLIENT and wrote completed = (progress >= p_requirement). Passing
--   p_requirement = 1 completed any challenge instantly.
--
-- FIX: the server owns assignment, progress and completion. The client may
-- only SELECT. Requirement is always read from daily_challenge_catalog.
--
-- CATALOG PARITY: the client pool gained 9 ids that were never added to
-- daily_challenge_catalog. claim_daily_challenge rejects unknown ids, so those
-- challenges would be assigned and completable but NOT claimable. Today's
-- seeded rotation contains two of them (tourney_2, hands_100). No rows exist
-- with those ids yet (verified: 0), so this lands before any player is hit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catalog parity. Values mirror CHALLENGE_POOL in
--    Smarter-Poker-Club-Arena/src/services/DailyChallengeService.ts
-- ---------------------------------------------------------------------------
INSERT INTO public.daily_challenge_catalog (id, tier, challenge_type, requirement, chip_reward) VALUES
  ('hands_15',    'daily', 'hands_played',       15,  75),
  ('hands_40',    'daily', 'hands_played',       40, 160),
  ('hands_75',    'daily', 'hands_played',       75, 300),
  ('hands_100',   'daily', 'hands_played',      100, 400),
  ('wins_7',      'daily', 'hands_won',           7, 200),
  ('wins_15',     'daily', 'hands_won',          15, 450),
  ('showdown_8',  'daily', 'showdowns',           8, 200),
  ('showdown_10', 'daily', 'showdowns',          10, 260),
  ('tourney_2',   'daily', 'tournaments_played',  2, 200)
ON CONFLICT (id) DO UPDATE
  SET tier = EXCLUDED.tier,
      challenge_type = EXCLUDED.challenge_type,
      requirement = EXCLUDED.requirement,
      chip_reward = EXCLUDED.chip_reward;

-- ---------------------------------------------------------------------------
-- 2. Server-side assignment. The client used to upsert its own rows; that is
--    what made INSERT necessary for `authenticated`. This RPC takes the period
--    key and the chosen ids, validates every id against the catalog, and caps
--    how many rows a period may hold so a caller cannot mint rows by looping.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_user_challenges(
  p_assigned_date text,
  p_challenge_ids text[]
)
RETURNS SETOF public.user_daily_challenges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_id  text;
  v_existing int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- Period key must be one of the three shapes the app generates:
  --   YYYY-MM-DD (daily) | W+YYYY-MM-DD (weekly) | M+YYYY-MM (monthly)
  -- This is what stops arbitrary free-form keys being used to mint rows.
  IF p_assigned_date !~ '^(\d{4}-\d{2}-\d{2}|W\d{4}-\d{2}-\d{2}|M\d{4}-\d{2})$' THEN
    RAISE EXCEPTION 'Invalid period key %', p_assigned_date;
  END IF;

  IF array_length(p_challenge_ids, 1) IS NULL OR array_length(p_challenge_ids, 1) > 8 THEN
    RAISE EXCEPTION 'Between 1 and 8 challenges per period';
  END IF;

  SELECT count(*) INTO v_existing
    FROM public.user_daily_challenges
   WHERE user_id = v_uid AND assigned_date = p_assigned_date;

  IF v_existing = 0 THEN
    FOREACH v_id IN ARRAY p_challenge_ids LOOP
      IF NOT EXISTS (SELECT 1 FROM public.daily_challenge_catalog WHERE id = v_id) THEN
        RAISE EXCEPTION 'Unknown challenge %', v_id;
      END IF;
      INSERT INTO public.user_daily_challenges (user_id, challenge_id, assigned_date, progress, completed)
      VALUES (v_uid, v_id, p_assigned_date, 0, false)
      ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
    END LOOP;
  END IF;

  RETURN QUERY
    SELECT * FROM public.user_daily_challenges
     WHERE user_id = v_uid AND assigned_date = p_assigned_date;
END;
$fn$;

REVOKE ALL ON FUNCTION public.assign_user_challenges(text, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.assign_user_challenges(text, text[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Progress is server-authoritative. p_requirement is now IGNORED (kept in
--    the signature so the deployed client keeps working through the rollout);
--    the requirement always comes from the catalog.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_challenge_progress(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_amount integer,
  p_requirement integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid         uuid;
  v_requirement integer;
  v_progress    integer;
  v_completed   boolean;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    v_uid := p_user_id;
  ELSE
    v_uid := auth.uid();
    IF v_uid IS NULL OR (p_user_id IS NOT NULL AND p_user_id <> v_uid) THEN
      RETURN jsonb_build_object('updated', false, 'error', 'not authorized');
    END IF;
  END IF;

  -- Requirement from the CATALOG, never from the caller.
  SELECT c.requirement INTO v_requirement
    FROM public.user_daily_challenges u
    JOIN public.daily_challenge_catalog c ON c.id = u.challenge_id
   WHERE u.id = p_challenge_row_id AND u.user_id = v_uid;

  IF v_requirement IS NULL THEN
    RETURN jsonb_build_object('updated', false, 'error', 'row or catalog entry not found');
  END IF;

  UPDATE public.user_daily_challenges
     SET progress = LEAST(progress + GREATEST(COALESCE(p_amount, 0), 0), v_requirement),
         completed = (progress + GREATEST(COALESCE(p_amount, 0), 0)) >= v_requirement,
         completed_at = CASE
           WHEN (progress + GREATEST(COALESCE(p_amount, 0), 0)) >= v_requirement
                AND completed_at IS NULL THEN now()
           ELSE completed_at END
   WHERE id = p_challenge_row_id AND user_id = v_uid
   RETURNING progress, completed INTO v_progress, v_completed;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false);
  END IF;
  RETURN jsonb_build_object('updated', true, 'progress', v_progress, 'completed', v_completed);
END;
$fn$;

REVOKE ALL ON FUNCTION public.increment_challenge_progress(uuid, uuid, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.increment_challenge_progress(uuid, uuid, integer, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Claim becomes idempotent instead of raising on an already-claimed row.
--    The client wraps this in retryAsync; a committed claim whose response was
--    lost to a network blip previously re-entered, hit 'already claimed', and
--    showed the user an error toast for chips they HAD received.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid;
  v_row public.user_daily_challenges%ROWTYPE;
  v_cat public.daily_challenge_catalog%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    v_uid := p_user_id;
  ELSE
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
      RAISE EXCEPTION 'Cannot claim a challenge for another user';
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id AND user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;

  -- Idempotent: a duplicate claim is a no-op success, not an error.
  IF v_row.claimed THEN RETURN false; END IF;
  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;

  SELECT * INTO v_cat FROM public.daily_challenge_catalog WHERE id = v_row.challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown challenge % - not in the server catalog', v_row.challenge_id;
  END IF;

  -- Defence in depth. progress is no longer client-writable, but keep the
  -- assertion so a future policy regression cannot silently mint chips.
  IF COALESCE(v_row.progress, 0) < v_cat.requirement THEN
    RAISE EXCEPTION 'Challenge progress %/% does not meet the requirement',
      COALESCE(v_row.progress, 0), v_cat.requirement;
  END IF;

  UPDATE public.user_daily_challenges
     SET claimed = true, claimed_at = now()
   WHERE id = p_challenge_row_id;

  IF v_cat.chip_reward > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid, v_cat.chip_reward, 'bonus',
         'Challenge reward: ' || v_row.challenge_id,
         NULL, NULL, NULL,
         'challenge_claim:' || p_challenge_row_id::text) THEN
      RAISE EXCEPTION 'Challenge reward credit failed';
    END IF;
  END IF;

  RETURN true;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. THE LOCKDOWN. Clients may read their rows and nothing else.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert own challenges" ON public.user_daily_challenges;
DROP POLICY IF EXISTS "Users can update own challenges" ON public.user_daily_challenges;

REVOKE INSERT, UPDATE, DELETE ON public.user_daily_challenges FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.daily_challenge_catalog FROM authenticated, anon;

ALTER TABLE public.user_daily_challenges ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6. Zero-pad legacy monthly keys ('M2026-8' -> 'M2026-08') so lexical
--    ordering over assigned_date is correct. The regex in step 2 enforces the
--    padded shape for everything written from now on.
-- ---------------------------------------------------------------------------
UPDATE public.user_daily_challenges
   SET assigned_date = 'M' || split_part(substring(assigned_date from 2), '-', 1)
                     || '-' || lpad(split_part(substring(assigned_date from 2), '-', 2), 2, '0')
 WHERE assigned_date ~ '^M\d{4}-\d$'
   AND NOT EXISTS (
     SELECT 1 FROM public.user_daily_challenges b
      WHERE b.user_id = user_daily_challenges.user_id
        AND b.challenge_id = user_daily_challenges.challenge_id
        AND b.assigned_date = 'M' || split_part(substring(user_daily_challenges.assigned_date from 2), '-', 1)
                            || '-' || lpad(split_part(substring(user_daily_challenges.assigned_date from 2), '-', 2), 2, '0')
   );

-- ---------------------------------------------------------------------------
-- 7. POST-APPLY ASSERTIONS
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int; v_missing text;
BEGIN
  SELECT count(*) INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_name = 'user_daily_challenges'
     AND grantee IN ('authenticated','anon')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'lockdown failed: % write grants remain on user_daily_challenges', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.user_daily_challenges'::regclass AND polcmd IN ('a','w')) THEN
    RAISE EXCEPTION 'lockdown failed: write policies still present';
  END IF;

  SELECT string_agg(x, ', ') INTO v_missing
    FROM unnest(ARRAY['hands_15','hands_40','hands_75','hands_100','wins_7','wins_15','showdown_8','showdown_10','tourney_2']) x
   WHERE NOT EXISTS (SELECT 1 FROM public.daily_challenge_catalog WHERE id = x);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'catalog parity failed, missing: %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_daily_challenges WHERE assigned_date ~ '^M\d{4}-\d$') THEN
    RAISE EXCEPTION 'monthly key backfill incomplete';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='assign_user_challenges') THEN
    RAISE EXCEPTION 'assign_user_challenges missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (Tier 3 requirement)
-- ---------------------------------------------------------------------------
-- GRANT INSERT, UPDATE ON public.user_daily_challenges TO authenticated;
-- CREATE POLICY "Users can insert own challenges" ON public.user_daily_challenges
--   FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "Users can update own challenges" ON public.user_daily_challenges
--   FOR UPDATE USING (auth.uid() = user_id);
-- DROP FUNCTION IF EXISTS public.assign_user_challenges(text, text[]);
-- (claim_daily_challenge / increment_challenge_progress: restore prior bodies
--  from supabase/migrations/20260322_atomic_challenge_progress.sql)
