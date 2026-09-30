-- 20260930114152_audit_overlays_counts_entrants_from_tournament_players.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_overlays (called by fn_run_horse_daily_audit through
-- fn_audit_layer_silence_and_coverage) computed an event's entries as
-- coalesce(t.current_players, 0). The nightly audit runs after the day's
-- events have completed, and by then current_players has been reset to 0, so
-- every guaranteed event of the day was reported as a full-guarantee overlay.
--
-- Measured on 2026-09-29: Monday Knockout had 98 rows in tournament_players,
-- Monday Mystery 78/77, Five-Card Big Stack 34, Afternoon PLO Turbo 33/36,
-- Breakfast Turbo 34/36. All were reported with "entries 0" and critical
-- overlays of 150-600. With entrants counted from tournament_players the same
-- day yields one real 1.50 overlay (Afternoon PLO Turbo, 33 x 4.50 vs 150).
--
-- The only change is the source of entries: a count of tournament_players
-- rows, computed once per event through a lateral join. Signature, STABLE,
-- SECURITY DEFINER, search_path, output shape and texts match the live
-- definition. Grants are restated to match the live ACL (postgres and
-- service_role only; anon/authenticated were revoked in
-- 20260831_phase4_close_the_anon_definer_surface.sql).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_audit_overlays(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb := '[]'::jsonb; r record; total numeric := 0; n int := 0;
begin
  for r in
    select t.name, t.guaranteed_prize gtd, t.buy_in_amount bi,
           e.entries cur,
           (t.guaranteed_prize - greatest(e.entries * t.buy_in_amount, 0)) short
    from tournaments t
    cross join lateral (
      select count(*)::int as entries
      from public.tournament_players p
      where p.tournament_id = t.id
    ) e
    where t.guaranteed_prize > 0 and t.buy_in_amount > 0
      and t.started_at >= p_day and t.started_at < p_day + 1
      and (t.guaranteed_prize - greatest(e.entries * t.buy_in_amount, 0)) > 0
    order by 5 desc limit 10
  loop
    total := total + r.short; n := n + 1;
    v := v || jsonb_build_object(
      'severity', case when r.short >= 200 then 'critical' else 'warn' end,
      'category', 'logic', 'code', 'tournament_overlay',
      'title', r.name || ' started with a ' || round(r.short, 2) || ' overlay',
      'evidence', jsonb_build_object('guarantee', r.gtd, 'buy_in', r.bi,
                                     'entries', r.cur, 'shortfall', r.short),
      'recommendation', 'The overlay guard did not fill this event before it started. Check HorseOverlayGuard logs for that window: it may have been starved of eligible horses (events/both lane, under the four-table cap) or the event may have started sooner than the guard cycle.'
    );
  end loop;
  if n > 0 then
    v := v || jsonb_build_object(
      'severity', 'info', 'category', 'logic', 'code', 'overlay_total',
      'title', 'Club covered ' || round(total, 2) || ' in overlays across ' || n || ' event(s)',
      'evidence', jsonb_build_object('events', n, 'total_overlay', round(total, 2)),
      'recommendation', 'Total is the money the guarantee cost beyond what entries funded.'
    );
  end if;
  return v;
end $function$;

REVOKE ALL ON FUNCTION public.fn_audit_overlays(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_overlays(date) TO service_role;

COMMIT;
