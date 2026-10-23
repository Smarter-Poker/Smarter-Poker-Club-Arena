-- 20261023220839_midway_lightning_fill_and_all_horse_limits_removed.sql
--
-- Dan 2026-10-23 16:35 CT: "make sure horses are added". At 21:47 UTC 89 of
-- the 100 fill horses chosen by 20261023213842 were seated in Friday-evening
-- tournaments (1 to 4 tables each; the selection had read a tournament
-- table's NULL lifecycle as closed), and their Midway tag allowed one table,
-- so none could take the Lightning seat. Now:
-- 1. The fill list is rebuilt from the Midway horses holding the FEWEST open
--    seats of any kind (none were seated in a fill game yet).
-- 2. A fill horse's Midway tag allows four tables, so a horse finishing a
--    tournament still has room for its Lightning seat.
-- 3. Dan 2026-10-23 16:50 CT: "remove any and all restrictions that are on
--    the horses for playing games". The seat guard no longer holds a fill
--    horse to its own game, and ANY horse may sit a Lightning-enabled game
--    (no cash-roster or PLO-roster check there).

BEGIN;
set local lock_timeout = '5s';
set local statement_timeout = '60s';



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
  v_cluster  uuid;
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

  select t.tournament_id, lower(coalesce(t.game_variant, '')), t.big_blind, t.club_id, t.cluster_id
    into v_tourney, v_variant, v_bb, v_club, v_cluster
    from public.tables t where t.id = new.table_id;
  if v_tourney is not null then
    return new;  -- every horse plays tournaments
  end if;

  -- A Lightning game takes any horse (Dan 2026-10-23 16:50 CT: "remove any
  -- and all restrictions that are on the horses for playing games").
  if v_cluster is not null and exists (select 1 from public.cash_games g
                                        where g.id = v_cluster and g.lightning_enabled) then
    return new;
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

do $fill$
declare
  v_club constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_nlh  constant uuid := 'b3c63129-9377-4c61-9f62-089893a20c66';
  v_plo  constant uuid := '705270cd-03c2-40d9-8749-038f741a295c';
  v_note constant text := 'Dan 2026-10-23: 50 horses play the Midway 0.25/0.50 Madness Lightning test game';
  v_n integer;
begin
  -- Horses already holding a seat in their fill game keep their place.
  create temp table _keep on commit drop as
  select f.horse_id, f.cluster_id from public.lightning_horse_fill f
   where exists (select 1 from public.table_seats s join public.tables t on t.id = s.table_id
                  where s.user_id = f.horse_id and s.left_at is null and t.cluster_id = f.cluster_id);
  create temp table _dropped on commit drop as
  select f.horse_id, f.club_id from public.lightning_horse_fill f
   where not exists (select 1 from _keep k where k.horse_id = f.horse_id);
  delete from public.lightning_horse_fill f where exists (select 1 from _dropped d where d.horse_id = f.horse_id);

  -- Their Midway tag goes back to the roster's bench shape.
  update public.stable_hand_membership_tags t
     set mode = 'tourney', cash_freeroll = false, persona_cash = null,
         persona_mtt = coalesce(t.persona_mtt, 'mtt_regular'),
         variants = '{}'::text[], preferred_stakes = '{}'::numeric[], max_tables = 1,
         tag_seed = 'roster-bench'
    from _dropped d
   where t.horse_id = d.horse_id and t.club_id = d.club_id and t.tag_seed = 'lightning-fill';

  with pilot as (select unnest(a.player_ids) as id from public.lightning_pilot_assignment a where a.active),
  cand as (
    select m.user_id as id,
           (select count(*) from public.table_seats s join public.tables t on t.id = s.table_id
             where s.user_id = m.user_id and s.left_at is null
               and coalesce(t.lifecycle, 'live') <> 'closed') as seats
      from public.club_members m
      join public.profiles p on p.id = m.user_id and p.is_horse is true
                            and coalesce(p.status, 'active') = 'active'
                            and coalesce(p.horse_status, 'available') <> 'disabled'
     where m.club_id = v_club and m.status in ('active', 'approved')
       and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = m.user_id)
       and not exists (select 1 from pilot where pilot.id = m.user_id)
       and not exists (select 1 from public.stable_hand_horse_state hs
                        where hs.horse_id = m.user_id and hs.rest_weekday in (5, 6))
       and not exists (select 1 from _keep k where k.horse_id = m.user_id)
  ),
  ranked as (
    select id, row_number() over (order by seats, md5(id::text || ':midway-lightning-fill')) as rn from cand
  ),
  need as (
    select greatest(0, 50 - (select count(*) from _keep where cluster_id = v_nlh)) as nlh,
           greatest(0, 50 - (select count(*) from _keep where cluster_id = v_plo)) as plo
  )
  insert into public.lightning_horse_fill (horse_id, cluster_id, club_id, note)
  select r.id, case when r.rn <= n.nlh then v_nlh else v_plo end, v_club, v_note
    from ranked r cross join need n
   where r.rn <= n.nlh + n.plo;

  select count(*) into v_n from public.lightning_horse_fill where cluster_id in (v_nlh, v_plo);
  if v_n <> 100 then
    raise exception 'expected 100 fill horses, found %; nothing changed', v_n;
  end if;

  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select f.horse_id, f.club_id, 'cash', false, 'grinder', 'mtt_regular',
         case when f.cluster_id = v_nlh then array['nlh'] else array['plo4'] end,
         array[0.5]::numeric[], 4, 'lightning-fill'
    from public.lightning_horse_fill f
   where f.cluster_id in (v_nlh, v_plo)
  on conflict (horse_id, club_id) do update
     set mode = 'cash', cash_freeroll = false, persona_cash = 'grinder',
         variants = excluded.variants, preferred_stakes = excluded.preferred_stakes,
         max_tables = 4, tag_seed = 'lightning-fill';

  update public.stable_hand_horse_state s
     set daily_cap_minutes = 960, updated_at = now()
   where s.horse_id in (select f.horse_id from public.lightning_horse_fill f)
     and s.daily_cap_minutes < 960;
end
$fill$;

-- 4. Dan 2026-10-23 16:52 CT: "remove all limits for now." Every club joins
--    ca_horse_roster_exempt_clubs, the one list every roster rule already
--    honours: the seat guard (no cash-roster or PLO-roster refusal), the
--    roster refresh (no cash tag benched to tourney, the saved cash tags put
--    back), and the engine's fleet and session rotator. Undo by deleting the
--    rows whose note starts 'Dan 2026-10-23 16:52'.
insert into public.ca_horse_roster_exempt_clubs (club_id, note)
select c.id, 'Dan 2026-10-23 16:52 CT: remove all limits for now'
  from public.clubs c
on conflict (club_id) do nothing;

-- One refresh now, so the saved cash tags come back and the bench tags go.
select public.fn_ca_horse_roster_refresh(50, 5000, 2000, 1.0, 90);

do $chk$
begin
  if exists (select 1 from public.clubs c
              where not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = c.id)) then
    raise exception 'a club is still under the horse roster';
  end if;
  if exists (select 1 from public.stable_hand_membership_tags t where t.tag_seed = 'roster-bench') then
    raise exception 'bench tags remain after the refresh';
  end if;
end
$chk$;

COMMIT;
