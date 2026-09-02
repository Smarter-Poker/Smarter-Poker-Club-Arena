-- ════════════════════════════════════════════════════════════════════════
-- Every horse plays ONE stake (Dan 2026-08-29, binding)
-- ════════════════════════════════════════════════════════════════════════
--
-- "EACH HORSE SHOULD HAVE A SPECIFIC STAKES THEY'RE PLAYING. A HORSE PLAYING
--  5/10 OR 10/25 SHOULD NEVER BE SEEN ON A 50 CENT ONE DOLLAR GAME OR 1/2
--  DOLLAR GAME, THAT JUST LOOKS SUSPICIOUS."
--
-- He is right, and it was measurable. Over the 48 hours before this migration:
-- 210 horses took a cash seat, and 64 of them - nearly a third - sat at more
-- than one stake level. The worst were not marginal:
--
--     yankee              0.10/0.20 and 25.00/50.00           250x spread
--     mixedgame max       0.10/0.20, 1.00/2.00, 10.00/25.00   125x
--     ronald calabrese 2  0.10/0.20, 2.00/4.00, 10.00/25.00   125x
--     duckcall            0.05/0.10 and 2.00/4.00              40x
--
-- No human bankroll moves like that, and a regular who knows a name from the
-- 10/25 game sees it instantly in their 0.10/0.20 game.
--
-- WHY IT HAPPENED. Stakes were never an input to horse selection.
-- HorseFleetManager picked from every enabled horse weighted only by how many
-- tables it already sat at; small_blind/big_blind were read solely to size a
-- buy-in. Nothing anywhere in the seating path had an opinion about stakes.
--
-- ── WHY ASSIGNED AND NOT HASHED ─────────────────────────────────────────
--
-- Exactly the reason lanes are assigned (fn_assign_horse_lanes, 2026-08-27):
-- horseHash is a weak multiply-add and a low-bit modulo of it clusters on
-- structured ids, which UUIDs are. The lane hash aimed at 33/33/34 and
-- measured 32.0/39.0/28.9 across the real fleet.
--
-- Here a skew is worse than cosmetic. A band that comes out short is a stake
-- level with too few horses to fill its tables, and the band is deliberately
-- strict - there is no rescue path that widens it - so an undershoot shows up
-- as an empty game rather than as a statistic.
--
-- ── THE WEIGHTS ─────────────────────────────────────────────────────────
--
-- They follow live seat demand. Cash seats by band on 2026-08-29:
--
--     micro  0.05/0.10, 0.10/0.20, 0.25/0.50        11 tables,  83 seats
--     low    0.50/1.00, 1.00/2.00                   30 tables, 220 seats
--     mid    2.00/4.00, 2.00/5.00, 3.00/6.00         4 tables,  36 seats
--     high   5.00/10.00, 10.00/25.00, 25.00/50.00    4 tables,  26 seats
--
-- 22 / 52 / 15 / 11. A third of the roster is events-only and never sits at
-- cash, so the eligible pool is about two thirds - but each horse may hold up
-- to four tables, so every band still clears its seats several times over:
--
--     micro  ~86 eligible horses -> ~344 seat-slots for 83 seats
--     low   ~203                 -> ~812        for 220
--     mid    ~59                 -> ~235        for 36
--     high   ~43                 -> ~172        for 26
--
-- ── SHAPE ───────────────────────────────────────────────────────────────
--
-- Merged into profiles.horse_profile with `||`, exactly like the lane, so the
-- style dials, the lane and anything the nightly self-tuner writes all survive.
-- HorseSelfTuner spreads the whole existing object before writing, so it
-- preserves stakeBand for free.
-- ════════════════════════════════════════════════════════════════════════

create or replace function public.fn_assign_horse_stake_bands()
returns table (band text, horses integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with ranked as (
    -- ORDER BY id, not random(): the assignment must be reproducible, and a
    -- re-run must not reshuffle every horse's identity. A horse's stake is who
    -- it is; it does not get to be a micro grinder on Tuesday.
    select p.id,
           row_number() over (order by p.id) as rn,
           count(*) over ()                  as total
      from public.profiles p
     where p.is_horse is true
  ),
  banded as (
    select id,
           case
             -- Exact by construction: contiguous slices of the ordered fleet,
             -- so the split lands on its targets at any fleet size instead of
             -- drifting the way a hash does.
             when rn <= floor(total * 0.22)                then 'micro'
             when rn <= floor(total * 0.74)                then 'low'
             when rn <= floor(total * 0.89)                then 'mid'
             else                                               'high'
           end as band
      from ranked
  ),
  written as (
    update public.profiles p
       set horse_profile = coalesce(p.horse_profile, '{}'::jsonb)
                           || jsonb_build_object('stakeBand', b.band)
      from banded b
     where p.id = b.id
       and p.is_horse is true
       and coalesce(p.horse_profile->>'stakeBand', '') is distinct from b.band
    returning b.band
  )
  select w.band, count(*)::integer from written w group by w.band;
end;
$$;

comment on function public.fn_assign_horse_stake_bands() is
  'Assign every horse exactly one cash stake band (micro/low/mid/high) into horse_profile->>stakeBand. Contiguous slices of the id-ordered fleet, so the 22/52/15/11 split is exact at any fleet size rather than drifting the way the id hash does. Idempotent: only rows whose band would change are written, and the jsonb merge preserves style, lane and self-tuner dials.';

revoke all on function public.fn_assign_horse_stake_bands() from public, anon, authenticated;
grant execute on function public.fn_assign_horse_stake_bands() to service_role;

-- Assign the current fleet now, so the band is live the moment the engine that
-- reads it deploys rather than a refresh cycle later.
select * from public.fn_assign_horse_stake_bands();

-- ── assertions ──────────────────────────────────────────────────────────
do $$
declare
  v_unbanded integer;
  v_bad      integer;
  v_bands    integer;
  v_lanes_lost integer;
begin
  select count(*) into v_unbanded
    from public.profiles where is_horse is true and horse_profile->>'stakeBand' is null;
  if v_unbanded > 0 then
    raise exception '% horses still have no stake band', v_unbanded;
  end if;

  select count(*) into v_bad
    from public.profiles
   where is_horse is true
     and horse_profile->>'stakeBand' not in ('micro','low','mid','high');
  if v_bad > 0 then
    raise exception '% horses carry a stake band outside the four legal values', v_bad;
  end if;

  select count(distinct horse_profile->>'stakeBand') into v_bands
    from public.profiles where is_horse is true;
  if v_bands <> 4 then
    raise exception 'expected all four bands to be populated, found %', v_bands;
  end if;

  -- The merge must not have eaten the lane assignment, which lives in the same
  -- column and is what a third of the fleet's behaviour depends on.
  select count(*) into v_lanes_lost
    from public.profiles where is_horse is true and horse_profile->>'lane' is null;
  if v_lanes_lost > 0 then
    raise exception 'the stake-band merge dropped the lane on % horses', v_lanes_lost;
  end if;
end;
$$;
