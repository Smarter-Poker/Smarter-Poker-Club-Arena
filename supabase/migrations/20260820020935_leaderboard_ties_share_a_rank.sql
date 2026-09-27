-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020935 "leaderboard_ties_share_a_rank"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 28c4f500dc429fce6765af88df3d8f9f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Ties must share a rank                                          2026-08-20
-- ═══════════════════════════════════════════════════════════════════════════
-- The boards ranked with row_number(), which forces a total order and breaks
-- ties on user_id. On metrics with a small value domain that is badly wrong:
-- the Tournaments Won board returns 200 rows with only 28 distinct values, so
-- 172 rows are tied - two players each on 3 wins could render as #12 and #47,
-- ordered by nothing more meaningful than their uuid.
--
-- rank() now decides the DISPLAYED rank (1, 2, 2, 4 - the usual sports and
-- poker convention). row_number() is retained purely for ordering and
-- LIMIT/OFFSET, so pagination stays stable and cannot duplicate or skip a row.
-- rank_change is computed rank-to-rank, so a tie group moving together reads
-- as 0 instead of shuffling arbitrarily.
--
-- fn_user_rank_period / fn_user_rank_global_period derive from the club and
-- global functions, so they inherit tie handling automatically.
--
-- Applied by rewriting the live definitions rather than restating ~13KB of SQL
-- by hand - that is how these three drifted apart in the first place. Each
-- substitution asserts that it matched.
--
-- NOTE on fn_union_leaderboard_period_v2: it predates the pagination work and
-- returns neither `rank` nor `total_ranked` nor `baseline_date`, so step 4 is
-- skipped for it. Its rank_change still becomes tie-aware. Bringing its return
-- shape in line with the other two is worth doing before anything calls it -
-- nothing does today.
--
-- ROLLBACK: restore the three functions from 20260819j / 20260819k / 20260819l.

DO $mig$
DECLARE
  fn  text;
  src text;
  out text;
  has_rank_col boolean;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'fn_club_leaderboard_period_v2',
    'fn_global_leaderboard_period',
    'fn_union_leaderboard_period_v2'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION 'function % not found', fn; END IF;
    out := src;

    -- 1. Tie-aware rank alongside the ordering rank.
    IF position('row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,' in out) = 0 THEN
      RAISE EXCEPTION '%: rn_now fragment not found', fn;
    END IF;
    out := replace(out,
      'row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,',
      'row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,'
        || E'\n           rank()       OVER (ORDER BY s.score DESC NULLS LAST)        AS rk_now,');

    -- 2. Previous-window rank becomes tie-aware too.
    IF position('ELSE row_number() OVER (ORDER BY s.prev_score DESC NULLS LAST, s.uid) END AS rn_old' in out) = 0 THEN
      RAISE EXCEPTION '%: rn_old fragment not found', fn;
    END IF;
    out := replace(out,
      'ELSE row_number() OVER (ORDER BY s.prev_score DESC NULLS LAST, s.uid) END AS rn_old',
      'ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old');

    -- 3. rank_change rank-to-rank.
    IF position('COALESCE((r.rn_old - r.rn_now)::integer, 0)' in out) = 0 THEN
      RAISE EXCEPTION '%: rank_change fragment not found', fn;
    END IF;
    out := replace(out, 'COALESCE((r.rn_old - r.rn_now)::integer, 0)',
                        'COALESCE((r.rk_old - r.rk_now)::integer, 0)');

    -- 4. Returned rank column becomes tie-aware, where one exists.
    has_rank_col := position('r.rn_now::integer' in out) > 0;
    IF has_rank_col THEN
      out := replace(out, 'r.rn_now::integer', 'r.rk_now::integer');
    ELSIF fn <> 'fn_union_leaderboard_period_v2' THEN
      RAISE EXCEPTION '%: expected a returned rank column', fn;
    END IF;

    -- Ordering must survive: pagination depends on the total order.
    IF position('ORDER BY r.rn_now' in out) = 0 THEN
      RAISE EXCEPTION '%: ORDER BY r.rn_now was lost - pagination would break', fn;
    END IF;
    IF position('r.rn_old' in out) > 0 THEN
      RAISE EXCEPTION '%: rn_old still referenced', fn;
    END IF;

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
     AND p.proname IN ('fn_club_leaderboard_period_v2','fn_global_leaderboard_period',
                       'fn_union_leaderboard_period_v2')
     AND (p.prosrc NOT LIKE '%rk_now%' OR p.prosrc NOT LIKE '%ORDER BY r.rn_now%');
  IF bad > 0 THEN RAISE EXCEPTION '% function(s) missing tie-aware rank or ordering', bad; END IF;
END
$verify$;
