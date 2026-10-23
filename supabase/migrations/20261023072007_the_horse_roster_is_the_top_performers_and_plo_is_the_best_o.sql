-- 20261023072007_the_horse_roster_is_the_top_performers_and_plo_is_the_best_o.sql
-- Version reserved by scripts/new-migration.mjs.
--
-- APPLIED TO PRODUCTION 2026-10-23 ~12:45 UTC, in two steps: the schema
-- transaction below, then the data block after it. The first attempt ran both
-- in one transaction and deadlocked against a live profiles writer (the trigger
-- DDL held cash_games while the bench update waited on profiles rows), so the
-- data block runs OUTSIDE the DDL transaction and the bench locks rows in id
-- order.
--
-- Dan 2026-10-23: "REDUCE THE AMOUNT OF HORSES THAT CAN PLAY PLO, ONLY ALLOW
-- THE TOP PERFORMING HORSES PLAY PLO. KEEP IT UNDER 35-50 TOTAL HORSES AT ANY
-- TIME FOR ALL GAME TYPES. AND NO GAMES HIGHER THEN .50-1.00 MOVING FORWARD"
-- and then: "YOU CAN OPEN BACK UP 1-2 PLO BUT ONLY ALLOW THE HORSES THAT HAVE
-- SHOWN TO BE PROFITABLE PLAYING PLO PLAY THOSE GAMES."
--
-- 1. THE ACTIVE ROSTER (45). fn_ca_horse_roster_refresh ranks every active
--    horse: PLO-profitable horses first, then by cash net big blinds per 100
--    hands (cash + heads-up cash, 30 days, 5,000-hand floor first). The top 45
--    stay active; every other active horse is BENCHED (horse_status
--    'disabled', which every seat path already refuses) and recorded in
--    ca_horse_roster_bench so a later refresh can release it if it ranks back
--    in. Horses benched for any other reason are never touched.
-- 2. THE PLO ROSTER. Only horses with 2,000+ PLO cash hands in 30 days AND a
--    net profit at PLO may play any plo* variant. Their cash tags gain
--    plo4/5/6/8 and the 1 and 2 big blinds; every other horse's tags lose
--    plo*. The engine reads ca_horse_plo_roster (HorsePloRoster).
-- 3. THE FLEET CAP. Global fleet policy max_horses = 45.
-- 4. NO GAME ABOVE 0.50/1.00, EXCEPT PLO UP TO 1.00/2.00. Every other open
--    cash game above that is disabled, and a trigger refuses any cash game
--    (new or edited) enabled above it.
-- 5. The roster refreshes daily at 09:15 UTC (04:15 Chicago).
--
-- Result on 2026-10-23: active 45, plo 15, benched 893, plo tags removed 511,
-- plo tags granted 18. NLH 1.00/2.00 closed; PLO4/5/6 1.00/2.00 open.

BEGIN;
set local lock_timeout = '5s';

create table if not exists public.ca_horse_active_roster (
  horse_id uuid primary key references public.profiles(id) on delete cascade,
  rank integer not null, hands bigint not null default 0, bb100 numeric,
  chosen_at timestamptz not null default now());
create table if not exists public.ca_horse_plo_roster (
  horse_id uuid primary key references public.profiles(id) on delete cascade,
  rank integer not null, plo_hands bigint not null default 0, plo_bb100 numeric,
  chosen_at timestamptz not null default now());
create table if not exists public.ca_horse_roster_bench (
  horse_id uuid primary key references public.profiles(id) on delete cascade,
  benched_at timestamptz not null default now());
alter table public.ca_horse_active_roster enable row level security;
alter table public.ca_horse_plo_roster    enable row level security;
alter table public.ca_horse_roster_bench  enable row level security;
revoke all on public.ca_horse_active_roster, public.ca_horse_plo_roster, public.ca_horse_roster_bench from public, anon, authenticated, service_role;
grant select on public.ca_horse_active_roster, public.ca_horse_plo_roster, public.ca_horse_roster_bench to service_role;

create or replace function public.fn_ca_horse_roster_refresh(
  p_size integer default 45, p_min_hands integer default 5000,
  p_min_plo integer default 2000, p_days integer default 30
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_size integer := greatest(1, least(coalesce(p_size, 45), 50));
  v_benched integer := 0; v_released integer := 0; v_active integer := 0; v_plo_n integer := 0;
  v_tags_off integer := 0; v_tags_on integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('fn_ca_horse_roster_refresh'));
  create temp table _perf on commit drop as
  select n.horse_user_id as id, sum(n.hands)::bigint as hands, sum(n.net_bb) as net,
         coalesce(sum(n.hands) filter (where n.game_variant like 'plo%'), 0)::bigint as ph,
         coalesce(sum(n.net_bb) filter (where n.game_variant like 'plo%'), 0) as pn
    from public.horse_daily_nets n
   where n.format in ('cash', 'hu_cash') and n.day >= current_date - p_days
   group by n.horse_user_id;
  create temp table _cand on commit drop as
  select p.id, coalesce(f.hands, 0) as hands,
         case when coalesce(f.hands, 0) > 0 then f.net * 100.0 / f.hands end as bb100,
         coalesce(f.ph, 0) as ph,
         case when coalesce(f.ph, 0) > 0 then f.pn * 100.0 / f.ph end as pbb100,
         (coalesce(f.ph, 0) >= p_min_plo and coalesce(f.pn, 0) > 0) as plo_profitable
    from public.profiles p left join _perf f on f.id = p.id
   where p.is_horse is true and coalesce(p.status, 'active') = 'active'
     and (coalesce(p.horse_status, 'available') <> 'disabled'
          or exists (select 1 from public.ca_horse_roster_bench b where b.horse_id = p.id));

  delete from public.ca_horse_active_roster where true;  -- the roster is rebuilt whole every refresh
  insert into public.ca_horse_active_roster (horse_id, rank, hands, bb100)
  select id, rn, hands, bb100 from (
    select id, hands, bb100, row_number() over (
             order by plo_profitable desc, (hands >= p_min_hands) desc, bb100 desc nulls last, hands desc, id) as rn
      from _cand) r where rn <= v_size;
  get diagnostics v_active = row_count;
  if v_active = 0 then
    raise exception 'fn_ca_horse_roster_refresh: no candidates ranked, nothing changed';
  end if;

  delete from public.ca_horse_plo_roster where true;  -- the roster is rebuilt whole every refresh
  insert into public.ca_horse_plo_roster (horse_id, rank, plo_hands, plo_bb100)
  select id, rn, ph, pbb100 from (
    select c.id, c.ph, c.pbb100, row_number() over (order by c.pbb100 desc, c.id) as rn
      from _cand c join public.ca_horse_active_roster a on a.horse_id = c.id
     where c.plo_profitable) r;
  get diagnostics v_plo_n = row_count;

  update public.stable_hand_membership_tags t
     set variants = array(select v from unnest(t.variants) v where v not like 'plo%')
   where exists (select 1 from unnest(t.variants) v where v like 'plo%')
     and not exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id);
  get diagnostics v_tags_off = row_count;
  update public.stable_hand_membership_tags t
     set variants = array(select distinct v from unnest(t.variants || array['plo4','plo5','plo6','plo8']) v order by 1),
         preferred_stakes = array(select distinct s from unnest(t.preferred_stakes || array[1,2]::numeric[]) s order by 1)
   where coalesce(t.mode, 'both') <> 'tourney'
     and exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id);
  get diagnostics v_tags_on = row_count;

  -- Bench in id order so concurrent writers on profiles cannot deadlock against it.
  with tgt as (
    select p.id from public.profiles p
     where p.is_horse is true and coalesce(p.status, 'active') = 'active'
       and coalesce(p.horse_status, 'available') <> 'disabled'
       and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = p.id)
     order by p.id for update of p
  ), b as (
    update public.profiles p set horse_status = 'disabled', updated_at = now()
      from tgt where tgt.id = p.id
    returning p.id
  ), ins as (
    insert into public.ca_horse_roster_bench (horse_id) select id from b on conflict (horse_id) do nothing returning 1
  )
  select count(*) into v_benched from b;
  perform set_config('app.horse_release', 'on', true);
  with r as (
    update public.profiles p set horse_status = 'available', updated_at = now()
      from public.ca_horse_roster_bench b
     where b.horse_id = p.id and p.horse_status = 'disabled'
       and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = p.id)
    returning p.id
  )
  select count(*) into v_released from r;
  delete from public.ca_horse_roster_bench b using public.ca_horse_active_roster a where a.horse_id = b.horse_id;
  perform set_config('app.horse_release', '', true);
  return jsonb_build_object('ok', true, 'active', v_active, 'plo', v_plo_n, 'benched', v_benched,
                            'released', v_released, 'plo_tags_removed', v_tags_off, 'plo_tags_granted', v_tags_on);
end
$fn$;
revoke all on function public.fn_ca_horse_roster_refresh(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_ca_horse_roster_refresh(integer, integer, integer, integer) to service_role;

create or replace function public.fn_cash_game_max_stake_guard()
returns trigger language plpgsql set search_path to 'public', 'pg_temp'
as $fn$
begin
  if coalesce(new.enabled, false) and coalesce(new.bb, 0) > 1.00
     and not (lower(coalesce(new.variant, '')) like 'plo%' and new.bb <= 2.00) then
    raise exception using errcode = '22023',
      message = 'Cash games are capped at 0.50/1.00 blinds (PLO at 1.00/2.00)';
  end if;
  return new;
end
$fn$;
drop trigger if exists trg_cash_game_max_stake_guard on public.cash_games;
create trigger trg_cash_game_max_stake_guard
  before insert or update of enabled, bb, variant on public.cash_games
  for each row execute function public.fn_cash_game_max_stake_guard();

-- periodic-work: the roster IS the product. Dan's rule is that only the top
-- performers play, and performance moves every day; the daily refresh re-ranks
-- the fleet so a horse that starts losing (or a benched horse that would now
-- rank in) changes places. Nothing upstream is being compensated for.
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'ca-horse-roster-refresh') then
    perform cron.unschedule('ca-horse-roster-refresh');
  end if;
  perform cron.schedule('ca-horse-roster-refresh', '15 9 * * *', 'select public.fn_ca_horse_roster_refresh()');
end
$cron$;

COMMIT;

-- DATA (outside the DDL transaction; see the note at the top).
update public.ca_horse_fleet_policy
   set max_horses = 45,
       notes = coalesce(notes, '') || ' | 2026-10-23: max_horses 45 (Dan: keep it under 35-50 total horses at any time, all game types).',
       updated_at = now()
 where scope = 'global';
update public.cash_games set enabled = false, updated_at = now()
 where enabled is true and closed_at is null and bb > 1.00
   and not (lower(coalesce(variant, '')) like 'plo%' and bb <= 2.00);
select public.fn_ca_horse_roster_refresh();
