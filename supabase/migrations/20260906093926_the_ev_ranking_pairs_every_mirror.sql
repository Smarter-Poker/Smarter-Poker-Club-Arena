-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906093926; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906093926   (the stamp IS the apply time, UTC: 2026-09-06 09:39:26)
--   name        the_ev_ranking_pairs_every_mirror
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3576 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906093926 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_horse_tag_ev
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- THE EV RANKING PAIRS EVERY MIRROR (2026-09-06)
--
-- Two defects in the first cut of fn_horse_tag_ev, both found by reading its
-- own output against the tag inventory:
--
-- 1. TWO NAMING SHAPES. Almost every situation is `X` (the loss) and `X_won`
--    (the mirror), but river aggression is `river_aggr_lost` / `river_aggr_won`
--    - it was the first tag ever mirrored (2026-09-01) and got a symmetric
--    name; the generalisation two days later did not. Stripping only `_won`
--    left `river_aggr` showing 48,891 hands at a 100% win rate, which is not a
--    measurement, it is one half of a ledger. Both suffixes are stripped now.
--
-- 2. MIRROR STATUS WAS INFERRED FROM THE DATA. `mirrored` was "a _won key
--    exists", so a situation whose mirror is real but RARE read as unmirrored
--    and dropped out of the ranking - and the rarest mirrors are the worst
--    situations. plo_naked_trips_stackoff won 4 of 480; plo_toppair_no_redraw
--    won 3 of 237. Those are the two biggest losers in the fleet and the first
--    cut would have hidden both.
--
--    Mirror status is a fact about the CODE, not about the week's cards.
--    HorseHandReview says it plainly: "THE FOLD FAMILY IS NOT MIRRORED, and
--    cannot be: big_bet_fold, big_fold_river, big_fold_early and bet_fold_line
--    all require hero to have FOLDED, and a folded hand never wins." That list
--    is the definition, so that list is what this uses.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_horse_tag_ev(p_since date)
returns table (
  situation text, mirrored boolean, hands bigint, won_hands bigint,
  net_bb numeric, bb_per_hand numeric, win_rate numeric
)
language sql stable security definer set search_path = public as $$
  with flat as (
    select k as tag,
           (r.leak_counts->>k)::bigint               as cnt,
           coalesce((r.leak_net_bb->>k)::numeric, 0) as net
      from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
     where r.day >= p_since
  ),
  agg as (
    select tag, sum(cnt)::bigint as cnt, sum(net) as net from flat group by tag
  ),
  paired as (
    select
      case
        when a.tag like '%\_won'  then left(a.tag, length(a.tag) - 4)
        when a.tag like '%\_lost' then left(a.tag, length(a.tag) - 5)
        else a.tag
      end                        as situation,
      a.tag like '%\_won'        as is_won,
      a.cnt, a.net
    from agg a
  )
  select p.situation,
         -- The fold family cannot have a mirror. Everything else does, whether
         -- or not it won this week.
         p.situation not in ('big_bet_fold','big_fold_river','big_fold_early','bet_fold_line')
                                                              as mirrored,
         sum(p.cnt)::bigint                                    as hands,
         coalesce(sum(p.cnt) filter (where p.is_won), 0)::bigint as won_hands,
         round(sum(p.net), 1)                                  as net_bb,
         round(sum(p.net) / nullif(sum(p.cnt), 0), 2)          as bb_per_hand,
         round(coalesce(sum(p.cnt) filter (where p.is_won), 0)::numeric
               / nullif(sum(p.cnt), 0), 3)                     as win_rate
    from paired p
   group by p.situation
  having sum(p.cnt) >= 100
   order by 6 asc;
$$;

revoke all on function public.fn_horse_tag_ev(date) from public, authenticated, anon;
grant execute on function public.fn_horse_tag_ev(date) to service_role;
