-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820021722 "leaderboard_rank_only_active_players"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 55b296d2b815db75cef3e3dad0a95404 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Rank participants, not the member list                          2026-08-20
-- ═══════════════════════════════════════════════════════════════════════════
-- The boards ranked EVERY player_stats row for the club, including players with
-- no activity in the selected period. Such a player sits at profit 0, which on
-- a weekly board places them above everyone who lost money that week.
--
-- Measured on Club JAQK, profit / weekly: 575 ranked, 16 with zero activity,
-- and the best-placed inactive player sat at rank 189 - above 371 players who
-- actually played and lost. "out of 575 players" also overstated participation,
-- since 575 is the club roster rather than the people who played.
--
-- Both boards now rank only rows with activity in the window (hands dealt,
-- tournaments won, or any chip movement - so a tournament-only player is not
-- dropped from the Tournaments Won board), and total_ranked is a window count
-- over that same filtered set, so the denominator can never disagree with the
-- population being ranked.
--
-- Applied by rewriting the live definitions with asserted substitutions, for
-- the same reason as 20260820b: restating the SQL by hand is how these drifted.
--
-- ROLLBACK: restore from 20260819j / 20260819l and re-apply 20260820b.

DO $mig$
DECLARE
  fn  text;
  src text;
  out text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['fn_club_leaderboard_period_v2','fn_global_leaderboard_period'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION 'function % not found', fn; END IF;
    out := src;

    -- 1. Only rank rows with activity in the window. WHERE is evaluated before
    --    the window functions, so rank()/row_number() see the filtered set.
    IF position('      FROM scored s' in out) = 0 THEN
      RAISE EXCEPTION '%: scored-source fragment not found', fn;
    END IF;
    out := replace(out, '      FROM scored s',
      '      FROM scored s'
      || E'\n     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)');

    -- 2. total_ranked becomes a count over that same filtered set.
    IF position('AS rk_now,' in out) = 0 THEN
      RAISE EXCEPTION '%: rk_now fragment not found (apply 20260820b first)', fn;
    END IF;
    out := replace(out, 'AS rk_now,',
      'AS rk_now,' || E'\n           count(*)     OVER ()                                        AS total_active,');

    IF position(', v_total, v_baseline' in out) = 0 THEN
      RAISE EXCEPTION '%: returned total column fragment not found', fn;
    END IF;
    out := replace(out, ', v_total, v_baseline', ', r.total_active::integer, v_baseline');

    EXECUTE out;
  END LOOP;
END
$mig$;

DO $verify$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('fn_club_leaderboard_period_v2','fn_global_leaderboard_period')
     AND (p.prosrc NOT LIKE '%total_active%' OR p.prosrc NOT LIKE '%s.d_hands > 0%');
  IF bad > 0 THEN RAISE EXCEPTION '% function(s) missing the activity filter', bad; END IF;
END
$verify$;
