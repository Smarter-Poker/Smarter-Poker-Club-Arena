-- 20260823160000_autovacuum_club_member_daily_stats.sql
--
-- Completes 20260823140000, which missed the most important table on the
-- hand-insert path.
--
-- trg_hand_history_club_member_stats upserts into TWO tables per seated player,
-- not one: club_member_table_state (covered by 20260823140000) and
-- club_member_daily_stats (not covered). The second is the single largest write
-- source in the entire database - 63,787 writes, 61,490 of them UPDATEs - and it
-- had never been vacuumed:
--
--   club_member_daily_stats: 154,780 live, 28,770 dead (18.6%),
--                            autovacuum_count = 0, last_vacuum NULL
--
-- The symptom was the trigger re-degrading within minutes of being fixed. After
-- 20260823140000 the trigger measured 7.774 ms; eight minutes later it was back
-- to 19.543 ms while the other two triggers stayed fast. Vacuuming
-- club_member_daily_stats brought it to 8.702 ms - an upsert whose ON CONFLICT
-- target is an 18.6%-bloated 155k-row table is slow no matter how good the
-- statistics on everything around it are.
--
-- Thresholds are tighter than its siblings because it churns hardest: at 155k
-- rows, scale_factor 0.01 vacuums every ~1,550 dead tuples.

ALTER TABLE public.club_member_daily_stats SET (
  autovacuum_enabled                    = true,
  autovacuum_vacuum_scale_factor        = 0.01,
  autovacuum_analyze_scale_factor       = 0.01,
  autovacuum_vacuum_cost_delay          = 0,
  autovacuum_vacuum_cost_limit          = 10000,
  autovacuum_vacuum_insert_threshold    = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

DO $assert$
DECLARE v_opts text;
BEGIN
  SELECT array_to_string(reloptions, ',') INTO v_opts
    FROM pg_class WHERE oid = 'public.club_member_daily_stats'::regclass;
  IF v_opts IS NULL OR v_opts NOT LIKE '%autovacuum_vacuum_scale_factor=0.01%' THEN
    RAISE EXCEPTION 'club_member_daily_stats autovacuum settings were not applied (got: %)', v_opts;
  END IF;
END $assert$;

-- ROLLBACK
--   ALTER TABLE public.club_member_daily_stats RESET (
--     autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor,
--     autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit,
--     autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
