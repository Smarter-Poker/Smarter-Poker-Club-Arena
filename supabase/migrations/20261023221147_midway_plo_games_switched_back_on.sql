-- midway_plo_games_switched_back_on
--
-- Dan 2026-10-23 17:11 CT: "why are these games closed? don't close any games
-- without my authorization." At 20:55 UTC another session switched off 22 of
-- Midway Union's PLO games ("one PLO game per stake", PR #7841) without his
-- authorization; 705270cd was already woken at 21:25 for the Lightning test.
-- Every Midway cash game switched off today is switched back on exactly as
-- fn_cash_game_ensure wakes a game: enabled, closed_at/closed_by cleared, a
-- game_woken event, and Main 1 opened when the game has no open table.

BEGIN;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $wake$
declare
  g record;
  v_n integer := 0;
begin
  for g in
    select * from public.cash_games
     where club_id = 'fade0000-0000-0000-0000-000000000001'
       and enabled is not true
       and (updated_at >= '2026-10-23 20:50:00+00' or closed_at >= '2026-10-23 20:50:00+00')
     order by id for update
  loop
    update public.cash_games
       set enabled = true, closed_at = null, closed_by = null, updated_at = now()
     where id = g.id;
    insert into public.cash_cluster_events (game_id, kind, payload)
    values (g.id, 'game_woken', jsonb_build_object('by', 'dan_2026_10_23_no_closing_without_authorization'));
    if not exists (select 1 from public.tables t where t.cluster_id = g.id and t.lifecycle <> 'closed'
                    and coalesce(t.is_deleted, false) = false) then
      perform public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', null);
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n < 21 then
    raise exception 'expected the 21 games switched off today, woke %', v_n;
  end if;
end
$wake$;
COMMIT;