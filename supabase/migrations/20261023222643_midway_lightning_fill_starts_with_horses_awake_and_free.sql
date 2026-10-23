-- 20261023222643_midway_lightning_fill_starts_with_horses_awake_and_free.sql
--
-- Dan 2026-10-23 16:54 CT: "when ... are horses going to start taking their
-- seats in the .25/.50 game so i can test the lightning games". The running
-- fleet (74c1ff91) measured at 22:21 UTC: "NLH 0.25/0.50 Madness Feeder (need 2,
-- candidates 21, sittable 6, asleep 6)" - a horse outside its activity window
-- (isActiveNow, a fixed hash of its id) is not seated, and a horse already
-- committed to four games counting bookings that start within 60 minutes is
-- not tried. Of Midway's horses, 28 are awake now and under four games.
-- 1. The fill list puts those first: 12 to PLO4, the rest to NLH, then the
--    remainder of each 50 by fewest commitments (they sit as they wake or
--    their events end).
-- 2. Both games switch to Lightning at the pilots' proven 12 on / 8 off, so
--    the test starts as soon as two tables are full.
-- Installed 22:26 UTC at Dan's "install it" (17:24 CT).

BEGIN;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $fill$
declare
  v_club constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_nlh  constant uuid := 'b3c63129-9377-4c61-9f62-089893a20c66';
  v_plo  constant uuid := '705270cd-03c2-40d9-8749-038f741a295c';
  v_note constant text := 'Dan 2026-10-23: 50 horses play the Midway 0.25/0.50 Madness Lightning test game';
  v_hour constant integer := extract(hour from now() at time zone 'UTC')::integer;
  v_n integer;
  g record;
  r jsonb;
begin
  create temp table _keep on commit drop as
  select f.horse_id, f.cluster_id from public.lightning_horse_fill f
   where exists (select 1 from public.table_seats s join public.tables t on t.id = s.table_id
                  where s.user_id = f.horse_id and s.left_at is null and t.cluster_id = f.cluster_id);
  create temp table _dropped on commit drop as
  select f.horse_id, f.club_id from public.lightning_horse_fill f
   where not exists (select 1 from _keep k where k.horse_id = f.horse_id);
  delete from public.lightning_horse_fill f using _dropped d where d.horse_id = f.horse_id;
  update public.stable_hand_membership_tags t
     set mode = 'both', persona_cash = 'regular', max_tables = 2,
         variants = array['nlh','plo4','plo5','plo6','plo8']::text[],
         preferred_stakes = array[0.25, 0.5, 1, 2]::numeric[], tag_seed = 'roster-cash'
    from _dropped d
   where t.horse_id = d.horse_id and t.club_id = d.club_id and t.tag_seed = 'lightning-fill';

  create temp table _rank on commit drop as
  with pilot as (select unnest(a.player_ids) as id from public.lightning_pilot_assignment a where a.active),
  cand as (
    select m.user_id as id,
           (select count(distinct coalesce(t.tournament_id::text, t.cluster_id::text, t.id::text))
              from public.table_seats s join public.tables t on t.id = s.table_id
             where s.user_id = m.user_id and s.left_at is null and coalesce(t.lifecycle, 'live') <> 'closed')
           + (select count(*) from public.tournament_players tp join public.tournaments tr on tr.id = tp.tournament_id
               where tp.user_id = m.user_id and tp.status = 'registered'
                 and (tr.start_time is null or tr.start_time <= now() + interval '60 minutes')
                 and not exists (select 1 from public.table_seats s2 join public.tables t2 on t2.id = s2.table_id
                                  where s2.user_id = m.user_id and s2.left_at is null and t2.tournament_id = tp.tournament_id)) as c
      from public.club_members m
      join public.profiles p on p.id = m.user_id and p.is_horse is true
                            and coalesce(p.status, 'active') = 'active'
                            and coalesce(p.horse_status, 'available') <> 'disabled'
      left join public.stable_hand_horse_state hs on hs.horse_id = m.user_id
     where m.club_id = v_club and m.status in ('active', 'approved')
       and not exists (select 1 from pilot where pilot.id = m.user_id)
       and coalesce(hs.rest_weekday, -1) not in (5, 6)
       and coalesce(hs.minutes_played_today, 0) < 900
       and not exists (select 1 from _keep k where k.horse_id = m.user_id)
  ),
  hashed as (
    select c.*,
           (with recursive r(i, h) as (
              select 0, 0::bigint
              union all
              select i + 1, (h * 31 + ascii(substr(c.id::text, i + 1, 1))) % 4294967296 from r where i < 36)
            select h from r where i = 36) as h
      from cand c
  ),
  win as (
    select id, c, (c <= 3 and ((v_hour - (h % 24) + 24) % 24) < 10 + ((h >> 5) % 8)) as usable,
           (10 + ((h >> 5) % 8)) - ((v_hour - (h % 24) + 24) % 24) as awake_left
      from hashed
  )
  select id, usable, row_number() over (order by usable desc, awake_left desc, c, md5(id::text)) as rn from win;

  insert into public.lightning_horse_fill (horse_id, cluster_id, club_id, note)
  select id,
         case when usable and rn <= 24 and rn % 2 = 1 then v_plo
              when usable then v_nlh
              else v_plo end,
         v_club, v_note
    from _rank
   where rn <= 100 - (select count(*) from _keep);

  with plo_extra as (
    select f.horse_id from public.lightning_horse_fill f join _rank k on k.id = f.horse_id
     where f.cluster_id = v_plo and not k.usable
     order by k.rn
     limit greatest(0, (select count(*) from public.lightning_horse_fill where cluster_id = v_plo) - 50)
  )
  update public.lightning_horse_fill f set cluster_id = v_nlh from plo_extra e where e.horse_id = f.horse_id;

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
  on conflict (horse_id, club_id) do update
     set mode = 'cash', cash_freeroll = false, persona_cash = 'grinder',
         variants = excluded.variants, preferred_stakes = excluded.preferred_stakes,
         max_tables = 4, tag_seed = 'lightning-fill';

  update public.stable_hand_horse_state s
     set daily_cap_minutes = 960, updated_at = now()
   where s.horse_id in (select f.horse_id from public.lightning_horse_fill f)
     and s.daily_cap_minutes < 960;

  for g in select * from public.cash_games where id in (v_nlh, v_plo) order by id for update loop
    update public.cash_games
       set ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}',
             (ruleset_snapshot->'lightning') || jsonb_build_object('on_threshold', 12, 'off_threshold', 8)),
           updated_at = now()
     where id = g.id;
    r := public.fn_cash_cluster_lightning_thresholds(g.id);
    if not (r @> '{"on":12,"off":8,"source":"ruleset","rejected":[]}'::jsonb) then
      raise exception 'game % threshold readback is not 12 / 8: %', g.id, r;
    end if;
  end loop;
end
$fill$;
COMMIT;
