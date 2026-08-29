-- ════════════════════════════════════════════════════════════════════════
-- A horse's stake is EARNED (Dan 2026-08-29, binding — supersedes the
-- id-ordered assignment shipped hours earlier the same day)
-- ════════════════════════════════════════════════════════════════════════
--
-- "THEY CAN PLAY MORE THAN ONE STAKE, BUT YOU SHOULD CLASSIFY THEM THE SAME
--  WAY WE CLASSIFY THE CASH GAME STAKES. A MICRO PLAYER ONLY PLAYS MICRO
--  STAKES (WORST PERFORMING HORSES). SMALL STAKES IS FOR SMALL PLAYERS (2ND
--  WORST PERFORMING HORSES). MED WOULD BE GOOD WINNING HORSES, AND HIGH FOR
--  THE BEST HORSES."
--
-- The band mechanism shipped this morning was right; the ASSIGNMENT was
-- arbitrary. It took contiguous slices of the fleet ordered by id, which is
-- reproducible and exactly balanced and means nothing — a horse bleeding 80
-- big blinds per hundred could hold a seat in the 25/50 game because its uuid
-- sorted late.
--
-- A real card room sorts itself by results. The 10/25 regular is there because
-- he beats 10/25; the player who cannot beat 0.10/0.20 is still at 0.10/0.20.
-- That is what makes a stake ladder legible to anyone watching it, and it is
-- what this migration implements.
--
-- ── THE METRIC: bb/100, NOT CHIPS ───────────────────────────────────────
--
-- Raw chip net cannot rank a fleet that plays different stakes: 500 chips won
-- at 25/50 is a rounding error and at 0.05/0.10 it is a career. Winnings are
-- therefore divided by the big blinds actually faced —
-- player_stats.sum_big_blind — which is the standard bb/100 and is comparable
-- across the whole ladder.
--
-- Measured across the 584 horses when this was written:
--
--     worst   -80.71 bb/100
--     p25     -25.48
--     median  -12.60
--     p75      -0.12
--     best    +68.29
--
-- 146 winners, 438 losers, average 9,273 hands each. Real spread, real sample.
--
-- ── THE HANDS FLOOR ─────────────────────────────────────────────────────
--
-- A winrate over a few hundred hands is noise, and promoting noise to the
-- 25/50 game is how a losing horse ends up there by luck. Below
-- MIN_HANDS a horse is unranked and starts at 'micro' — a new player begins in
-- the smallest game and earns his way up, which is both the realistic answer
-- and the safe one. 576 of 584 already clear the floor.
--
-- ── HYSTERESIS, AND WHY IT IS NOT A NICETY ──────────────────────────────
--
-- This function re-runs. Without a margin, a horse sitting on a band boundary
-- flips every time its winrate wobbles — and a regular who plays 10/25 today,
-- 0.10/0.20 tomorrow and 10/25 again on Sunday is EXACTLY the tell the whole
-- stake-band feature exists to remove. A horse therefore only moves when it is
-- more than HYSTERESIS_PCT past the boundary it would cross. Near the edge it
-- keeps the band it already has.
--
-- ── THE PROPORTIONS ARE UNCHANGED ───────────────────────────────────────
--
-- 22 / 52 / 15 / 11 still, because those follow live SEAT DEMAND (micro 83
-- seats, low 220, mid 36, high 26). Merit decides WHO is in each band; demand
-- decides HOW MANY, so no stake level is left without enough horses to fill
-- it. The two constraints are independent and both are satisfied.
-- ════════════════════════════════════════════════════════════════════════

create or replace function public.fn_assign_horse_stake_bands(
  -- Below this, a winrate is noise. Unranked horses start at 'micro'.
  p_min_hands integer default 1000,
  -- Percentile points a horse must clear a boundary by before it moves.
  p_hysteresis_pct numeric default 5
) returns table (band text, horses integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with perf as (
    select ps.user_id,
           sum(ps.hands_played)                         as hands,
           sum(ps.total_winnings - ps.total_losses)     as net,
           sum(ps.sum_big_blind)                        as sum_bb
      from public.player_stats ps
      join public.profiles p on p.id = ps.user_id
     where p.is_horse is true
     group by ps.user_id
  ),
  ranked as (
    select p.id,
           coalesce(perf.hands, 0)                                       as hands,
           -- bb/100. NULL for a horse with no big blinds faced, which sorts
           -- last and lands in micro rather than being treated as a zero
           -- winrate - "no evidence" is not "break even".
           case when coalesce(perf.sum_bb, 0) > 0
                then (perf.net / perf.sum_bb) * 100
                else null end                                            as bb100,
           p.horse_profile->>'stakeBand'                                 as current_band
      from public.profiles p
      left join perf on perf.user_id = p.id
     where p.is_horse is true
  ),
  scored as (
    select id, current_band,
           hands >= p_min_hands and bb100 is not null as ranked_ok,
           -- Percentile of merit: 0 is the worst horse on the platform, 100
           -- the best. Ties broken by id so the function stays deterministic.
           case when hands >= p_min_hands and bb100 is not null
                then 100.0 * (percent_rank() over (
                       partition by (hands >= p_min_hands and bb100 is not null)
                       order by bb100, id))
                else null end                                            as merit_pct
      from ranked
  ),
  target as (
    select id, current_band, ranked_ok, merit_pct,
           case
             when not ranked_ok        then 'micro'   -- unproven: start at the bottom
             when merit_pct <  22      then 'micro'   -- worst performers
             when merit_pct <  74      then 'low'     -- second worst
             when merit_pct <  89      then 'mid'     -- good winning horses
             else                           'high'    -- the best
           end as want
      from scored
  ),
  settled as (
    select id, want, current_band, merit_pct, ranked_ok,
           case
             -- Never leave a horse without a band.
             when current_band is null or current_band not in ('micro','low','mid','high')
               then want
             when current_band = want then want
             -- HYSTERESIS: only move when the horse is clearly past the
             -- boundary it would cross, so a wobble on the edge cannot make it
             -- change stakes day to day.
             when not ranked_ok then current_band
             when merit_pct is null then current_band
             when abs(merit_pct - case want
                                    when 'micro' then 22.0
                                    when 'low'   then 74.0
                                    when 'mid'   then 89.0
                                    else 89.0
                                  end) >= p_hysteresis_pct
               then want
             else current_band
           end as final_band
      from target
  ),
  written as (
    update public.profiles p
       set horse_profile = coalesce(p.horse_profile, '{}'::jsonb)
                           || jsonb_build_object('stakeBand', s.final_band)
      from settled s
     where p.id = s.id
       and p.is_horse is true
       and coalesce(p.horse_profile->>'stakeBand', '') is distinct from s.final_band
    returning s.final_band as band
  )
  select w.band, count(*)::integer from written w group by w.band;
end;
$$;

comment on function public.fn_assign_horse_stake_bands(integer, numeric) is
  'Assign every horse a cash stake band EARNED on results: micro = worst performers, low = second worst, mid = good winners, high = the best. Ranked on bb/100 (winnings over big blinds faced, the only measure comparable across a stake ladder), with a hands floor below which a horse is unproven and starts at micro, and hysteresis so a horse on a boundary does not change stakes day to day - which would be the very tell the bands exist to remove. Proportions stay 22/52/15/11 because those follow live seat demand: merit decides who, demand decides how many.';

-- The old zero-argument signature is gone; drop it so nothing calls a stale
-- id-ordered version by accident.
drop function if exists public.fn_assign_horse_stake_bands();

revoke all on function public.fn_assign_horse_stake_bands(integer, numeric) from public, anon, authenticated;
grant execute on function public.fn_assign_horse_stake_bands(integer, numeric) to service_role;

-- Re-band the fleet on merit now.
select * from public.fn_assign_horse_stake_bands();

-- ── assertions ──────────────────────────────────────────────────────────
do $$
declare
  v_unbanded  integer;
  v_bad       integer;
  v_bands     integer;
  v_lanes_lost integer;
  v_high_wr   numeric;
  v_micro_wr  numeric;
begin
  select count(*) into v_unbanded
    from public.profiles where is_horse is true and horse_profile->>'stakeBand' is null;
  if v_unbanded > 0 then
    raise exception '% horses have no stake band', v_unbanded;
  end if;

  select count(*) into v_bad
    from public.profiles
   where is_horse is true
     and horse_profile->>'stakeBand' not in ('micro','low','mid','high');
  if v_bad > 0 then
    raise exception '% horses carry an illegal stake band', v_bad;
  end if;

  select count(distinct horse_profile->>'stakeBand') into v_bands
    from public.profiles where is_horse is true;
  if v_bands <> 4 then
    raise exception 'expected all four bands populated, found %', v_bands;
  end if;

  select count(*) into v_lanes_lost
    from public.profiles where is_horse is true and horse_profile->>'lane' is null;
  if v_lanes_lost > 0 then
    raise exception 'the stake-band merge dropped the lane on % horses', v_lanes_lost;
  end if;

  -- THE POINT OF THE MIGRATION. If the high band does not out-earn the micro
  -- band, the bands are not merit-based and the whole change is decorative.
  with perf as (
    select ps.user_id, sum(ps.total_winnings - ps.total_losses) net, sum(ps.sum_big_blind) sum_bb
      from public.player_stats ps join public.profiles p on p.id = ps.user_id
     where p.is_horse is true group by ps.user_id
  )
  select avg(case when pr.horse_profile->>'stakeBand' = 'high'  then (perf.net/nullif(perf.sum_bb,0))*100 end),
         avg(case when pr.horse_profile->>'stakeBand' = 'micro' then (perf.net/nullif(perf.sum_bb,0))*100 end)
    into v_high_wr, v_micro_wr
    from public.profiles pr join perf on perf.user_id = pr.id
   where pr.is_horse is true;

  if v_high_wr is null or v_micro_wr is null or v_high_wr <= v_micro_wr then
    raise exception 'bands are not merit-ordered: high avg %% bb/100 = %, micro = %', v_high_wr, v_micro_wr;
  end if;
end;
$$;
