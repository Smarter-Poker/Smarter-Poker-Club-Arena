-- 20260908144747_the_vip_cap_and_the_expiring_claims.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- I RAISED THE WRONG COLUMN, AND 51,380 EARNED DIAMONDS EXPIRE IN THREE HOURS.
-- (CLAUDE.md 10.5, 10.9, 10.86; ruling 21; docs/changelog/2026-09-08-the-vip-cap-and-the-expiring-claims.md)
--
-- An adversarial review of this morning's work found three defects that compound into one event on
-- 2026-09-14, and one that lands today at 17:20 UTC. All four are mine.
--
-- 1. THE CAP I SET IS NOT THE CAP THAT APPLIES.
--    `diamond_engine_daily_caps` has TWO columns, and `fn_ca_diamond_earn_ledger` does
--
--        IF v_cap_vip IS NOT NULL THEN ... IF v_is_vip THEN v_cap := v_cap_vip; END IF;
--
--    so for a VIP the VIP column is the whole limit. I raised `max_per_user_per_day` to 4,000 and
--    left `max_per_user_per_day_vip` at 2,000. **849 horses are lifetime VIPs**, so the raise
--    reached almost nobody: the forecast still says 4,547 refusals across 801 players on the 14th.
--    Of 857 VIP user-days in fourteen days, 801 exceed 2,000 and NONE exceeds 4,000.
--
--    A VIP CAP BELOW THE STANDARD CAP IS BACKWARDS on its face - it makes paying for VIP a
--    downgrade - and nothing prevented it, so a CHECK constraint does now. The two columns are set
--    equal here rather than making VIP higher: what VIP should additionally earn is a product
--    decision and Dan's (10.9). Equal is the smallest change that is not absurd.
--
-- 2. THE INSTRUMENT I BUILT TO CATCH THIS WAS BLIND TO IT.
--    `fn_ca_diamond_cap_headroom` read only `max_per_user_per_day` and reported
--    "HEALTHY ... 1.61x headroom" for a cap that would refuse 4,547 movements. The forecast, built
--    the same day, said 4,547. A tool whose entire purpose is that nobody arms a rule blind was
--    itself blind, in precisely the way it exists to prevent (10.86). It reads both columns now and
--    names the one that actually binds.
--
-- 3. THE CLAIM LOOP SILENCES THE FAILURE THAT IS ABOUT TO START.
--    The horse claim swallows any error matching `%daily_cap%` without filing an incident, and the
--    DR7 refusal message is `DR7:user_over_daily_cap: promotional issuance refused (...)`. Staying
--    silent when a horse hits its cap is correct - that is the ordinary daily outcome for a
--    thousand horses and filing it would rebuild an always-on alarm. But `%daily_cap%` is a
--    substring, so ANY other error carrying those characters is silenced too. It matches the rule
--    name exactly now, and anything else files as it should.
--
-- 4. AND THE ONE WITH A CLOCK ON IT: 759 EARNED REWARDS ARE ABOUT TO EXPIRE UNCLAIMED.
--    23 horses hold 759 completed, unclaimed, in-window challenges worth **51,380 diamonds**. The
--    oldest completed 2026-09-01 17:20:55, so **114 of them expire today at 17:20 UTC**.
--
--    The cause is the one 10.5 keeps pointing at. A horse claims only when the engine reports a new
--    challenge event for it, and these 23 have reported none since 05:07 - a horse that stops
--    playing stops claiming. A HUMAN WHO STOPS PLAYING STILL HAS A CLAIM BUTTON for the whole seven
--    days. The input device differs, so the outcome differs, which is exactly what 10.5 forbids.
--
--    THE ROOT FIX IS NOT IN THIS FILE AND CANNOT BE. The engine must claim on its own cadence
--    rather than only on an event, and that is HorseLogic - TypeScript in the Club Arena server.
--    The database half already exists: `claim_daily_challenge_serialized_body(p_user_id, ...)`
--    accepts the engine naming a player. This settles the damage already done, once, from evidence,
--    through the platform's own idempotent path (10.9), and names the engine work so it is not
--    mistaken for finished. It creates nothing scheduled (10.12); if it is ever needed again the
--    cause came back and the cause is the engine.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- 1. The cap that actually applies.
-- ---------------------------------------------------------------------------
UPDATE public.diamond_engine_daily_caps
   SET max_per_user_per_day_vip = max_per_user_per_day
 WHERE max_per_user_per_day_vip IS NOT NULL
   AND max_per_user_per_day IS NOT NULL
   AND max_per_user_per_day_vip < max_per_user_per_day;

-- A VIP allowance below the standard one makes VIP a downgrade. Nothing stopped that being
-- written, and I wrote it by raising one column of two.
ALTER TABLE public.diamond_engine_daily_caps
  DROP CONSTRAINT IF EXISTS ca_vip_cap_is_never_lower;
ALTER TABLE public.diamond_engine_daily_caps
  ADD CONSTRAINT ca_vip_cap_is_never_lower
  CHECK (max_per_user_per_day_vip IS NULL
         OR max_per_user_per_day IS NULL
         OR max_per_user_per_day_vip >= max_per_user_per_day);

-- ---------------------------------------------------------------------------
-- 2. The headroom report reads the cap that binds.
-- ---------------------------------------------------------------------------
-- The signature gains cap_vip and binding_cap, so REPLACE cannot do it. Nothing calls this from
-- application code - it is read by a person - so dropping it is safe here and would not be if the
-- app depended on the old shape.
DROP FUNCTION IF EXISTS public.fn_ca_diamond_cap_headroom(integer);

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_cap_headroom(p_days integer DEFAULT 14)
RETURNS TABLE (
  engine          text,
  cap_now         integer,
  cap_vip         integer,
  binding_cap     integer,
  design_ceiling  bigint,
  observed_max    bigint,
  observed_p99    bigint,
  user_days       bigint,
  would_refuse    bigint,
  verdict         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_from date := current_date - GREATEST(COALESCE(p_days, 14), 1);
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  WITH awarded AS (
    SELECT a.engine AS eng, a.awarded AS amt,
           -- The cap that applies to THIS player. fn_ca_diamond_earn_ledger substitutes the VIP
           -- column outright when the player is VIP, so reading only the standard column certifies
           -- a limit that will never be used. That is how a 2,000 VIP cap read as "1.61x healthy"
           -- under a 4,000 standard cap on 2026-09-08.
           (COALESCE(p.is_vip, false)
            AND (COALESCE(p.vip_tier, '') = 'lifetime'
                 OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))) AS vip
      FROM public.diamond_user_daily_awards a
      JOIN public.profiles p ON p.id = a.user_id
     WHERE a.day >= v_from AND a.awarded > 0),
  ceiling AS (
    SELECT 'daily_challenges'::text AS eng, max(possible)::bigint AS ceil
      FROM (SELECT sum(u.diamond_reward_snapshot) AS possible
              FROM public.user_daily_challenges u
             WHERE u.created_at >= now() - make_interval(days => GREATEST(COALESCE(p_days, 14), 1))
             GROUP BY u.user_id, (u.created_at AT TIME ZONE 'America/Chicago')::date) s),
  rolled AS (
    SELECT c.engine AS eng,
           c.max_per_user_per_day AS cap_std,
           c.max_per_user_per_day_vip AS cap_v,
           LEAST(COALESCE(c.max_per_user_per_day, 2147483647),
                 COALESCE(c.max_per_user_per_day_vip, 2147483647)) AS cap_bind,
           cl.ceil AS ceil,
           COALESCE(max(w.amt), 0)::bigint AS obs_max,
           COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY w.amt), 0)::bigint AS obs_p99,
           count(w.amt) AS days,
           count(*) FILTER (
             WHERE w.amt > CASE WHEN w.vip
                                THEN COALESCE(c.max_per_user_per_day_vip, c.max_per_user_per_day)
                                ELSE c.max_per_user_per_day END) AS refused
      FROM public.diamond_engine_daily_caps c
      LEFT JOIN awarded w ON w.eng = c.engine
      LEFT JOIN ceiling cl ON cl.eng = c.engine
     GROUP BY c.engine, c.max_per_user_per_day, c.max_per_user_per_day_vip, cl.ceil)
  SELECT r.eng, r.cap_std, r.cap_v, r.cap_bind, r.ceil, r.obs_max, r.obs_p99, r.days, r.refused,
         CASE
           WHEN r.cap_std IS NULL AND r.cap_v IS NULL THEN
             'NO CAP. Nothing limits one account on this engine.'
           WHEN r.cap_v IS NOT NULL AND r.cap_std IS NOT NULL AND r.cap_v < r.cap_std THEN
             'VIP CAP IS LOWER (' || r.cap_v || ' vs ' || r.cap_std || '). The VIP column is what '
             || 'applies to a VIP, so that is the real limit and paying for VIP is a downgrade.'
           WHEN r.ceil IS NOT NULL AND r.cap_bind <= r.ceil THEN
             'BELOW THE DESIGN CEILING (' || r.ceil || '). This refuses a player who completed '
             || 'everything the game assigned them.'
           WHEN r.refused > 0 THEN
             'REFUSES REAL DAYS: ' || r.refused || ' of ' || r.days || ' user-days in the window are '
             || 'over the cap that applies to that player.'
           WHEN r.days = 0 THEN 'NO ACTIVITY in the window; nothing to judge it against.'
           ELSE 'HEALTHY. ' || r.days || ' user-days, highest ' || r.obs_max || ', binding cap '
                || r.cap_bind || ' - ' || round(r.cap_bind::numeric / NULLIF(r.obs_max, 0), 2)
                || 'x headroom.'
         END
    FROM rolled r
   ORDER BY r.refused DESC, r.eng;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_cap_headroom(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_cap_headroom(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The claim loop silences the cap and nothing else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_oid oid; v_def text;
BEGIN
  -- strpos, not LIKE: the needle itself contains % and _, so a LIKE pattern would match things it
  -- should not - including, after the patch, the very text it just wrote.
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND strpos(p.prosrc, 'SQLERRM NOT LIKE ''%daily_cap%''') > 0
  LOOP
    SELECT pg_get_functiondef(v_oid) INTO v_def;
    EXECUTE replace(v_def,
      'IF SQLERRM NOT LIKE ''%daily_cap%'' THEN',
      -- The rule name, not a substring of it. Silence is right for the cap - a thousand horses meet
      -- it daily and filing that would be an always-on alarm - but `%daily_cap%` also swallowed any
      -- other error carrying those characters.
      'IF SQLERRM NOT LIKE ''%DR7:user_over_daily_cap%'' THEN');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Settle the 759 before they expire. Once, from evidence, through the real path.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_paid integer := 0; v_failed integer := 0; v_diamonds numeric := 0;
        v_before numeric; v_after numeric; v_expiring integer;
BEGIN
  SELECT count(*) INTO v_expiring FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
  SELECT COALESCE(sum(diamonds), 0) INTO v_before FROM public.profiles;

  FOR r IN
    SELECT u.id, u.user_id
      FROM public.user_daily_challenges u
      JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
     WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
       AND u.completed_at >= now() - interval '7 days'
     ORDER BY u.completed_at, u.id
  LOOP
    BEGIN
      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
      v_paid := v_paid + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  SELECT COALESCE(sum(diamonds), 0) INTO v_after FROM public.profiles;
  v_diamonds := v_after - v_before;
  RAISE NOTICE 'settled % of % owed claims (% could not be paid), % diamonds to horses',
    v_paid, v_expiring, v_failed, v_diamonds;

  IF v_paid = 0 AND v_expiring > 0 THEN
    RAISE EXCEPTION 'nothing was settled although % claims were owed', v_expiring;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad integer; v_left integer; v_body text;
BEGIN
  -- no cap is a downgrade for a VIP, and it cannot become one
  SELECT count(*) INTO v_bad FROM public.diamond_engine_daily_caps
   WHERE max_per_user_per_day_vip IS NOT NULL AND max_per_user_per_day IS NOT NULL
     AND max_per_user_per_day_vip < max_per_user_per_day;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% cap(s) still give a VIP less than a standard player', v_bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ca_vip_cap_is_never_lower') THEN
    RAISE EXCEPTION 'nothing prevents a VIP cap being written below the standard one again';
  END IF;

  -- and no real day in the measured history is refused by the cap that applies to that player
  SELECT count(*) INTO v_bad
    FROM public.diamond_user_daily_awards a
    JOIN public.diamond_engine_daily_caps c ON c.engine = a.engine
    JOIN public.profiles p ON p.id = a.user_id
   WHERE a.day >= current_date - 14
     AND a.awarded > CASE WHEN COALESCE(p.is_vip, false)
                               AND (COALESCE(p.vip_tier,'') = 'lifetime'
                                    OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))
                          THEN COALESCE(c.max_per_user_per_day_vip, c.max_per_user_per_day)
                          ELSE c.max_per_user_per_day END;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% user-day(s) would still be refused by the cap that applies to them', v_bad;
  END IF;

  -- the headroom report reads both columns
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_cap_headroom';
  IF v_body NOT LIKE '%max_per_user_per_day_vip%' THEN
    RAISE EXCEPTION 'the headroom report is still blind to the VIP cap';
  END IF;

  -- the claim loop matches the rule, not a substring
  SELECT count(*) INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND strpos(p.prosrc, 'SQLERRM NOT LIKE ''%daily_cap%''') > 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% claim loop(s) still silence any error containing daily_cap', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND strpos(p.prosrc, 'SQLERRM NOT LIKE ''%DR7:user_over_daily_cap%''') > 0;
  IF v_bad = 0 THEN
    RAISE EXCEPTION 'no claim loop carries the precise cap match, so the patch found nothing to change';
  END IF;

  -- nothing is left owed inside the window
  SELECT count(*) INTO v_left FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% earned claim(s) are still unpaid inside their window', v_left;
  END IF;

  -- and the money still adds up
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after settling';
  END IF;
END $$;

COMMIT;
