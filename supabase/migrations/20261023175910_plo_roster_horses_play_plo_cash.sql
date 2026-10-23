-- 20261023175910_plo_roster_horses_play_plo_cash.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-23 12:46: "plo games are showing 0 players playing... this
-- needs to be fixed right now!" and 12:59: "all horses can play the lower
-- stakes plo games under .10-.25 and .25-.50. make sure thats enabled".
--
-- Measured 17:50 UTC: 42 live PLO cash tables in Midway Union, 3 horses
-- seated across all of them. The 15 horses on ca_horse_plo_roster (the only
-- horses allowed at PLO) held 46 running tournament seats and 141 tournament
-- bookings between them, so the four-game limit kept every one of them off
-- the PLO cash floor. Root cause: the PLO gate kept every horse but those 15
-- off PLO at every stake, and those 15 were free to fill up on tournaments.
--
-- 1. THE SEAT DOOR (fn_ca_horse_roster_seat_guard): a PLO cash table at 0.50
--    big blind or less is open to every cash-roster horse; above it, only the
--    PLO roster. Same split as the engine (HorsePloRoster.isOpenStakePlo).
-- 2. THE DAILY REFRESH (fn_ca_horse_roster_refresh): every cash tag on the
--    roster carries the PLO variants and the 0.25 / 0.50 stakes; the PLO
--    roster also carries 1 and 2 and plays the cash lane (no new tournament
--    registrations) with a 16 hour daily cap.
--
-- Data applied at 17:57 UTC and recorded here: the 15 PLO roster horses set
-- to lane 'cash', and 131 of their pending tournament bookings unregistered
-- through fn_ca_unregister_tournament_player_exact (full refunds through the
-- platform's own path; one satellite-won entry kept).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
set local lock_timeout = '5s';

create or replace function public.fn_ca_horse_roster_refresh(
  p_size integer default 45, p_min_hands integer default 5000,
  p_min_plo integer default 2000, p_days integer default 30
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_size integer := greatest(1, least(coalesce(p_size, 45), 50));
  v_active integer := 0; v_plo_n integer := 0;
  v_restored integer := 0; v_seeded_removed integer := 0;
  v_saved integer := 0; v_cash_off integer := 0; v_seeded integer := 0;
  v_tags_off integer := 0; v_tags_on integer := 0; v_released integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('fn_ca_horse_roster_refresh'));
  create temp table _perf on commit drop as
  select n.horse_user_id as id, sum(n.hands)::bigint as hands, sum(n.net_bb) as net,
         coalesce(sum(n.hands) filter (where n.game_variant like 'plo%'), 0)::bigint as ph,
         coalesce(sum(n.net_bb) filter (where n.game_variant like 'plo%'), 0) as pn
    from public.horse_daily_nets n
   where n.format in ('cash', 'hu_cash') and n.day >= current_date - p_days
   group by n.horse_user_id;
  -- Candidates: every active horse that is not benched for another reason.
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

  -- CASH OFF: every horse off the roster keeps tournaments, loses cash.
  insert into public.ca_horse_roster_cash_tag_backup
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables)
  select t.horse_id, t.club_id, t.mode, t.cash_freeroll, t.persona_cash, t.persona_mtt,
         t.variants, t.preferred_stakes, t.max_tables
    from public.stable_hand_membership_tags t
   where t.mode in ('cash', 'both')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_saved = row_count;
  update public.stable_hand_membership_tags t
     set mode = 'tourney', cash_freeroll = false, persona_cash = null,
         persona_mtt = coalesce(t.persona_mtt, 'mtt_regular'),
         variants = '{}'::text[], preferred_stakes = '{}'::numeric[], max_tables = 1
   where t.mode in ('cash', 'both')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id);
  get diagnostics v_cash_off = row_count;
  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select distinct cm.user_id, cm.club_id, 'tourney', false, null, 'mtt_regular',
         '{}'::text[], '{}'::numeric[], 1, 'roster-bench'
    from public.club_members cm
    join public.profiles p on p.id = cm.user_id and p.is_horse is true and coalesce(p.status, 'active') = 'active'
   where cm.status in ('active', 'approved')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = cm.user_id)
     and not exists (select 1 from public.stable_hand_membership_tags t
                      where t.horse_id = cm.user_id and t.club_id = cm.club_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_seeded = row_count;

  -- PLO TAGS (Dan 2026-10-23 12:59). The low stakes, 0.10/0.25 and
  -- 0.25/0.50, are open to every cash-roster horse; 0.50/1 and up stay with
  -- the proven PLO winners, and the seat door below enforces that split. So
  -- every cash tag on the roster carries the PLO variants and the low stakes,
  -- and the PLO roster's tags carry 1 and 2 as well. No PLO tag is removed.
  v_tags_off := 0;
  update public.stable_hand_membership_tags t
     set variants = array(select distinct v from unnest(t.variants || array['plo4','plo5','plo6','plo8']) v order by 1),
         preferred_stakes = array(select distinct s from unnest(
             t.preferred_stakes || array[0.25,0.5]::numeric[]
             || case when exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = t.horse_id)
                     then array[1,2]::numeric[] else '{}'::numeric[] end) s order by 1)
   where coalesce(t.mode, 'both') <> 'tourney'
     and exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id);
  get diagnostics v_tags_on = row_count;

  -- THE PLO WINNERS PLAY PLO CASH, NOT TOURNAMENTS. Fifteen horses qualify,
  -- and on 2026-10-23 every one of them was tied up in running tournaments
  -- with 141 more bookings queued, so the PLO cash tables sat empty. Their
  -- lane is 'cash' (TournamentRecurringService registers no cash-lane horse)
  -- and their daily cap is at least 16 hours. A horse that leaves the PLO
  -- roster gets lane 'both' back so it is not stranded with no game at all.
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

  -- THE BENCH IS LIFTED: horses the roster disabled play tournaments again.
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

  return jsonb_build_object('ok', true, 'active', v_active, 'plo', v_plo_n,
    'cash_tags_restored', v_restored, 'roster_bench_tags_removed', v_seeded_removed,
    'cash_tags_saved', v_saved, 'cash_tags_to_tourney', v_cash_off, 'tourney_tags_seeded', v_seeded,
    'plo_tags_removed', v_tags_off, 'plo_tags_granted', v_tags_on, 'unbenched', v_released);
end
$fn$;
revoke all on function public.fn_ca_horse_roster_refresh(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_ca_horse_roster_refresh(integer, integer, integer, integer) to service_role;

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

  select t.tournament_id, lower(coalesce(t.game_variant, '')), t.big_blind
    into v_tourney, v_variant, v_bb
    from public.tables t where t.id = new.table_id;
  if v_tourney is not null then
    return new;  -- every horse plays tournaments
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
  -- 2026-10-23 12:59); the PLO roster gates 0.50/1 and up. An unknown blind
  -- is not open. Mirrors isOpenStakePlo in server/src/services/HorsePloRoster.ts.
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
   set note = 'Refuses a NEW live cash seat for a horse off ca_horse_active_roster, or a PLO cash seat above 0.50 big blind for a horse off ca_horse_plo_roster (Dan 2026-10-23: benched horses play tournaments, not cash; 0.10/0.25 and 0.25/0.50 PLO are open to every cash horse). Moves no chips and writes nothing: it only raises insufficient_privilege before the row exists. Tournament seats and same-game moves pass; any other failure fails open.'
 where table_name = 'table_seats' and trigger_name = 'zzzzzz_horse_roster_seat_guard';

COMMIT;

-- DATA (outside the DDL transaction, as in 20261023160921).
select public.fn_ca_horse_roster_refresh();
