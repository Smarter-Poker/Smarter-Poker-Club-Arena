-- Native fixture bound to the candidate function bodies by the existing qualification runner.
CREATE ROLE service_role;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE TABLE profiles(id uuid primary key,is_horse boolean,status text,horse_status text,horse_profile jsonb,updated_at timestamptz);
CREATE TABLE clubs(id uuid primary key);
CREATE TABLE club_members(user_id uuid,club_id uuid,status text,chip_balance numeric);
CREATE TABLE cash_games(id uuid primary key,enabled boolean,closed_at timestamptz,state text,club_id uuid);
CREATE TABLE tables(id uuid primary key,tournament_id uuid,game_type text,game_variant text,big_blind numeric,status text,current_players integer,club_id uuid,cluster_id uuid);
CREATE TABLE table_seats(id uuid primary key,user_id uuid,table_id uuid,left_at timestamptz,active_game_scope text,stack numeric);
CREATE TABLE ca_horse_active_roster(horse_id uuid primary key,rank integer,hands bigint,bb100 numeric,chosen_at timestamptz default now());
CREATE TABLE ca_horse_plo_roster(horse_id uuid primary key,rank integer,plo_hands bigint,plo_bb100 numeric,chosen_at timestamptz default now());
CREATE TABLE ca_horse_roster_bench(horse_id uuid primary key);
CREATE TABLE ca_horse_roster_exempt_clubs(club_id uuid primary key);
CREATE TABLE lightning_horse_fill(horse_id uuid primary key,cluster_id uuid,club_id uuid);
CREATE TABLE horse_daily_nets(horse_user_id uuid,hands bigint,net_bb numeric,game_variant text,format text,day date);
CREATE TABLE ca_horse_roster_cash_tag_backup(horse_id uuid,club_id uuid,mode text,cash_freeroll boolean,persona_cash text,persona_mtt text,variants text[],preferred_stakes numeric[],max_tables integer,primary key(horse_id,club_id));
CREATE TABLE stable_hand_membership_tags(horse_id uuid,club_id uuid,mode text,cash_freeroll boolean,persona_cash text,persona_mtt text,variants text[],preferred_stakes numeric[],max_tables integer,tag_seed text,primary key(horse_id,club_id));
CREATE TABLE stable_hand_horse_state(horse_id uuid primary key,rest_weekday smallint not null,daily_cap_minutes integer not null,updated_at timestamptz);
CREATE TABLE ca_horse_roster_log(size integer,demand integer,active uuid[],plo uuid[],result jsonb);
CREATE FUNCTION fn_cashout_seats_for_closing_table(p_table_id uuid,p_reason text default 'table closed') RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM table_seats WHERE table_id=p_table_id AND left_at IS NULL) THEN
  RAISE EXCEPTION 'CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES';
 END IF;
 RETURN '{"ok":true}'::jsonb;
END $$;
INSERT INTO clubs VALUES('00000000-0000-0000-0000-000000000001');
INSERT INTO profiles SELECT md5('horse'||i)::uuid,true,'active','available','{}',now() FROM generate_series(1,55) i;
INSERT INTO club_members SELECT id,'00000000-0000-0000-0000-000000000001','active',10000 FROM profiles;
INSERT INTO ca_horse_active_roster SELECT id,row_number() over(order by id),0,-50 FROM profiles ORDER BY id LIMIT 50;
INSERT INTO stable_hand_membership_tags SELECT id,'00000000-0000-0000-0000-000000000001','both',false,'regular','mtt_regular',ARRAY['nlh'],ARRAY[1]::numeric[],1,'fixture' FROM profiles;
INSERT INTO stable_hand_horse_state SELECT id,5,60,now() FROM profiles;
INSERT INTO tables VALUES('00000000-0000-0000-0000-000000000002',null,'cash','plo4',2,'closed',9,'00000000-0000-0000-0000-000000000001',null);
INSERT INTO tables VALUES('00000000-0000-0000-0000-000000000003',null,'cash','plo5',5,'running',2,'00000000-0000-0000-0000-000000000001',null);
INSERT INTO tables VALUES('00000000-0000-0000-0000-000000000004',null,'cash','nlh',2,'running',3,'00000000-0000-0000-0000-000000000001',null);

-- 20261023215853_cash_horses_play_by_bankroll_and_closed_tables_report_no_pha.sql
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
-- Production source-hash admission is exercised separately against before-images.
-- This isolated fixture starts with no production functions.

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
  if v_fill is not null and not exists (select 1 from public.ca_horse_active_roster a where a.horse_id=new.user_id) then
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
  -- Variant, fixed stake and past profit are not eligibility rules.
  -- Atomic buy-in and exposure rules remain the bankroll authority.
  return new;
exception
  when insufficient_privilege then raise;
  when others then return new;
end
$function$;

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

CREATE TRIGGER roster_guard BEFORE INSERT ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_horse_roster_seat_guard();
CREATE TRIGGER table_close AFTER UPDATE OF status ON tables FOR EACH ROW WHEN(NEW.status='closed' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION trg_auto_cashout_on_table_close();
DO $$
DECLARE h uuid;
BEGIN
 IF (SELECT count(*) FROM ca_horse_active_roster)<>50 OR (SELECT count(*) FROM ca_horse_plo_roster)<>50 THEN RAISE EXCEPTION 'roster counts'; END IF;
 IF EXISTS(SELECT 1 FROM stable_hand_membership_tags t JOIN ca_horse_active_roster a USING(horse_id) WHERE max_tables<>4 OR NOT('plo5'=ANY(variants)) OR NOT(5=ANY(preferred_stakes))) THEN RAISE EXCEPTION 'tags still restrict'; END IF;
 IF (SELECT current_players FROM tables WHERE id='00000000-0000-0000-0000-000000000002')<>0 THEN RAISE EXCEPTION 'phantom count'; END IF;
 SELECT horse_id INTO h FROM ca_horse_active_roster LIMIT 1;
 -- A losing horse with no PLO history may sit at affordable high PLO.
 INSERT INTO table_seats VALUES(md5('seat')::uuid,h,'00000000-0000-0000-0000-000000000003',null,null,200);
 BEGIN
  UPDATE tables SET status='closed' WHERE id='00000000-0000-0000-0000-000000000003';
  RAISE EXCEPTION 'occupied table closed';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES' THEN RAISE; END IF;
 END;
 IF (SELECT current_players FROM tables WHERE id='00000000-0000-0000-0000-000000000003')<>2 THEN RAISE EXCEPTION 'occupied count cleared'; END IF;
 UPDATE tables SET status='closed' WHERE id='00000000-0000-0000-0000-000000000004';
 IF (SELECT current_players FROM tables WHERE id='00000000-0000-0000-0000-000000000004')<>0 THEN RAISE EXCEPTION 'close did not clear empty count'; END IF;
 BEGIN
  INSERT INTO table_seats SELECT md5('off-roster')::uuid,p.id,'00000000-0000-0000-0000-000000000003',null,null,200 FROM profiles p WHERE NOT EXISTS(SELECT 1 FROM ca_horse_active_roster a WHERE a.horse_id=p.id) LIMIT 1;
  RAISE EXCEPTION 'cash pool exceeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM ca_horse_active_roster WHERE bb100>=0) THEN RAISE EXCEPTION 'fixture must prove loss history does not block'; END IF;
END $$;
SELECT 'cash roster, unrestricted PLO, closed-empty counts and occupied-seat protection PASS' AS result;
