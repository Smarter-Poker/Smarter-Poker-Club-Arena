-- a_stake_band_is_projected_onto_the_games_the_horses_own_host_deals
--
-- LANE E (DB side of the horse audit, 2026-09-11). Reserve a real version with
-- `node scripts/new-migration.mjs "..."` before applying; apply ONCE, outside
-- :50-:03 UTC. This file DROPs the zero-argument `fn_available_stake_bands()`
-- (its only caller is the assigner rewritten here) and creates the one-argument
-- form with a NULL default, so the platform-wide answer is still reachable.
--
-- WHAT IS WRONG (read from rows)
--
-- `fn_assign_horse_stake_bands` ranks every horse by bb/100 and hands the top
-- 11% 'high', then projects that ladder onto `fn_available_stake_bands()` -
-- the bands with an enabled `cash_games` row ANYWHERE ON THE PLATFORM. A horse
-- can only sit at its own host's tables (club membership; DSS horses and
-- Midway horses are disjoint sets, 416 / 584), so the projection has to be
-- onto the bands ITS HOST deals.
--
--   enabled cash_games by host and band, 2026-09-11 14:4x UTC:
--     Deep Stack Society  micro 25 / low 12 / mid 4 / high 1 (NLH 25/50 Classic,
--                         dormant, one open table, 0 of 9 seated)
--     Midway Union        micro 34 / low 21 / mid 12 / high 0
--   fn_available_stake_bands() = {micro, low, mid, high}: the single DSS
--   25/50 game makes 'high' "available" for Midway horses that can never
--   sit at it.
--
-- Re-measured read-only at 16:40 UTC on 2026-09-11, in a rolled-back
-- transaction, with the fixed availability function in pg_temp: the next
-- assignment run would write 'high' onto 76 Midway horses today, and with
-- the fix all 76 land on 'mid'. Deep Stack Society is unchanged in every
-- band (26 high, 35 mid, 184 low, 171 micro). Midway deals {micro,low,mid};
-- the platform-wide answer is {micro,low,mid,high}. A Midway 'high' horse
-- has NO cash game on its host at all, and HorseBehavior.stakeBandAllows is a
-- hard gate whose downward fallback (projectStakeBandOnto) only fires when the
-- band is empty of games platform-wide - it is not, so 38 horses would sit
-- nowhere, for ever, exactly the 2026-09-05 shape (100 'high' horses with no
-- game) that migration 20260906093032 was written to end. It is latent today
-- only because the assigner runs when >= 25 horses lack a band
-- (HorseLaneLoader REASSIGN_THRESHOLD) and 0 do; the next batch of new horses
-- or a manual run mints them.
--
-- THE FIX
--
-- `fn_available_stake_bands(p_host uuid DEFAULT NULL)`: the bands with an
-- enabled, not-closed game at that host (`coalesce(union_id, club_id)`, the
-- same host key StableHandSnapshot.enabledGamesFor uses); NULL keeps the
-- platform-wide answer. The assigner projects each horse's merit band onto
-- the union of the bands its hosts deal (club_members active/approved ->
-- clubs.union_id or the club itself); a horse with no membership keeps the
-- platform-wide projection. Merit ladder, hysteresis, cut points and the
-- fail-open (no enabled game anywhere -> write nothing) are unchanged.
-- Downward only, as before: a Midway 'high' lands on 'mid' (the 2/5 games),
-- never above.
--
-- Same rule as HorseBehavior.projectStakeBandOnto, now with the right supply
-- set. Engine follow-up (lane A file, HorseFleetManager applyStakeBandSupply):
-- publish the supply per host and project a horse against its own host's set;
-- until then the DB assignment is the layer that stops the strand.
--
-- Idempotent: the DROP is IF EXISTS, both CREATEs are OR REPLACE, grants are
-- restated. One transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path TO public, pg_temp;

DROP FUNCTION IF EXISTS public.fn_available_stake_bands();

CREATE OR REPLACE FUNCTION public.fn_available_stake_bands(p_host uuid DEFAULT NULL)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The bands with at least one enabled, not-closed cash game at p_host
  -- (a union id or a standalone club id); every host when p_host is NULL.
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
         AND cg.closed_at IS NULL
         AND cg.bb IS NOT NULL
         AND (p_host IS NULL OR COALESCE(cg.union_id, cg.club_id) = p_host)
    ) s
   WHERE s.band IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.fn_assign_horse_stake_bands(p_min_hands integer DEFAULT 1000, p_hysteresis_pct numeric DEFAULT 5)
 RETURNS TABLE(band text, horses integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_available text[];
begin
  v_available := public.fn_available_stake_bands(NULL);

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
  -- THE GAMES A HORSE CAN ACTUALLY REACH (lane E, 2026-09-11). A horse sits
  -- only where it holds a membership: its hosts are the union (for a club in
  -- one) or the club itself. The bands with a game are read per host and a
  -- horse gets the union of its hosts' bands; a horse with no membership
  -- keeps the platform-wide set, which is what every horse got before.
  hosts as (
    select distinct cm.user_id, coalesce(c.union_id, c.id) as host
      from public.club_members cm
      join public.clubs c on c.id = cm.club_id
      join public.profiles p on p.id = cm.user_id and p.is_horse is true
     where cm.status in ('active', 'approved')
  ),
  host_bands as (
    select h.host, public.fn_available_stake_bands(h.host) as bands
      from (select distinct host from hosts) h
  ),
  horse_bands as (
    select hs.user_id,
           array(select distinct b
                   from host_bands hb
                   join hosts h2 on h2.host = hb.host
                   cross join lateral unnest(hb.bands) as b
                  where h2.user_id = hs.user_id) as bands
      from (select distinct user_id from hosts) hs
  ),
  -- THE LADDER PROJECTED ONTO THE GAMES THAT EXIST FOR THIS HORSE. The order
  -- is preserved because the projection is monotone: two horses never swap
  -- places, a whole rung is folded into the one below it.
  projected as (
    select t.id, t.current_band, t.ranked_ok, t.merit_pct, t.merit_band,
           case when coalesce(array_length(hb.bands, 1), 0) > 0 then hb.bands else v_available end as avail,
           public.fn_project_stake_band(
             t.merit_band,
             case when coalesce(array_length(hb.bands, 1), 0) > 0 then hb.bands else v_available end
           ) as want
      from target t
      left join horse_bands hb on hb.user_id = t.id
  ),
  settled as (
    select id, want, avail, current_band, merit_pct, ranked_ok,
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
  -- already has, and that band may be one the operator has since closed on
  -- this horse's host - it is exactly how the 100 'high' horses of 2026-09-05
  -- would otherwise survive this run. Whatever path a horse took above, it
  -- lands on a band that has a game it can reach.
  clamped as (
    select id, public.fn_project_stake_band(settled_band, avail) as final_band
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

-- Grants, stated (production today: service_role + owner on both).
REVOKE ALL ON FUNCTION public.fn_available_stake_bands(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_available_stake_bands(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_assign_horse_stake_bands(integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_horse_stake_bands(integer, numeric) TO service_role;

DO $check$
DECLARE
  v_midway text[];
  v_all text[];
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_assign_horse_stake_bands(integer, numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_assign_horse_stake_bands(integer, numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_available_stake_bands(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants did not take on the stake band functions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_available_stake_bands' AND p.pronargs = 0) THEN
    RAISE EXCEPTION 'the zero-argument fn_available_stake_bands survived; a bare call would be ambiguous';
  END IF;
  -- The platform-wide answer is still reachable, and a host answer is a subset of it.
  v_all := public.fn_available_stake_bands();
  v_midway := public.fn_available_stake_bands('fade0000-0000-0000-0000-000000000001'::uuid);
  IF NOT (v_midway <@ v_all) THEN
    RAISE EXCEPTION 'a host''s bands are not a subset of the platform''s: % vs %', v_midway, v_all;
  END IF;
END
$check$;

COMMIT;
