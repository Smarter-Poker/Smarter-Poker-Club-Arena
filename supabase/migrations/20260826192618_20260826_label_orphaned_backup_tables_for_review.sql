-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826192618; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TIER 1. Comments only. Nothing is dropped, nothing is read differently.
--
-- There are EIGHT one-off backup tables sitting in public, ~16 MB together, and
-- pg_stat_user_tables reports seq_scan = 0 AND idx_scan = 0 for every one of
-- them. Nothing has ever read any of them.
--
-- They are NOT dropped here, deliberately. Dropping is irreversible, one of
-- them was created TODAY by another agent mid-flight, and none of them is
-- costing enough to justify an agent guessing which migrations they still
-- insure. What they lack is not deletion, it is a stated expiry -- so the next
-- person to sweep can act on a date instead of a guess.
--
-- Convention: a backup table carries a comment saying what it insures and when
-- it stops being worth keeping. Sweeping is then trivial and safe:
--
--   SELECT c.relname, obj_description(c.oid)
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname LIKE '%backup%'
--      AND obj_description(c.oid) LIKE 'ORPHANED BACKUP%';

COMMENT ON TABLE public.club_member_daily_stats_profit_backup_20260826 IS
  'ORPHANED BACKUP. 123,463 rows, 13 MB, never read (seq_scan=0, idx_scan=0 as of 2026-08-26). Created 2026-08-26 alongside a profit-reconciliation change. Safe to drop once that change has held for a full stats cycle; confirm with its author first. Review after 2026-09-26.';

COMMENT ON TABLE public.social_posts_thumbnail_backup_20260815 IS
  'ORPHANED BACKUP. 14,906 rows, 2.4 MB, never read (as of 2026-08-26). Insures the 2026-08-15 thumbnail migration. Review after 2026-09-15.';

COMMENT ON TABLE public.vip_backfill_20260812_backup IS
  'ORPHANED BACKUP. 470 rows, never read (as of 2026-08-26). Insures the 2026-08-12 VIP backfill. Review after 2026-09-12.';

COMMENT ON TABLE public.horse_avatar_swap_backup IS
  'ORPHANED BACKUP. 391 rows, never read (as of 2026-08-26). Insures the horse avatar swap. No date in the name -- establish provenance before dropping. Review after 2026-09-26.';

COMMENT ON TABLE public.commander_blind_structure_backup_20260822 IS
  'ORPHANED BACKUP. Never read (as of 2026-08-26). Insures the 2026-08-22 blind-structure change. Review after 2026-09-22.';

COMMENT ON TABLE public.commander_finish_position_backup_20260820 IS
  'ORPHANED BACKUP. 133 rows, never read (as of 2026-08-26). Insures the 2026-08-20 finish-position change. Review after 2026-09-20.';

COMMENT ON TABLE public.avatar_photo_migration_backup IS
  'ORPHANED BACKUP. Never read (as of 2026-08-26). Insures the avatar photo migration. No date in the name -- establish provenance before dropping. Review after 2026-09-26.';

DO $$
DECLARE v_labelled int;
BEGIN
  SELECT count(*) INTO v_labelled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND obj_description(c.oid) LIKE 'ORPHANED BACKUP%';

  IF v_labelled < 7 THEN
    RAISE EXCEPTION 'assertion failed: only % backup table(s) labelled, expected at least 7', v_labelled;
  END IF;

  RAISE NOTICE '% orphaned backup tables labelled with a review date; none dropped', v_labelled;
END $$;
