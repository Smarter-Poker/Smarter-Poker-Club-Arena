-- midway_madness_lightning_test_games_keep_fifty_horses_each
--
-- Dan 2026-10-23 16:13 CT: "launch this inside of the ... midway union for
-- holdem and plo and I'll bug test it there. make sure the horses are all
-- playing 50 horses need to join both holdem and plo, only open it for
-- madness though." and 16:23 CT: "well make them madness games for the
-- .25/.50 games. it needs to be tested for holdem and plo".
--
-- The two games are Midway Union's six-seat Madness games at 0.25/0.50:
--   NLH  0.25/0.50 Madness  b3c63129-9377-4c61-9f62-089893a20c66
--   PLO4 0.25/0.50 Madness  705270cd-03c2-40d9-8749-038f741a295c
-- Lightning was switched on for both through fn_lightning_operator_control
-- (owner as caller, worker form) at 21:30 UTC; PLO4 was woken through
-- fn_cash_game_ensure first.
--
-- 1. lightning_horse_fill names fifty Midway horses per game. A fill horse
--    takes a new cash seat ONLY in its own game (seat guard), and in that
--    game it is outside the cash roster (same seat guard). Its Midway tag
--    is a cash tag for exactly that variant and stake, one table.
-- 2. The roster refresh leaves a fill horse's Midway tag alone (it would
--    otherwise turn it back to tourney at the next 03:15 / 09:15 UTC run).
-- 3. Thresholds 40 on / 30 off and cap_mains 11 (12 tables, 72 chairs): the
--    game fills as must-move until about forty are seated, then turns
--    Lightning with the whole fifty in the pool.
-- Moves no chips: every Midway horse already holds 10,000 in its wallet.

BEGIN;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.lightning_horse_fill (
  horse_id   uuid primary key references public.profiles(id) on delete cascade,
  cluster_id uuid not null references public.cash_games(id) on delete cascade,
  club_id    uuid not null references public.clubs(id) on delete cascade,
  note       text not null,
  created_at timestamptz not null default now()
);
create index if not exists lightning_horse_fill_cluster_idx on public.lightning_horse_fill (cluster_id);
alter table public.lightning_horse_fill enable row level security;
revoke all on public.lightning_horse_fill from public, anon, authenticated, service_role;
grant select on public.lightning_horse_fill to service_role;

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
  v_fill     uuid;
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

  -- A Lightning fill horse (Dan 2026-10-23) plays its own test game and no
  -- other cash game, roster or not.
  select f.cluster_id into v_fill from public.lightning_horse_fill f where f.horse_id = new.user_id;
  if v_fill is not null then
    if v_cluster is not distinct from v_fill then
      return new;
    end if;
    raise exception using errcode = '42501',
      message = 'horse_in_lightning_fill: this horse plays only its Lightning test game';
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

-- The roster refresh as installed by 20261023192030, with the fill horses'
-- tags in their fill club left alone by the two statements that bench cash
-- tags. Refuses if the body is not the one this was written against.
do $refresh$
declare
  v_sig constant regprocedure := 'public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer)'::regprocedure;
  v_def text := pg_get_functiondef(v_sig);
  v_old constant text :=
    E'     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)\n'
    || E'     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id)';
  v_new constant text := v_old
    || E'\n     and not exists (select 1 from public.lightning_horse_fill f where f.horse_id = t.horse_id and f.club_id = t.club_id)';
  v_count integer;
begin
  if md5(v_def) is distinct from 'ca46a2b62828e3aa3ee27b06db9ee9ea' then
    raise exception 'fn_ca_horse_roster_refresh changed since this was written (%); nothing changed', md5(v_def);
  end if;
  v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_count <> 2 then
    raise exception 'expected the bench clause twice, found %; nothing changed', v_count;
  end if;
  execute replace(v_def, v_old, v_new);
end
$refresh$;
revoke all on function public.fn_ca_horse_roster_refresh(integer, integer, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.fn_ca_horse_roster_refresh(integer, integer, integer, numeric, integer) to service_role;

do $fill$
declare
  v_club constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_nlh  constant uuid := 'b3c63129-9377-4c61-9f62-089893a20c66';
  v_plo  constant uuid := '705270cd-03c2-40d9-8749-038f741a295c';
  v_on   constant integer := 40;
  v_off  constant integer := 30;
  v_note constant text := 'Dan 2026-10-23: 50 horses play the Midway 0.25/0.50 Madness Lightning test game';
  g record;
  r jsonb;
  v_n integer;
begin
  for g in select * from public.cash_games where id in (v_nlh, v_plo) order by id for update loop
    if g.club_id is distinct from v_club or g.template_name <> 'madness' or g.handedness <> 6
       or g.bb <> 0.50 or g.must_move is not true or g.enabled is not true
       or g.lightning_enabled is not true
       or g.variant <> (case when g.id = v_nlh then 'nlh' else 'plo4' end) then
      raise exception 'game % is not the expected Midway Madness Lightning game; nothing changed', g.id;
    end if;
    update public.cash_games
       set ruleset_snapshot = jsonb_set(coalesce(ruleset_snapshot, '{}'::jsonb), '{lightning}',
             coalesce(ruleset_snapshot->'lightning', '{}'::jsonb)
             || jsonb_build_object('on_threshold', v_on, 'off_threshold', v_off)),
           cap_mains = greatest(cap_mains, 11),
           updated_at = now()
     where id = g.id;
    r := public.fn_cash_cluster_lightning_thresholds(g.id);
    if not (r @> jsonb_build_object('on', v_on, 'off', v_off, 'source', 'ruleset', 'rejected', '[]'::jsonb)) then
      raise exception 'game % threshold readback is not % / %: %', g.id, v_on, v_off, r;
    end if;
  end loop;
  if (select count(*) from public.cash_games where id in (v_nlh, v_plo)) <> 2 then
    raise exception 'expected both games';
  end if;

  -- Fifty per game from Midway's own horses: approved members, active and not
  -- disabled, not on the cash roster (it keeps its own games), not in the
  -- Lightning pilot assignment. Horses holding no cash seat right now first.
  with pilot as (select unnest(a.player_ids) as id from public.lightning_pilot_assignment a where a.active),
  cand as (
    select m.user_id as id,
           exists (select 1 from public.table_seats s join public.tables t on t.id = s.table_id
                    where s.user_id = m.user_id and s.left_at is null and t.tournament_id is null
                      and t.lifecycle <> 'closed') as seated
      from public.club_members m
      join public.profiles p on p.id = m.user_id and p.is_horse is true
                            and coalesce(p.status, 'active') = 'active'
                            and coalesce(p.horse_status, 'available') <> 'disabled'
     where m.club_id = v_club and m.status in ('active', 'approved')
       and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = m.user_id)
       and not exists (select 1 from pilot where pilot.id = m.user_id)
       -- not resting tonight or tomorrow (Fri 5, Sat 6 in either weekday numbering)
       and not exists (select 1 from public.stable_hand_horse_state hs
                        where hs.horse_id = m.user_id and hs.rest_weekday in (5, 6))
       and not exists (select 1 from public.lightning_horse_fill f where f.horse_id = m.user_id)
  ),
  ranked as (
    select id, row_number() over (order by seated, md5(id::text || ':midway-lightning-fill')) as rn from cand
  )
  insert into public.lightning_horse_fill (horse_id, cluster_id, club_id, note)
  select id, case when rn <= 50 then v_nlh else v_plo end, v_club, v_note
    from ranked where rn <= 100;
  select count(*) into v_n from public.lightning_horse_fill where cluster_id in (v_nlh, v_plo);
  if v_n <> 100 then
    raise exception 'expected 100 fill horses, found %; nothing changed', v_n;
  end if;

  -- Their Midway tag: cash, this game's variant and stake, one table.
  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select f.horse_id, f.club_id, 'cash', false, 'grinder', 'mtt_regular',
         case when f.cluster_id = v_nlh then array['nlh'] else array['plo4'] end,
         array[0.5]::numeric[], 1, 'lightning-fill'
    from public.lightning_horse_fill f
   where f.cluster_id in (v_nlh, v_plo)
  on conflict (horse_id, club_id) do update
     set mode = 'cash', cash_freeroll = false, persona_cash = 'grinder',
         variants = excluded.variants, preferred_stakes = excluded.preferred_stakes,
         max_tables = 1, tag_seed = 'lightning-fill';

  -- They play the evening through: the PLO list's cap.
  update public.stable_hand_horse_state s
     set daily_cap_minutes = 960, updated_at = now()
   where s.horse_id in (select f.horse_id from public.lightning_horse_fill f)
     and s.daily_cap_minutes < 960;
end
$fill$;

COMMIT;