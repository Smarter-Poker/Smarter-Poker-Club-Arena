-- Owner October 23: preserve horse schedules; remove extra game eligibility restrictions.
-- Full registered active fleet, never a fixed fifty-horse cash pool. Historical
-- performance does not decide eligibility. No seat, wallet, clock or play-counter
-- mutation. Must follow installed qualified predecessor 20261023221116.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $admission$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer)'::regprocedure)) <> 'bd09b1a22db4a550dd28d84d4ce21a25'
 OR md5(pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure)) <> '5adcef027f1e9609619f080bb4e9ebdd' THEN
  RAISE EXCEPTION 'Install the qualified cash allocation predecessor first; source changed';
 END IF;
END
$admission$;
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
  v_size := null; -- full registered fleet; measured after candidate selection

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
     and coalesce(p.horse_status, 'available') <> 'disabled'
     and exists (select 1 from public.ca_horse_fleet_register f where f.horse_id=p.id and f.retired_at is null);
  select count(*) into v_size from _cand;

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

  -- Every registered active horse can choose any cash variant/stake its roll covers.
  -- Activity hours, rest days and daily counters are deliberately unchanged.
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
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $function$
BEGIN
  -- Owner October 23: historical cash/PLO rankings no longer restrict seats.
  -- All normal membership, bankroll, game-capacity and player rules remain
  -- in their original admission transaction and independent triggers.
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_seat_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_seat_guard() TO service_role;

UPDATE public.ca_declared_money_triggers SET note='Historical roster/profit exclusions removed; independent player, membership, bankroll and financial admission remains authoritative. No seat or chip writes.'
WHERE table_name='table_seats' AND trigger_name='zzzzzz_horse_roster_seat_guard';
SELECT public.fn_ca_horse_roster_refresh();

COMMIT;
