-- 20261023182203_the_horse_roster_sizes_itself_to_the_floor_and_keeps_its_hor.sql
-- Version reserved by scripts/new-migration.mjs.
--
-- Dan 2026-10-23 13:18 Chicago: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL
-- OF THESE" - the horse roster improvements:
--
-- 1. THE ROSTER STAYS AT CASH. Measured 18:15 UTC: 38 of the 45 roster horses
--    were in tournaments and only 18 sat at cash across 43 live cash games.
--    The refresh now gives every roster horse a cash-capable tag in each of its
--    club memberships outside the exempt clubs: a tournament-only tag becomes
--    'both', an untagged membership gets a 'both' tag (tag_seed 'roster-cash').
--    The engine (same PR) stops drafting roster horses into tournament fills,
--    so they are free for the cash floor; the other ~890 horses fill events.
-- 2. THE ROSTER SIZES ITSELF TO THE FLOOR. Size = the live cash games outside
--    the exempt clubs, held between 35 and 50 (Dan: "under 35-50"). The refresh
--    runs four times a day (03:15, 09:15, 15:15, 21:15 UTC) so a busy floor
--    gets its horses the same day.
-- 3. THE PLO LIST IS HARDER TO LUCK INTO. A horse needs 5,000 PLO cash hands
--    in 30 days AND at least 1.0 big blind won per 100 PLO hands (was 2,000
--    hands and any profit). 11 horses qualify on 2026-10-23.
-- 4. THE DAILY DIGEST REPORTS THE ROSTER. ca_horse_roster_log keeps every
--    refresh; fn_ca_horse_roster_digest(day) returns the roster and PLO list
--    with each horse's win rate and who was added or dropped that day, and
--    fn_sp_daily_digest carries it as 'horse_roster' (rendered by the World Hub
--    digest email, its own PR).
--
-- Unchanged: every horse plays tournaments; only the roster sits at cash; only
-- the PLO list sits at PLO cash; the Lightning pilot club is exempt from both.

BEGIN;
set local lock_timeout = '5s';

create table if not exists public.ca_horse_roster_log (
  id           bigserial primary key,
  refreshed_at timestamptz not null default now(),
  size         integer not null,
  demand       integer,
  active       uuid[] not null,
  plo          uuid[] not null,
  result       jsonb not null
);
create index if not exists idx_ca_horse_roster_log_refreshed_at on public.ca_horse_roster_log (refreshed_at);
alter table public.ca_horse_roster_log enable row level security;
revoke all on public.ca_horse_roster_log from public, anon, authenticated, service_role;
grant select on public.ca_horse_roster_log to service_role;
revoke all on sequence public.ca_horse_roster_log_id_seq from public, anon, authenticated, service_role;

drop function if exists public.fn_ca_horse_roster_refresh(integer, integer, integer, integer);

create or replace function public.fn_ca_horse_roster_refresh(
  p_size integer default null,
  p_min_hands integer default 5000,
  p_min_plo integer default 5000,
  p_min_plo_bb100 numeric default 1.0,
  p_days integer default 30
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_demand integer := 0;
  v_size integer;
  v_active integer := 0; v_plo_n integer := 0;
  v_restored integer := 0; v_seeded_removed integer := 0;
  v_saved integer := 0; v_cash_off integer := 0; v_seeded integer := 0;
  v_tags_off integer := 0; v_tags_on integer := 0; v_released integer := 0;
  v_exempt_restored integer := 0; v_exempt_seed_removed integer := 0;
  v_cash_up integer := 0; v_cash_seeded integer := 0;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('fn_ca_horse_roster_refresh'));

  -- THE FLOOR: live cash games outside the exempt clubs.
  select count(*) into v_demand
    from public.cash_games g
   where g.enabled is true and g.closed_at is null and g.state = 'live'
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = g.club_id);
  v_size := greatest(35, least(50, coalesce(p_size, v_demand)));

  drop table if exists _perf;
  drop table if exists _cand;
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
         (coalesce(f.ph, 0) >= p_min_plo and coalesce(f.ph, 0) > 0
          and f.pn * 100.0 / f.ph >= p_min_plo_bb100) as plo_profitable
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

  -- RESTORE: a roster horse gets its saved cash tags back.
  update public.stable_hand_membership_tags t
     set mode = b.mode, cash_freeroll = b.cash_freeroll, persona_cash = b.persona_cash,
         persona_mtt = b.persona_mtt, variants = b.variants,
         preferred_stakes = b.preferred_stakes, max_tables = b.max_tables
    from public.ca_horse_roster_cash_tag_backup b
   where b.horse_id = t.horse_id and b.club_id = t.club_id
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id);
  get diagnostics v_restored = row_count;
  delete from public.ca_horse_roster_cash_tag_backup b
   using public.ca_horse_active_roster a where a.horse_id = b.horse_id;
  delete from public.stable_hand_membership_tags t
   where t.tag_seed = 'roster-bench'
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id);
  get diagnostics v_seeded_removed = row_count;

  -- EXEMPT CLUBS (the Lightning pilot): every horse keeps its own tags there.
  update public.stable_hand_membership_tags t
     set mode = b.mode, cash_freeroll = b.cash_freeroll, persona_cash = b.persona_cash,
         persona_mtt = b.persona_mtt, variants = b.variants,
         preferred_stakes = b.preferred_stakes, max_tables = b.max_tables
    from public.ca_horse_roster_cash_tag_backup b
   where b.horse_id = t.horse_id and b.club_id = t.club_id
     and exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id);
  get diagnostics v_exempt_restored = row_count;
  delete from public.ca_horse_roster_cash_tag_backup b
   using public.ca_horse_roster_exempt_clubs x where x.club_id = b.club_id;
  delete from public.stable_hand_membership_tags t
   where t.tag_seed = 'roster-bench'
     and exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id);
  get diagnostics v_exempt_seed_removed = row_count;

  -- CASH OFF: every horse off the roster keeps tournaments, loses cash.
  insert into public.ca_horse_roster_cash_tag_backup
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables)
  select t.horse_id, t.club_id, t.mode, t.cash_freeroll, t.persona_cash, t.persona_mtt,
         t.variants, t.preferred_stakes, t.max_tables
    from public.stable_hand_membership_tags t
   where t.mode in ('cash', 'both')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_saved = row_count;
  update public.stable_hand_membership_tags t
     set mode = 'tourney', cash_freeroll = false, persona_cash = null,
         persona_mtt = coalesce(t.persona_mtt, 'mtt_regular'),
         variants = '{}'::text[], preferred_stakes = '{}'::numeric[], max_tables = 1
   where t.mode in ('cash', 'both')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id);
  get diagnostics v_cash_off = row_count;
  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select distinct cm.user_id, cm.club_id, 'tourney', false, null, 'mtt_regular',
         '{}'::text[], '{}'::numeric[], 1, 'roster-bench'
    from public.club_members cm
    join public.profiles p on p.id = cm.user_id and p.is_horse is true and coalesce(p.status, 'active') = 'active'
   where cm.status in ('active', 'approved')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = cm.user_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = cm.club_id)
     and not exists (select 1 from public.stable_hand_membership_tags t
                      where t.horse_id = cm.user_id and t.club_id = cm.club_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_seeded = row_count;

  -- THE ROSTER STAYS AT CASH: every roster membership outside the exempt clubs
  -- carries a cash-capable tag.
  update public.stable_hand_membership_tags t
     set mode = 'both', cash_freeroll = false, persona_cash = 'regular',
         persona_mtt = coalesce(t.persona_mtt, 'mtt_regular'),
         variants = array['nlh']::text[], preferred_stakes = array[0.5, 1, 2]::numeric[], max_tables = 2
   where t.mode = 'tourney'
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id);
  get diagnostics v_cash_up = row_count;
  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select distinct cm.user_id, cm.club_id, 'both', false, 'regular', 'mtt_regular',
         array['nlh']::text[], array[0.5, 1, 2]::numeric[], 2, 'roster-cash'
    from public.club_members cm
   where cm.status in ('active', 'approved')
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = cm.user_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = cm.club_id)
     and not exists (select 1 from public.stable_hand_membership_tags t
                      where t.horse_id = cm.user_id and t.club_id = cm.club_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_cash_seeded = row_count;

  -- PLO tags (the PLO list only; exempt clubs keep their own).
  update public.stable_hand_membership_tags t
     set variants = array(select v from unnest(t.variants) v where v not like 'plo%')
   where exists (select 1 from unnest(t.variants) v where v like 'plo%')
     and not exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id);
  get diagnostics v_tags_off = row_count;
  update public.stable_hand_membership_tags t
     set variants = array(select distinct v from unnest(t.variants || array['plo4','plo5','plo6','plo8']) v order by 1),
         preferred_stakes = array(select distinct s from unnest(t.preferred_stakes || array[1,2]::numeric[]) s order by 1)
   where coalesce(t.mode, 'both') <> 'tourney'
     and exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id)
     and (exists (select 1 from unnest(array['plo4','plo5','plo6','plo8']) v where not (v = any (t.variants)))
          or not (1 = any (t.preferred_stakes) and 2 = any (t.preferred_stakes)));
  get diagnostics v_tags_on = row_count;

  -- No roster benches anyone (Dan 2026-10-23: they can play tournaments).
  perform set_config('app.horse_release', 'on', true);
  with tgt as (
    select p.id from public.profiles p
      join public.ca_horse_roster_bench b on b.horse_id = p.id
     where p.horse_status = 'disabled'
     order by p.id for update of p
  ), r as (
    update public.profiles p set horse_status = 'available', updated_at = now()
      from tgt where tgt.id = p.id
    returning p.id
  )
  select count(*) into v_released from r;
  delete from public.ca_horse_roster_bench where true;  -- the roster no longer benches anyone
  perform set_config('app.horse_release', '', true);

  v_result := jsonb_build_object('ok', true, 'size', v_size, 'demand', v_demand,
    'active', v_active, 'plo', v_plo_n,
    'cash_tags_restored', v_restored, 'roster_bench_tags_removed', v_seeded_removed,
    'cash_tags_saved', v_saved, 'cash_tags_to_tourney', v_cash_off, 'tourney_tags_seeded', v_seeded,
    'roster_tags_to_cash', v_cash_up, 'roster_cash_tags_seeded', v_cash_seeded,
    'plo_tags_removed', v_tags_off, 'plo_tags_granted', v_tags_on, 'unbenched', v_released,
    'exempt_tags_restored', v_exempt_restored, 'exempt_seed_tags_removed', v_exempt_seed_removed);
  insert into public.ca_horse_roster_log (size, demand, active, plo, result)
  values (v_size, v_demand,
          array(select horse_id from public.ca_horse_active_roster order by rank),
          array(select horse_id from public.ca_horse_plo_roster order by rank),
          v_result);
  return v_result;
end
$fn$;
revoke all on function public.fn_ca_horse_roster_refresh(integer, integer, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.fn_ca_horse_roster_refresh(integer, integer, integer, numeric, integer) to service_role;

-- THE DIGEST LINE: the roster as it stood at the end of the Central day, and
-- what changed against the start of it.
create or replace function public.fn_ca_horse_roster_digest(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_day   date := coalesce(p_day, (now() at time zone 'America/Chicago')::date - 1);
  v_end   timestamptz := ((v_day + 1)::timestamp at time zone 'America/Chicago');
  v_start timestamptz := (v_day::timestamp at time zone 'America/Chicago');
  v_now   public.ca_horse_roster_log%rowtype;
  v_then  public.ca_horse_roster_log%rowtype;
begin
  select * into v_now from public.ca_horse_roster_log
   where refreshed_at < v_end order by refreshed_at desc limit 1;
  if v_now.id is null then
    return null;
  end if;
  select * into v_then from public.ca_horse_roster_log
   where refreshed_at < v_start order by refreshed_at desc limit 1;

  return jsonb_build_object(
    'as_of', v_now.refreshed_at,
    'size', v_now.size,
    'demand', v_now.demand,
    'plo_count', coalesce(array_length(v_now.plo, 1), 0),
    'refreshes_today', (select count(*) from public.ca_horse_roster_log l
                         where l.refreshed_at >= v_start and l.refreshed_at < v_end),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                   'rank', m.ord,
                   'name', coalesce(nullif(p.display_name, ''), p.username, left(m.id::text, 8)),
                   'bb100', round(coalesce(a.bb100, 0), 2),
                   'hands', coalesce(a.hands, 0),
                   'plo', m.id = any (v_now.plo),
                   'plo_bb100', round(r.plo_bb100, 2)) order by m.ord), '[]'::jsonb)
                  from unnest(v_now.active) with ordinality m(id, ord)
                  left join public.profiles p on p.id = m.id
                  left join public.ca_horse_active_roster a on a.horse_id = m.id
                  left join public.ca_horse_plo_roster r on r.horse_id = m.id),
    'added', case when v_then.id is null then '[]'::jsonb else
               (select coalesce(jsonb_agg(coalesce(nullif(p.display_name, ''), p.username, left(x::text, 8))), '[]'::jsonb)
                  from unnest(v_now.active) x left join public.profiles p on p.id = x
                 where not (x = any (v_then.active))) end,
    'dropped', case when v_then.id is null then '[]'::jsonb else
               (select coalesce(jsonb_agg(coalesce(nullif(p.display_name, ''), p.username, left(x::text, 8))), '[]'::jsonb)
                  from unnest(v_then.active) x left join public.profiles p on p.id = x
                 where not (x = any (v_now.active))) end,
    'plo_added', case when v_then.id is null then '[]'::jsonb else
               (select coalesce(jsonb_agg(coalesce(nullif(p.display_name, ''), p.username, left(x::text, 8))), '[]'::jsonb)
                  from unnest(v_now.plo) x left join public.profiles p on p.id = x
                 where not (x = any (v_then.plo))) end,
    'plo_dropped', case when v_then.id is null then '[]'::jsonb else
               (select coalesce(jsonb_agg(coalesce(nullif(p.display_name, ''), p.username, left(x::text, 8))), '[]'::jsonb)
                  from unnest(v_then.plo) x left join public.profiles p on p.id = x
                 where not (x = any (v_now.plo))) end);
end
$fn$;
revoke all on function public.fn_ca_horse_roster_digest(date) from public, anon, authenticated;
grant execute on function public.fn_ca_horse_roster_digest(date) to service_role;

-- fn_sp_daily_digest carries the roster line ('horse_roster'). The function is
-- re-created from its live definition with one key added, so this does not
-- restate (and cannot drift from) the digest's other 100 lines.
do $dg$
declare d text;
begin
  d := pg_get_functiondef('public.fn_sp_daily_digest(date,boolean)'::regprocedure);
  if position('horse_roster' in d) = 0 then
    if position('''generated_at'', clock_timestamp());' in d) = 0 then
      raise exception 'fn_sp_daily_digest: the generated_at anchor moved; add horse_roster by hand';
    end if;
    d := replace(d, '''generated_at'', clock_timestamp());',
                 '''horse_roster'', public.fn_ca_horse_roster_digest(v_day),' || chr(10)
                 || '    ''generated_at'', clock_timestamp());');
    execute d;
  end if;
end
$dg$;

-- periodic-work: the roster IS the product, and its size now follows the live
-- cash floor; four refreshes a day let a floor that fills in the afternoon get
-- its horses that afternoon. Nothing upstream is being compensated for.
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'ca-horse-roster-refresh') then
    perform cron.unschedule('ca-horse-roster-refresh');
  end if;
  perform cron.schedule('ca-horse-roster-refresh', '15 3,9,15,21 * * *', 'select public.fn_ca_horse_roster_refresh()');
end
$cron$;

COMMIT;

-- DATA (outside the DDL transaction).
select public.fn_ca_horse_roster_refresh();
