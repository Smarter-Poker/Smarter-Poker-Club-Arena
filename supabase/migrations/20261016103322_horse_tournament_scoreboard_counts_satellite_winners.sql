-- 20261016103322_horse_tournament_scoreboard_counts_satellite_winners.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Found by the 2026-10-15 daily horse audit analysis. fn_audit_tournament_results
-- warned "SATELLITE ROI -81.1% over 5723 entries (7 days)". The fleet plays
-- itself, so a type's pooled ROI should sit near minus the fee (10% on these
-- satellites). It did not, because the scoreboard dropped every satellite
-- WINNER:
--
--   fn_horse_tournament_daily_compile kept only tournament_players rows with
--   `position is not null`. A satellite seat/ticket/cash winner finishes with
--   status 'winner' and position NULL. Read from production for the 7 days to
--   2026-10-15 (382 completed satellites, all-horse fields):
--     position set     5,723 rows   prize  25,200.50   (the losers + bubble)
--     position NULL    2,975 rows   prize 164,900.00   (every one status 'winner')
--   Counting both: ROI -9.2%, which is the fee. MTT had 12 such rows.
--   Since 2026-09-18, 7,049 winner rows with NULL position were left out.
--
-- 1. The compile keeps a row when its position is set OR its status is
--    'winner'. A winner with no position counts as position 1 for the finish
--    percentile (0 = won) and best finish. Nothing else in the body changes;
--    it is built on the installed body (md5(prosrc) 58f2ea817ab0a3aeb31d2487774859f1).
-- 2. Backfill: recompile every day from 2026-09-18 (the first NULL-position
--    winner) to 2026-10-15. Checked before writing: for every one of those
--    days the stored entries equal a recount under the old rule, so no source
--    rows were pruned and the recompile only adds the missing winners.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_horse_tournament_daily_compile(p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  with rows_ as (
    select tp.user_id as horse_user_id,
           p_day as day,
           coalesce(t.tournament_type, 'MTT') as tournament_type,
           coalesce(nullif(t.variant, ''), 'nlh') as variant,
           count(*) as entries,
           sum(coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
               + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
               + case when tp.add_on then coalesce(t.addon_cost, 0) else 0 end) as invested,
           sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0)) as won,
           count(*) filter (where coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0) > 0) as itm_entries,
           -- A satellite winner has no position: it won, so it finished first.
           sum(case when coalesce(t.current_players, 0) > 1
                    then (coalesce(tp.position, 1) - 1)::numeric / (t.current_players - 1) else 0 end) as finish_pct_sum,
           min(coalesce(tp.position, 1)) as best_finish
      from tournament_players tp
      join tournaments t on t.id = tp.tournament_id
      join profiles p on p.id = tp.user_id and p.is_horse = true
     where t.status = 'COMPLETED'
       and t.ended_at >= p_day and t.ended_at < p_day + 1
       and (tp.position is not null or tp.status = 'winner')
     group by 1, 2, 3, 4
  )
  insert into horse_tournament_daily as h
    (horse_user_id, day, tournament_type, variant, entries, invested, won, itm_entries, finish_pct_sum, best_finish)
  select horse_user_id, day, tournament_type, variant, entries, invested, won, itm_entries, finish_pct_sum, best_finish
    from rows_
  on conflict (horse_user_id, day, tournament_type, variant) do update set
    entries = excluded.entries,
    invested = excluded.invested,
    won = excluded.won,
    itm_entries = excluded.itm_entries,
    finish_pct_sum = excluded.finish_pct_sum,
    best_finish = excluded.best_finish,
    updated_at = now();
  get diagnostics n = row_count;
  return n;
end $function$;

REVOKE ALL ON FUNCTION public.fn_horse_tournament_daily_compile(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_daily_compile(date) TO service_role;

DO $backfill$
declare d date;
begin
  for d in select generate_series('2026-09-18'::date, '2026-10-15'::date, interval '1 day')::date loop
    perform public.fn_horse_tournament_daily_compile(d);
  end loop;
end $backfill$;

COMMIT;
