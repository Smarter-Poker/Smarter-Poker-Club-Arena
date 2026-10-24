-- 20261023221116_cash_horses_are_bankroll_only_and_closed_counts_are_truthful.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';

-- Owner October 23: fifty cash horses, eligibility by bankroll only.
-- Historical win rates, fixed variant/stake tags and activity texture must
-- not prevent this pool playing affordable Holdem/PLO. Preserve independent
-- pilot-fill horses, occupied seats, ordinary player rules and money paths.
-- Keep the existing fifty first; replacements are ranked by bankroll, not profit.
-- Closed admission is not table closure. Only truly closed EMPTY cash tables
-- have their stale display count corrected. No seat or wallet is changed.
do $baseline$
begin
  if md5(pg_get_functiondef('public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer)'::regprocedure)) <> '3bf4db40450d39decb96b61b12daed96'
     or md5(pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure)) <> '3333770871b2d064596c2c7a333fea70'
     or md5(pg_get_functiondef('public.trg_auto_cashout_on_table_close()'::regprocedure)) <> 'a936bf2b604a14a6ae620e6b3db852f0' then
    raise exception 'Cash horse/lifecycle source changed since qualification; inspect before applying';
  end if;
end
$baseline$;

CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_refresh(p_size integer DEFAULT NULL::integer, p_min_hands integer DEFAULT 5000, p_min_plo integer DEFAULT 5000, p_min_plo_bb100 numeric DEFAULT 1.0, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_size := 50; -- owner: fifty cash horses, no performance-based pool size

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
         coalesce((select a.rank from public.ca_horse_active_roster a where a.horse_id = p.id), 2147483647) as roster_rank,
         coalesce((select sum(cm.chip_balance) from public.club_members cm
                   where cm.user_id = p.id and cm.status in ('active','approved')), 0) as bankroll,
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
             order by roster_rank, bankroll desc, id) as rn
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
     ) r;
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
     and not exists (select 1 from public.lightning_horse_fill f where f.horse_id = t.horse_id and f.club_id = t.club_id)
  on conflict (horse_id, club_id) do nothing;
  get diagnostics v_saved = row_count;
  update public.stable_hand_membership_tags t
     set mode = 'tourney', cash_freeroll = false, persona_cash = null,
         persona_mtt = coalesce(t.persona_mtt, 'mtt_regular'),
         variants = '{}'::text[], preferred_stakes = '{}'::numeric[], max_tables = 1
   where t.mode in ('cash', 'both')
     and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id = t.horse_id)
     and not exists (select 1 from public.ca_horse_roster_exempt_clubs x where x.club_id = t.club_id)
     and not exists (select 1 from public.lightning_horse_fill f where f.horse_id = t.horse_id and f.club_id = t.club_id);
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

  -- All fifty can choose any cash variant/stake their roll covers. The
  -- engine also ignores persona/activity gates; these tags keep old readers
  -- compatible during the protected engine transition.
  update public.stable_hand_membership_tags t
     set mode = 'both', cash_freeroll = false, persona_cash = 'grinder',
         variants = array['nlh','plo4','plo5','plo6','plo8','flh','flo8','short_deck','pineapple'],
         preferred_stakes = array(select distinct bb from (
           select big_blind as bb from public.tables where game_type='cash' and status in ('running','waiting','active')
           union select unnest(array[0.1,0.25,0.5,1,2,5,10,25,50]::numeric[])
         ) stakes where bb > 0 order by bb),
         max_tables = 4
   where exists (select 1 from public.ca_horse_active_roster a where a.horse_id=t.horse_id);
  -- Preserve historical activity state; the engine no longer uses it to
  -- deny a cash-roster seat. Do not fabricate or clear play counters.
  -- Undo only the profit-roster lane marker, preserving other profile data.
  update public.profiles p
     set horse_profile=(coalesce(p.horse_profile,'{}'::jsonb)-'ploCashLane') || jsonb_build_object('lane','both'),
         updated_at=now()
   where p.horse_profile->>'ploCashLane'='true';

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
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_seat_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  -- All cash-roster variants/stakes are eligible by bankroll, not PLO profit.
  return new;
exception
  when insufficient_privilege then raise;
  when others then return new;
end
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_seat_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_seat_guard() TO service_role;

UPDATE public.ca_declared_money_triggers
 SET note='Cash-roster boundary only for ordinary cash seats; all PLO variants/stakes use bankroll admission. Lightning, exempt clubs, tournaments and same-game moves retain their admission. No chips or seats are written by this guard.'
 WHERE table_name='table_seats' AND trigger_name='zzzzzz_horse_roster_seat_guard';

CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp'
AS $close$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- Existing authority refuses closure with ANY occupied seat, horse or human.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  -- Closure now writes the count too, in its original transaction.
  UPDATE public.tables SET current_players=0
   WHERE id=NEW.id AND current_players IS DISTINCT FROM 0;
  RETURN NEW;
END
$close$;

UPDATE public.tables t SET current_players=0
 WHERE t.game_type='cash' AND t.tournament_id IS NULL
   AND t.status='closed' AND t.current_players IS DISTINCT FROM 0
   AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL);

-- The existing refresh transaction performs the authorized policy transition.
-- It moves no chips and does not evict or insert a seat.
SELECT public.fn_ca_horse_roster_refresh();

DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.ca_horse_active_roster) <> 50 THEN
    RAISE EXCEPTION 'Expected fifty cash horses';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_horse_active_roster a
             WHERE NOT EXISTS (SELECT 1 FROM public.ca_horse_plo_roster p WHERE p.horse_id=a.horse_id)) THEN
    RAISE EXCEPTION 'Every cash horse must be eligible for PLO';
  END IF;
END
$verify$;


COMMIT;
