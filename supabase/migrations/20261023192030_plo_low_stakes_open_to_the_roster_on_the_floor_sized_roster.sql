-- 20261023192030_plo_low_stakes_open_to_the_roster_on_the_floor_sized_roster.sql
-- Version reserved by scripts/new-migration.mjs.
--
-- TWO SESSIONS, ONE ROSTER. 20261023175910 (another session, Dan 2026-10-23
-- 12:59: "all horses can play the lower stakes plo games under .10-.25 and
-- .25-.50") reached main without being applied: its seat-door stake split was
-- never live, and its refresh body was superseded by 20261023182203 (the
-- floor-sized roster, applied 18:25 UTC). This puts both together:
--
-- 1. THE SEAT DOOR: PLO at 0.50 big blind or less is open to every cash-roster
--    horse; above it, only the PLO list. The exempt clubs (Lightning pilot)
--    stay outside both rules, which 20261023175910's copy dropped.
-- 2. THE REFRESH: 20261023182203 (size follows the live cash floor, 35 to 50,
--    four refreshes a day; the roster keeps cash tags; the PLO list needs
--    5,000 PLO hands and 1.0 BB/100; every refresh logged for the digest) with
--    20261023175910's PLO tags (every roster cash tag carries the PLO variants
--    and 0.25 / 0.50; the PLO list also carries 1 and 2; no PLO tag removed)
--    and its PLO cash lane (lane 'cash', 16 hour cap).
-- 3. 20261023175910 is recorded as applied in schema_migrations alongside this
--    one: replayed in version order, every object it creates is replaced
--    here, so the final state is the same.

BEGIN;
set local lock_timeout = '5s';

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

  -- PLO TAGS (Dan 2026-10-23 12:59: "all horses can play the lower stakes plo
  -- games under .10-.25 and .25-.50"). The low stakes are open to every
  -- cash-roster horse; 0.50/1 and up stay with the PLO list, and the seat door
  -- enforces that split. So every roster cash tag carries the PLO variants and
  -- 0.25 / 0.50, and the PLO list's tags carry 1 and 2 as well. No PLO tag is
  -- removed. Exempt clubs keep their own tags. Only rows missing something are
  -- written.
  v_tags_off := 0;
  update public.stable_hand_membership_tags t
     set variants = array(select distinct v from unnest(t.variants || array['plo4','plo5','plo6','plo8']) v order by 1),
         preferred_stakes = array(select distinct s from unnest(
             t.preferred_stakes || array[0.25,0.5]::numeric[]
             || case when exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id)
                     then array[1,2]::numeric[] else '{}'::numeric[] end) s order by 1)
   where coalesce(t.mode, 'both') <> 'tourney'
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id)
     and (exists (select 1 from unnest(array['plo4','plo5','plo6','plo8']) v where not (v = any (coalesce(t.variants, '{}'))))
          or not (0.25 = any (coalesce(t.preferred_stakes, '{}')) and 0.5 = any (coalesce(t.preferred_stakes, '{}')))
          or (exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id)
              and not (1 = any (coalesce(t.preferred_stakes, '{}')) and 2 = any (coalesce(t.preferred_stakes, '{}')))));
  get diagnostics v_tags_on = row_count;

  -- THE PLO LIST PLAYS PLO CASH (20261023175910): lane 'cash' (the tournament
  -- scheduler registers no cash-lane horse) and a daily cap of at least 16
  -- hours. A horse that leaves the PLO list gets lane 'both' back.
  update public.profiles p
     set horse_profile = coalesce(p.horse_profile, '{}'::jsonb)
                         || jsonb_build_object('lane', 'cash', 'ploCashLane', true),
         updated_at = now()
   where p.id in (select r.horse_id from public.ca_horse_plo_roster r)
     and (coalesce(p.horse_profile->>'lane', '') <> 'cash'
          or coalesce(p.horse_profile->>'ploCashLane', '') <> 'true');
  update public.profiles p
     set horse_profile = (coalesce(p.horse_profile, '{}'::jsonb) - 'ploCashLane')
                         || jsonb_build_object('lane', 'both'),
         updated_at = now()
   where p.horse_profile->>'ploCashLane' = 'true'
     and p.id not in (select r.horse_id from public.ca_horse_plo_roster r);
  update public.stable_hand_horse_state s
     set daily_cap_minutes = 960, updated_at = now()
   where s.horse_id in (select r.horse_id from public.ca_horse_plo_roster r)
     and s.daily_cap_minutes < 960;

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

-- THE SEAT DOOR: 20261023175910's stake split, plus the exempt clubs
-- (20261023175018), which that migration's copy did not carry.
create or replace function public.fn_ca_horse_roster_seat_guard()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $fn$
declare
  v_is_horse boolean;
  v_tourney  uuid;
  v_variant  text;
  v_bb       numeric;
  v_club     uuid;
begin
  if new.left_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.left_at is null
     and old.user_id is not distinct from new.user_id
     and old.table_id is not distinct from new.table_id then
    return new;
  end if;

  select p.is_horse into v_is_horse from public.profiles p where p.id = new.user_id;
  if v_is_horse is not true then
    return new;
  end if;

  select t.tournament_id, lower(coalesce(t.game_variant, '')), t.big_blind, t.club_id
    into v_tourney, v_variant, v_bb, v_club
    from public.tables t where t.id = new.table_id;
  if v_tourney is not null then
    return new;  -- every horse plays tournaments
  end if;
  if exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = v_club) then
    return new;  -- the Lightning pilot keeps every one of its horses
  end if;

  -- A move inside the same game is the game's, not a new sit.
  if new.active_game_scope is not null and exists (
       select 1 from public.table_seats s
        where s.user_id = new.user_id and s.left_at is null
          and s.active_game_scope = new.active_game_scope
          and s.table_id is distinct from new.table_id) then
    return new;
  end if;

  if not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = new.user_id) then
    raise exception using errcode = '42501',
      message = 'horse_not_on_cash_roster: only the active horse roster plays cash games';
  end if;
  -- 0.10/0.25 and 0.25/0.50 PLO are open to every cash-roster horse (Dan
  -- 2026-10-23 12:59); the PLO list gates 0.50/1 and up. An unknown blind is
  -- not open. Mirrors isOpenStakePlo in server/src/services/HorsePloRoster.ts.
  if v_variant like 'plo%'
     and not (v_bb is not null and v_bb > 0 and v_bb <= 0.5)
     and not exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = new.user_id) then
    raise exception using errcode = '42501',
      message = 'horse_not_on_plo_roster: only horses with a proven PLO profit play PLO above 0.25/0.50';
  end if;
  return new;
exception
  when insufficient_privilege then raise;
  when others then return new;
end
$fn$;
revoke all on function public.fn_ca_horse_roster_seat_guard() from public, anon, authenticated;

update public.ca_declared_money_triggers
   set note = 'Refuses a NEW live cash seat for a horse off ca_horse_active_roster, or a PLO cash seat above 0.50 big blind for a horse off ca_horse_plo_roster, outside the exempt clubs (Dan 2026-10-23: benched horses play tournaments, not cash; 0.10/0.25 and 0.25/0.50 PLO are open to every cash horse; the Lightning pilot is exempt). Moves no chips and writes nothing: it only raises insufficient_privilege before the row exists. Tournament seats and same-game moves pass; any other failure fails open.'
 where table_name = 'table_seats' and trigger_name = 'zzzzzz_horse_roster_seat_guard';

COMMIT;

-- DATA (outside the DDL transaction).
select public.fn_ca_horse_roster_refresh();
