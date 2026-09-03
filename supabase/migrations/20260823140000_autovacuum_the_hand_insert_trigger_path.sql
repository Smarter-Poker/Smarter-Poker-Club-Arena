-- 20260823140000_autovacuum_the_hand_insert_trigger_path.sql
--
-- The hand-insert path costs 46 ms, and 42.5 ms of it is the three per-row
-- AFTER INSERT triggers on hand_history - not the row write, and NOT the
-- indexes. EXPLAIN ANALYZE on a real insert, rolled back:
--
--   Insert on hand_history                             3.905 ms
--   Trigger hand_history_club_member_stats            13.883 ms
--   Trigger hand_history_fold_stats                   22.183 ms
--   Trigger hand_history_position_stats                6.420 ms
--   Execution Time                                    46.417 ms
--
-- That measurement also settles a tempting wrong turn: the 177 MB GIN index on
-- hand_history.players shows 0 scans and looks droppable, but the row+index
-- write is only 3.9 ms of the 46, and five call sites use
-- .contains('players', ...) - hand-history search, StatsExport, SettingsPage,
-- HandHistoryService and the server assistant. Dropping it would have saved
-- almost nothing and turned every player's hand search into a full scan of a
-- 10 GB table. It stays.
--
-- The triggers were slow for the reason everything else on this instance has
-- been slow: missing statistics. club_member_table_state - which
-- trg_hand_history_club_member_stats LEFT JOINs once per seated player - had
-- 119,823 live rows, 12,440 dead, and autovacuum_count = 0. It had never been
-- vacuumed or analyzed. profiles, which fn_fold_hand_winnings probes with an
-- EXISTS per seated player, reported n_live_tup = 0.
--
-- After VACUUM ANALYZE on those tables, same measurement:
--
--   Trigger hand_history_club_member_stats   13.883 -> 7.774 ms
--   Trigger hand_history_fold_stats          22.183 -> 3.071 ms
--   Trigger hand_history_position_stats       6.420 -> 2.721 ms
--   Execution Time                           46.417 -> 14.551 ms   (3.2x)
--
-- This migration makes that permanent. Storage parameters only.

ALTER TABLE public.club_member_table_state SET (
  autovacuum_enabled                    = true,
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_analyze_scale_factor       = 0.01,
  autovacuum_vacuum_cost_delay          = 0,
  autovacuum_vacuum_insert_threshold    = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

ALTER TABLE public.player_stats SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay    = 0
);

ALTER TABLE public.player_position_stats SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay    = 0
);

ALTER TABLE public.club_hand_daily SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay    = 0
);

ALTER TABLE public.profiles SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay    = 0
);

DO $assert$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['public.club_member_table_state','public.player_stats',
                      'public.player_position_stats','public.club_hand_daily',
                      'public.profiles']) AS t
   WHERE (SELECT reloptions FROM pg_class WHERE oid = t::regclass) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'autovacuum reloptions were not applied to: %', v_missing;
  END IF;
END $assert$;

-- ROLLBACK
--   ALTER TABLE public.club_member_table_state RESET (autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay, autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
--   ALTER TABLE public.player_stats           RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay);
--   ALTER TABLE public.player_position_stats  RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay);
--   ALTER TABLE public.club_hand_daily        RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay);
--   ALTER TABLE public.profiles               RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_delay);
