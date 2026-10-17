-- 20261017033522_horse_tournament_scoreboard_scores_finish_against_the_real_f.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Horse Brain round 3 launch register, item 5):
--
-- The horse tournament scoreboard (horse_tournament_daily) is how the Horse
-- Brain's tournament play is judged (fn_audit_tournament_results,
-- ca_horse_tournament_card). Two defects in fn_horse_tournament_daily_compile:
--
-- 1. The finish percentile was always 0. It divided by t.current_players, and
--    a COMPLETED tournament has current_players = 0 (or 1), so every row took
--    the "else 0" branch: finish_pct_sum = 0 for all 432,313 horse entries in
--    the 7 days to 2026-10-16 (measured by the Horse Brain lead). Every horse
--    looked like it won every tournament it entered.
--    Fix: the field is the number of tournament_players rows of that
--    tournament (every seat, horse or human), never current_players. A
--    finishing position above the row count (defensive) raises the field to it.
-- 2. Satellite winners were dropped (finish with status 'winner', position
--    NULL). This carries the rule from PR #7091
--    (20261016103322, not installed): a row counts when its position is set
--    OR its status is 'winner', and a positionless winner finished first.
--    #7091's migration rebuilds the same function from the same installed
--    body without fix 1, so it must NOT be installed after this one; its
--    audit half (20261016105000) is independent of this file.
--
-- Built on the installed body, md5(prosrc) 58f2ea817ab0a3aeb31d2487774859f1
-- (read 2026-10-17T03:4xZ). invested / won / itm formulas are unchanged.
--
-- Recompile: every day already on the scoreboard (min(day) .. current_date),
-- so the stored history is computed by one rule. The compile is an upsert
-- keyed by (horse, day, type, variant) from the source rows, so re-running it
-- only replaces derived numbers; no source row is touched.
--
-- One transaction (every DDL statement reloads the schema cache, ~28 s here).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_horse_tournament_daily_compile(p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  with done_ as (
    select t.id
      from tournaments t
     where t.status = 'COMPLETED'
       and t.ended_at >= p_day and t.ended_at < p_day + 1
  ),
  field_ as (
    -- The field is every seat that played the tournament, horse or human.
    select tp.tournament_id, count(*)::int as field
      from tournament_players tp
      join done_ d on d.id = tp.tournament_id
     group by tp.tournament_id
  ),
  rows_ as (
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
           -- 0 = won, 1 = first out, measured against the real field. A
           -- satellite winner has no position: it won, so it finished first.
           sum(case when greatest(f.field, coalesce(tp.position, 1)) > 1
                    then (coalesce(tp.position, 1) - 1)::numeric
                         / (greatest(f.field, coalesce(tp.position, 1)) - 1)
                    else 0 end) as finish_pct_sum,
           min(coalesce(tp.position, 1)) as best_finish
      from tournament_players tp
      join done_ d on d.id = tp.tournament_id
      join tournaments t on t.id = tp.tournament_id
      join field_ f on f.tournament_id = tp.tournament_id
      join profiles p on p.id = tp.user_id and p.is_horse = true
     where (tp.position is not null or tp.status = 'winner')
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

DO $recompile$
declare d date;
begin
  for d in
    select generate_series(coalesce((select min(day) from public.horse_tournament_daily), current_date),
                           current_date, interval '1 day')::date
  loop
    perform public.fn_horse_tournament_daily_compile(d);
  end loop;
end $recompile$;

COMMIT;
