-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829125221; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Every horse plays ONE stake (Dan 2026-08-29, binding). Full incident notes in
-- the repo migration 20260829130000_every_horse_plays_one_stake.sql.
-- Measured before this: 64 of 210 seated horses played more than one stake in
-- 48h; `yankee` sat at 0.10/0.20 AND 25.00/50.00. Stakes were never an input to
-- horse selection - the blinds were read only to size a buy-in.
-- Assigned rather than hashed for the same reason lanes are: the id hash
-- clusters on UUIDs, and here a short band is a stake level that cannot fill
-- its tables. Weights follow live seat demand: 22/52/15/11.

create or replace function public.fn_assign_horse_stake_bands()
returns table (band text, horses integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with ranked as (
    -- ORDER BY id, not random(): a horse's stake is who it is; a re-run must
    -- not let it be a micro grinder on Tuesday.
    select p.id,
           row_number() over (order by p.id) as rn,
           count(*) over ()                  as total
      from public.profiles p
     where p.is_horse is true
  ),
  banded as (
    select id,
           case
             when rn <= floor(total * 0.22) then 'micro'
             when rn <= floor(total * 0.74) then 'low'
             when rn <= floor(total * 0.89) then 'mid'
             else                                'high'
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

select * from public.fn_assign_horse_stake_bands();

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

  select count(*) into v_lanes_lost
    from public.profiles where is_horse is true and horse_profile->>'lane' is null;
  if v_lanes_lost > 0 then
    raise exception 'the stake-band merge dropped the lane on % horses', v_lanes_lost;
  end if;
end;
$$;
