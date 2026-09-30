-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819155656 "ca_player_stats_full_rpc_v4_single_pass_folds"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e1c13e60ceb180436c512bb2c3012da2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v4: merge the no_fold_players lateral into the single actions expansion
-- and lower cap 5000 -> 3000 (measured ~2ms/hand vs 8s authenticated
-- statement_timeout). Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $$
DECLARE
  src text;
  old_nf text := $r1$  CROSS JOIN LATERAL (
    SELECT count(*) AS no_fold_players
    FROM jsonb_array_elements(mh.players) pl
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(mh.actions) a1
      WHERE a1->>'userId' = pl->>'userId' AND a1->>'action' = 'fold')
  ) nf
$r1$;
  old_tail text := $r2$        AND d.first_flop_bettor = p_user::text, false) AS cbet_made
    FROM derived d$r2$;
  new_tail text := $r3$        AND d.first_flop_bettor = p_user::text, false) AS cbet_made,
      (SELECT count(*) FROM jsonb_array_elements(mh.players) pl
        WHERE pl->>'userId' NOT IN (
          SELECT auid FROM acts
          WHERE action = 'fold' AND auid IS NOT NULL)) AS no_fold_players
    FROM derived d$r3$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position('LIMIT 5000' IN src) = 0 THEN RAISE EXCEPTION 'expected LIMIT 5000'; END IF;
  IF position(old_nf IN src) = 0 THEN RAISE EXCEPTION 'nf lateral block not found'; END IF;
  IF position('nf.no_fold_players' IN src) = 0 THEN RAISE EXCEPTION 'nf.no_fold_players not found'; END IF;
  IF position(old_tail IN src) = 0 THEN RAISE EXCEPTION 'cbet tail not found'; END IF;
  src := replace(src, 'LIMIT 5000', 'LIMIT 3000');
  src := replace(src, old_nf, '');
  src := replace(src, 'nf.no_fold_players', 'a.no_fold_players');
  src := replace(src, old_tail, new_tail);
  EXECUTE src;
END $$;
