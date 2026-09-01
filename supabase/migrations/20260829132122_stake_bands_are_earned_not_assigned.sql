-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829132122; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A horse's stake is EARNED (Dan 2026-08-29, binding). Supersedes the
-- id-ordered assignment shipped hours earlier the same day. Full notes in the
-- repo migration 20260829150000_stake_bands_are_earned_not_assigned.sql.
-- micro = worst performers, low = 2nd worst, mid = good winners, high = best.
-- Ranked on bb/100 (the only measure comparable across a stake ladder), with a
-- hands floor and hysteresis so a horse on a boundary does not change stakes
-- day to day - which would be the very tell the bands exist to remove.

create or replace function public.fn_assign_horse_stake_bands(
  p_min_hands integer default 1000,
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
  target as (
    select id, current_band, ranked_ok, merit_pct,
           case
             when not ranked_ok   then 'micro'
             when merit_pct <  22 then 'micro'
             when merit_pct <  74 then 'low'
             when merit_pct <  89 then 'mid'
             else                      'high'
           end as want
      from scored
  ),
  settled as (
    select id, want, current_band, merit_pct, ranked_ok,
           case
             when current_band is null or current_band not in ('micro','low','mid','high')
               then want
             when current_band = want then want
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
  'Assign every horse a cash stake band EARNED on results: micro = worst performers, low = second worst, mid = good winners, high = the best. Ranked on bb/100, with a hands floor below which a horse is unproven and starts at micro, and hysteresis so a horse on a boundary does not change stakes day to day. Proportions stay 22/52/15/11 because those follow live seat demand: merit decides who, demand decides how many.';

drop function if exists public.fn_assign_horse_stake_bands();

revoke all on function public.fn_assign_horse_stake_bands(integer, numeric) from public, anon, authenticated;
grant execute on function public.fn_assign_horse_stake_bands(integer, numeric) to service_role;

select * from public.fn_assign_horse_stake_bands();

do $$
declare
  v_unbanded integer; v_bad integer; v_bands integer; v_lanes_lost integer;
  v_high_wr numeric; v_micro_wr numeric;
begin
  select count(*) into v_unbanded
    from public.profiles where is_horse is true and horse_profile->>'stakeBand' is null;
  if v_unbanded > 0 then raise exception '% horses have no stake band', v_unbanded; end if;

  select count(*) into v_bad from public.profiles
   where is_horse is true and horse_profile->>'stakeBand' not in ('micro','low','mid','high');
  if v_bad > 0 then raise exception '% horses carry an illegal stake band', v_bad; end if;

  select count(distinct horse_profile->>'stakeBand') into v_bands
    from public.profiles where is_horse is true;
  if v_bands <> 4 then raise exception 'expected all four bands populated, found %', v_bands; end if;

  select count(*) into v_lanes_lost
    from public.profiles where is_horse is true and horse_profile->>'lane' is null;
  if v_lanes_lost > 0 then raise exception 'the merge dropped the lane on % horses', v_lanes_lost; end if;

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
    raise exception 'bands are not merit-ordered: high = %, micro = %', v_high_wr, v_micro_wr;
  end if;
end;
$$;
