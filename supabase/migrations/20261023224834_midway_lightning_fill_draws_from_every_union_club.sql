-- midway_lightning_fill_draws_from_every_union_club
--
-- Dan 2026-10-23 17:45 CT: "add more ... horses to the madness game .25 / .50 !"
-- The fill list drew only on horses holding a direct Midway Union membership
-- (28 awake and under four games). A Midway table is paid by a membership in
-- ANY of the union's member clubs, and across the 5 clubs 82 horses are awake,
-- under four games and not active in another club. Now:
-- 1. The fill list takes those 82 first, NLH 0.25/0.50 Madness first (50),
--    PLO4 0.25/0.50 Madness next, then the rest of each 50.
-- 2. Each fill horse gets the game's cash tag in every union club it belongs
--    to (the fleet resolves which wallet pays).
-- 3. A fill horse's per-game daily sit count and two-hour rejoin window are
--    cleared (Dan 16:52 "remove all limits for now"), so the sit verdict does
--    not refuse it the Lightning game.

BEGIN;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $fill$
declare
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_nlh   constant uuid := 'b3c63129-9377-4c61-9f62-089893a20c66';
  v_plo   constant uuid := '705270cd-03c2-40d9-8749-038f741a295c';
  v_note  constant text := 'Dan 2026-10-23: horses play the Midway 0.25/0.50 Madness Lightning test game';
  v_hour  constant integer := extract(hour from now() at time zone 'UTC')::integer;
  v_keep_nlh integer; v_keep_plo integer; v_n integer;
begin
  create temp table _clubs on commit drop as
  select uc.club_id from public.union_clubs uc where uc.union_id = v_union
  union select v_union;

  create temp table _keep on commit drop as
  select f.horse_id, f.cluster_id from public.lightning_horse_fill f
   where exists (select 1 from public.table_seats s join public.tables t on t.id = s.table_id
                  where s.user_id = f.horse_id and s.left_at is null and t.cluster_id = f.cluster_id);
  select count(*) filter (where cluster_id = v_nlh), count(*) filter (where cluster_id = v_plo)
    into v_keep_nlh, v_keep_plo from _keep;

  create temp table _dropped on commit drop as
  select f.horse_id from public.lightning_horse_fill f
   where not exists (select 1 from _keep k where k.horse_id = f.horse_id);
  delete from public.lightning_horse_fill f using _dropped d where d.horse_id = f.horse_id;
  update public.stable_hand_membership_tags t
     set mode = 'both', persona_cash = 'regular', max_tables = 2,
         variants = array['nlh','plo4','plo5','plo6','plo8']::text[],
         preferred_stakes = array[0.25, 0.5, 1, 2]::numeric[], tag_seed = 'roster-cash'
    from _dropped d
   where t.horse_id = d.horse_id and t.tag_seed = 'lightning-fill';

  create temp table _rank on commit drop as
  with pilot as (select unnest(a.player_ids) as id from public.lightning_pilot_assignment a where a.active),
  cand as (
    select distinct on (m.user_id) m.user_id as id, m.club_id, hs.active_club_id as ac,
           (select count(distinct coalesce(t.tournament_id::text, t.cluster_id::text, t.id::text))
              from public.table_seats s join public.tables t on t.id = s.table_id
             where s.user_id = m.user_id and s.left_at is null and coalesce(t.lifecycle, 'live') <> 'closed')
           + (select count(*) from public.tournament_players tp join public.tournaments tr on tr.id = tp.tournament_id
               where tp.user_id = m.user_id and tp.status = 'registered'
                 and (tr.start_time is null or tr.start_time <= now() + interval '60 minutes')
                 and not exists (select 1 from public.table_seats s2 join public.tables t2 on t2.id = s2.table_id
                                  where s2.user_id = m.user_id and s2.left_at is null and t2.tournament_id = tp.tournament_id)) as c
      from public.club_members m
      join _clubs ci on ci.club_id = m.club_id
      join public.profiles p on p.id = m.user_id and p.is_horse is true
                            and coalesce(p.status, 'active') = 'active'
                            and coalesce(p.horse_status, 'available') <> 'disabled'
      left join public.stable_hand_horse_state hs on hs.horse_id = m.user_id
     where m.status in ('active', 'approved')
       and not exists (select 1 from pilot where pilot.id = m.user_id)
       and coalesce(hs.rest_weekday, -1) not in (5, 6)
       and coalesce(hs.minutes_played_today, 0) < 900
       and not exists (select 1 from _keep k where k.horse_id = m.user_id)
     order by m.user_id, (m.club_id = v_union) desc
  ),
  hashed as (
    select c.*,
           (with recursive r(i, h) as (
              select 0, 0::bigint
              union all
              select i + 1, (h * 31 + ascii(substr(c.id::text, i + 1, 1))) % 4294967296 from r where i < 36)
            select h from r where i = 36) as h
      from cand c
  )
  select id, club_id,
         (c <= 3 and (ac is null or ac = club_id)
              and ((v_hour - (h % 24) + 24) % 24) < 10 + ((h >> 5) % 8)) as usable,
         row_number() over (order by (c <= 3 and (ac is null or ac = club_id)
                                      and ((v_hour - (h % 24) + 24) % 24) < 10 + ((h >> 5) % 8)) desc,
                                     (10 + ((h >> 5) % 8)) - ((v_hour - (h % 24) + 24) % 24) desc,
                                     c, md5(id::text)) as rn
    from hashed;

  -- NLH first, then PLO, each to 50 counting the horses already seated there.
  insert into public.lightning_horse_fill (horse_id, cluster_id, club_id, note)
  select id,
         case when rn <= 50 - v_keep_nlh then v_nlh else v_plo end,
         club_id, v_note
    from _rank
   where rn <= (50 - v_keep_nlh) + (50 - v_keep_plo);

  select count(*) into v_n from public.lightning_horse_fill where cluster_id in (v_nlh, v_plo);
  if v_n <> 100 then
    raise exception 'expected 100 fill horses, found %; nothing changed', v_n;
  end if;

  -- The game's cash tag in every union club the horse belongs to.
  insert into public.stable_hand_membership_tags
    (horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, variants, preferred_stakes, max_tables, tag_seed)
  select f.horse_id, m.club_id, 'cash', false, 'grinder', 'mtt_regular',
         case when f.cluster_id = v_nlh then array['nlh'] else array['plo4'] end,
         array[0.5]::numeric[], 4, 'lightning-fill'
    from public.lightning_horse_fill f
    join public.club_members m on m.user_id = f.horse_id and m.status in ('active', 'approved')
    join _clubs ci on ci.club_id = m.club_id
  on conflict (horse_id, club_id) do update
     set mode = 'cash', cash_freeroll = false, persona_cash = 'grinder',
         variants = excluded.variants, preferred_stakes = excluded.preferred_stakes,
         max_tables = 4, tag_seed = 'lightning-fill';

  update public.stable_hand_horse_state s
     set daily_cap_minutes = greatest(s.daily_cap_minutes, 960),
         cash_sits_today = '{}'::jsonb, two_hour_window = '{}'::jsonb, updated_at = now()
   where s.horse_id in (select f.horse_id from public.lightning_horse_fill f);
end
$fill$;
COMMIT;