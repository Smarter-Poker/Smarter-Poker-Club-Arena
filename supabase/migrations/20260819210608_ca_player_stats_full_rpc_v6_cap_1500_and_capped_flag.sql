-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210608 "ca_player_stats_full_rpc_v6_cap_1500_and_capped_flag"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1000d58669b2535a0f00a24e0c07cf29 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v6: measured 16s for the heaviest player (3000 hands + 1309 tournaments)
-- against an 8s authenticated statement_timeout. Cap the hand window at 1500
-- (~3s) and expose hand_cap / hands_capped so the UI can state the window
-- instead of silently reporting a truncated lifetime total.
-- Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $$
DECLARE
  src text;
  old_tail text := $r1$    'hours_played', round(total_secs / 3600.0, 2),
    'first_hand_at', first_hand_at,$r1$;
  new_tail text := $r2$    'hours_played', round(total_secs / 3600.0, 2),
    'hand_cap', 1500,
    'hands_capped', (hands >= 1500),
    'first_hand_at', first_hand_at,$r2$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position('LIMIT 3000' IN src) = 0 THEN RAISE EXCEPTION 'expected LIMIT 3000'; END IF;
  IF position(old_tail IN src) = 0 THEN RAISE EXCEPTION 'hours_played tail not found'; END IF;
  src := replace(src, 'LIMIT 3000', 'LIMIT 1500');
  src := replace(src, old_tail, new_tail);
  EXECUTE src;
END $$;
