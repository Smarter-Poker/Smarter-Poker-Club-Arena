-- 20260906093032_a_band_with_no_game_gets_no_horses.sql
--
-- ════════════════════════════════════════════════════════════════════════
-- A BAND WITH NO GAME GETS NO HORSES
-- The merit ladder is projected onto the games that actually exist.
-- ════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-06, verbatim: "THATS FINE, WE DON'T NEED ANY GAME OVER 2/5
-- RIGHT NOW."
--
-- So the six games above 2/5 (5/10 NLH Classic, Action and Madness, 5/10
-- PLO4 Classic, 10/20 NLH, 25/50 NLH) stay switched off. An operator closed
-- them on 2026-09-04 at 16:47 and that is a deliberate decision. This
-- migration does not open a game. It changes who the fleet mints into the
-- band those games used to live in.
--
-- ── THE DEFECT, MEASURED ON PRODUCTION 2026-09-06 ───────────────────────
--
--   profiles.horse_profile->>'stakeBand'      high 100, mid 181, low 521,
--                                             micro 198
--   enabled cash_games by fn_cash_stake_band  micro 59, low 33, mid 16,
--                                             high 0   (6 high games, all
--                                                       enabled = false)
--
-- 100 horses held the band 'high' and there was not one enabled game with
-- bb > 6 anywhere on the platform. `stakeBandAllows` in
-- server/src/services/HorseBehavior.ts is a hard gate whose comment says
-- "NO ESCAPE HATCH, DELIBERATELY", so a tenth of the fleet could sit
-- NOWHERE AT ALL.
--
-- The cause is in this function: it ranks the fleet by bb/100 and cuts it at
-- percentiles hardcoded 22 / 74 / 89, with no reference to `cash_games` at
-- all - `pg_get_functiondef(...) ilike '%cash_games%'` was false. It has no
-- way to know a band is empty of games, so it went on minting 'high' horses
-- every 30 minutes for two days.
--
-- ── THE ENGINE FALLBACK IS KEPT, AND IS NOT THE FIX ─────────────────────
--
-- PR #3224 added `effectiveStakeBandFor` / `applyStakeBandSupply` to
-- HorseBehavior.ts: a horse whose band has no game SEATS one band down,
-- downward only, with its stored band untouched. That is the right floor and
-- it stays - it covers the window between an operator switching a game off
-- and the next assignment run, which is a window this migration cannot
-- close. But it is a patch: while the SQL keeps minting horses into an empty
-- band, the patch is load bearing forever. The durable fix is that the
-- assignment must not mint a horse into a band with no games.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────
--
-- The merit ORDER is untouched. The same percentile ranking on the same
-- bb/100, the same hands floor, the same hysteresis. What changes is that
-- the band the ranking names is then PROJECTED onto the ladder of bands that
-- have at least one enabled game, so the top decile lands in the top
-- AVAILABLE band instead of an empty one.
--
-- The projection is DOWNWARD ONLY and it is the same rule the engine already
-- applies at seating time (`effectiveStakeBandFor`), deliberately, so the two
-- halves cannot disagree:
--
--   * a band that has a game keeps its horses;
--   * a band with no game hands its horses to the highest band BELOW it that
--     does have one;
--   * a horse is NEVER promoted. If only bands ABOVE it have games it keeps
--     the band it has and the floor simply has nothing for it. Seating a
--     micro grinder in a big game is the direction a watching player would
--     notice, and it is the thing the whole stake-band feature exists to
--     prevent.
--
-- With no game over 2/5, 'mid' is the top band that exists, so 'high'
-- receives nobody and its 100 horses are re-banded to 'mid' in merit order
-- (they are the top 11% by bb/100, so they land at the top of 'mid').
--
-- ── FAIL OPEN ───────────────────────────────────────────────────────────
--
-- If NO cash game is enabled at all, the function changes nothing and every
-- horse keeps the band it has. An unreadable floor is not an empty one, and
-- a band assignment that empties the fleet is the shape that cost 40 minutes
-- of dead floor on 2026-08-31 (see HorseFleetManager's bankroll-gate
-- comments). The engine's `applyStakeBandSupply` fails open for the same
-- reason and in the same direction.
--
-- ── DDL POLICY ──────────────────────────────────────────────────────────
--
-- One transaction, per club-arena CLAUDE.md section 2: every DDL statement
-- fires Supabase's pgrst_ddl_watch and one schema-cache reload takes ~28s on
-- this database. Three CREATE OR REPLACEs in one BEGIN/COMMIT coalesce into
-- one reload.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- 1. WHICH BANDS HAVE A GAME
-- ────────────────────────────────────────────────────────────────────────
-- Derived from `cash_games`, never from a constant. `enabled` is the
-- operator's switch and it is the only thing consulted: a dormant-but-
-- enabled game is a rung the ladder manager wakes on demand, so it is a game
-- that exists. A closed game (enabled = false) is not.
--
-- Returned low-to-high so the array reads as the ladder it is.
CREATE OR REPLACE FUNCTION public.fn_available_stake_bands()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(array_agg(s.band ORDER BY s.ord), '{}'::text[])
    FROM (
      SELECT DISTINCT
             public.fn_cash_stake_band(cg.bb) AS band,
             CASE public.fn_cash_stake_band(cg.bb)
               WHEN 'micro' THEN 1
               WHEN 'low'   THEN 2
               WHEN 'mid'   THEN 3
               WHEN 'high'  THEN 4
             END AS ord
        FROM public.cash_games cg
       WHERE cg.enabled IS TRUE
         AND cg.bb IS NOT NULL
    ) s
   WHERE s.band IS NOT NULL;
$function$;

COMMENT ON FUNCTION public.fn_available_stake_bands() IS
  'The stake bands that have at least one ENABLED cash game, low to high. '
  'The SQL half of the engine''s bandSupply set (HorseBehavior.applyStakeBandSupply). '
  'Empty array means no enabled game at all, which every caller must treat as '
  '"change nothing" rather than "every band is empty".';

-- ────────────────────────────────────────────────────────────────────────
-- 2. THE PROJECTION
-- ────────────────────────────────────────────────────────────────────────
-- Exactly `effectiveStakeBandFor` in server/src/services/HorseBehavior.ts,
-- in SQL. Downward only; unknown or empty availability returns the band
-- unchanged (fail open); a band with nothing at or below it is left where it
-- is rather than promoted.
CREATE OR REPLACE FUNCTION public.fn_project_stake_band(p_band text, p_available text[])
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ladder(band, ord) AS (
    VALUES ('micro', 1), ('low', 2), ('mid', 3), ('high', 4)
  ),
  want AS (SELECT l.ord FROM ladder l WHERE l.band = p_band),
  avail AS (SELECT l.band, l.ord FROM ladder l WHERE l.band = ANY(COALESCE(p_available, '{}'::text[])))
  SELECT COALESCE(
           (SELECT a.band
              FROM avail a, want w
             WHERE a.ord <= w.ord
             ORDER BY a.ord DESC
             LIMIT 1),
           p_band
         );
$function$;

COMMENT ON FUNCTION public.fn_project_stake_band(text, text[]) IS
  'Project a merit band onto the bands that have a game. Downward only, never '
  'promotes, returns the band unchanged when p_available is empty or holds '
  'nothing at or below it. The SQL twin of effectiveStakeBandFor in '
  'HorseBehavior.ts - change one and change the other.';

-- ────────────────────────────────────────────────────────────────────────
-- 3. THE ASSIGNMENT
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_assign_horse_stake_bands(
  p_min_hands integer DEFAULT 1000,
  p_hysteresis_pct numeric DEFAULT 5
)
RETURNS TABLE(band text, horses integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_available text[];
begin
  v_available := public.fn_available_stake_bands();

  -- FAIL OPEN. No enabled game anywhere is not evidence that every band is
  -- empty, it is evidence that we cannot see the floor. Change nothing and
  -- leave every horse exactly where it is.
  if coalesce(array_length(v_available, 1), 0) = 0 then
    return;
  end if;

  return query
  with perf as (
    select ps.user_id,
           sum(ps.hands_played)                     as hands,
           sum(ps.total_winnings - ps.total_losses) as net,
           sum(ps.sum_big_blind)                    as sum_bb
      from public.player_stats ps
      join public.profiles p on p.id = ps.user_id
     where p.is_horse is true
     group by ps.user_id
  ),
  ranked as (
    select p.id,
           coalesce(perf.hands, 0) as hands,
           case when coalesce(perf.sum_bb, 0) > 0
                then (perf.net / perf.sum_bb) * 100
                else null end as bb100,
           p.horse_profile->>'stakeBand' as current_band
      from public.profiles p
      left join perf on perf.user_id = p.id
     where p.is_horse is true
  ),
  scored as (
    select id, current_band,
           hands >= p_min_hands and bb100 is not null as ranked_ok,
           case when hands >= p_min_hands and bb100 is not null
                then 100.0 * (percent_rank() over (
                       partition by (hands >= p_min_hands and bb100 is not null)
                       order by bb100, id))
                else null end as merit_pct
      from ranked
  ),
  -- THE MERIT LADDER, UNCHANGED. Same metric, same hands floor, same cut
  -- points. This is what the horse has EARNED, before the floor is consulted.
  target as (
    select id, current_band, ranked_ok, merit_pct,
           case
             when not ranked_ok   then 'micro'
             when merit_pct <  22 then 'micro'
             when merit_pct <  74 then 'low'
             when merit_pct <  89 then 'mid'
             else                      'high'
           end as merit_band
      from scored
  ),
  -- THE LADDER PROJECTED ONTO THE GAMES THAT EXIST. The order is preserved
  -- because the projection is monotone: two horses never swap places, a
  -- whole rung is folded into the one below it.
  projected as (
    select id, current_band, ranked_ok, merit_pct, merit_band,
           public.fn_project_stake_band(merit_band, v_available) as want
      from target
  ),
  settled as (
    select id, want, current_band, merit_pct, ranked_ok,
           case
             when current_band is null or current_band not in ('micro','low','mid','high')
               then want
             when current_band = want then want
             when not ranked_ok then current_band
             when merit_pct is null then current_band
             when abs(merit_pct - case merit_band
                                    when 'micro' then 22.0
                                    when 'low'   then 74.0
                                    when 'mid'   then 89.0
                                    else 89.0
                                  end) >= p_hysteresis_pct
               then want
             else current_band
           end as settled_band
      from projected
  ),
  -- THE CLAMP. Hysteresis holds a horse near a boundary in the band it
  -- already has, and that band may be one the operator has since closed - it
  -- is exactly how the 100 'high' horses would otherwise survive this run.
  -- Whatever path a horse took above, it lands on a band that has a game.
  clamped as (
    select id, public.fn_project_stake_band(settled_band, v_available) as final_band
      from settled
  ),
  written as (
    update public.profiles p
       set horse_profile = coalesce(p.horse_profile, '{}'::jsonb)
                           || jsonb_build_object('stakeBand', c.final_band)
      from clamped c
     where p.id = c.id
       and p.is_horse is true
       and coalesce(p.horse_profile->>'stakeBand', '') is distinct from c.final_band
    returning c.final_band as band
  )
  select w.band, count(*)::integer from written w group by w.band;
end;
$function$;

COMMENT ON FUNCTION public.fn_assign_horse_stake_bands(integer, numeric) IS
  'Assign every horse a merit stake band from bb/100 over player_stats, then '
  'PROJECT that band onto the bands that have an enabled cash game '
  '(fn_available_stake_bands + fn_project_stake_band). Merit decides the order, '
  'the floor decides which rungs exist. Downward only, never promotes, and '
  'changes nothing at all when no cash game is enabled. 2026-09-06: before this, '
  '100 horses held ''high'' with zero enabled games above bb 6 and could sit nowhere.';

REVOKE ALL ON FUNCTION public.fn_available_stake_bands() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_project_stake_band(text, text[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_assign_horse_stake_bands(integer, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_available_stake_bands() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_project_stake_band(text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_assign_horse_stake_bands(integer, numeric) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 4. RE-BAND THE STRANDED HORSES NOW
-- ────────────────────────────────────────────────────────────────────────
-- The loader only re-runs the assignment when 25 or more horses have NO band
-- at all (HorseLaneLoader.REASSIGN_THRESHOLD), and all 100 stranded horses
-- have one - it is simply a band with no game. Nothing would have called this
-- function, so the migration calls it.
SELECT * FROM public.fn_assign_horse_stake_bands();

-- ────────────────────────────────────────────────────────────────────────
-- 5. ASSERT IT
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_available text[] := public.fn_available_stake_bands();
  v_stranded  integer;
  v_bands     text;
BEGIN
  IF coalesce(array_length(v_available, 1), 0) = 0 THEN
    RAISE NOTICE 'no enabled cash game - assignment left every horse alone, as designed';
    RETURN;
  END IF;

  -- Every horse is now in a band that has a game, OR in a band with nothing
  -- available at or below it (which the projection deliberately leaves alone
  -- rather than promoting). With micro enabled, the second case is empty.
  SELECT count(*) INTO v_stranded
    FROM public.profiles p
   WHERE p.is_horse IS TRUE
     AND p.horse_profile->>'stakeBand' IS NOT NULL
     AND NOT (p.horse_profile->>'stakeBand' = ANY(v_available))
     AND public.fn_project_stake_band(p.horse_profile->>'stakeBand', v_available)
         <> p.horse_profile->>'stakeBand';

  IF v_stranded > 0 THEN
    RAISE EXCEPTION
      'ASSERTION FAILED: % horse(s) still hold a band with no enabled game that could have been projected down. Available: %',
      v_stranded, v_available;
  END IF;

  SELECT string_agg(x.band || '=' || x.n, ' ' ORDER BY x.band) INTO v_bands
    FROM (
      SELECT coalesce(p.horse_profile->>'stakeBand', '(null)') AS band, count(*) AS n
        FROM public.profiles p
       WHERE p.is_horse IS TRUE
       GROUP BY 1
    ) x;
  RAISE NOTICE 'stake bands after projection onto %: %', v_available, v_bands;
END $$;

COMMIT;
