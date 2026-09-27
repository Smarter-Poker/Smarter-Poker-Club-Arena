-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503091654 "phase43_trim_realtime_publication_15_zero_subscriber_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fef7eff930fb0572adb4b89392a06c33 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260503_phase43_trim_realtime_publication_15_zero_subscriber_tables.sql
-- TIER 2 (publication membership change, fully reversible)
-- AFFECTS: supabase_realtime publication membership only
--          (no schema changes, no data writes)
-- IRREVERSIBLE: NO — reverse with ALTER PUBLICATION ADD TABLE
--
-- WHY:
--   Per the realtime audit dashboard (Cowork artifact id:
--   realtime-publication-audit), 15 of 59 tables in the supabase_realtime
--   publication have ZERO anon-context realtime subscribers in the
--   codebase. These broadcast writes to no consumer = pure WAL-to-broker
--   overhead with no UI benefit.
--
--   13 are empty (cost is zero today but locks in waste if features wake)
--   2 have rows but are dormant (financial_alerts 1383 rows / 14d-stale;
--                                 commander_members 107 rows / 61d-stale)
--
--   Estimated savings: $60-120/mo against the current $205 Realtime
--   Messages line, varies with actual write traffic on these tables.
--
-- ROLLBACK if anything breaks:
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.<tablename>;
-- ═══════════════════════════════════════════════════════════════════════

-- Pre-flight: confirm 15 candidates are still in publication
DO $$
DECLARE v_count integer;
BEGIN
    SELECT COUNT(*) INTO v_count FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public'
      AND tablename IN (
          'financial_alerts','commander_members','conversations','commander_promotions',
          'cashout_requests','club_arena_audit_logs',
          'commander_home_poll_votes','commander_home_polls',
          'commander_home_post_comments','commander_home_post_likes',
          'follows','live_gifts','pending_calls',
          'video_favorites','video_watch_history'
      );
    RAISE NOTICE 'Pre-flight: % of 15 candidates currently in publication', v_count;
END $$;

ALTER PUBLICATION supabase_realtime DROP TABLE
    public.financial_alerts,
    public.commander_members,
    public.conversations,
    public.commander_promotions,
    public.cashout_requests,
    public.club_arena_audit_logs,
    public.commander_home_poll_votes,
    public.commander_home_polls,
    public.commander_home_post_comments,
    public.commander_home_post_likes,
    public.follows,
    public.live_gifts,
    public.pending_calls,
    public.video_favorites,
    public.video_watch_history;

-- Post-apply: verify all 15 are gone + total publication size dropped
DO $$
DECLARE v_remaining integer; v_total_now integer;
BEGIN
    SELECT COUNT(*) INTO v_remaining FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public'
      AND tablename IN (
          'financial_alerts','commander_members','conversations','commander_promotions',
          'cashout_requests','club_arena_audit_logs',
          'commander_home_poll_votes','commander_home_polls',
          'commander_home_post_comments','commander_home_post_likes',
          'follows','live_gifts','pending_calls',
          'video_favorites','video_watch_history'
      );
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Post-apply: % candidates still in publication', v_remaining;
    END IF;

    SELECT COUNT(*) INTO v_total_now FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public';
    RAISE NOTICE 'Post-apply: 15 dropped, % tables remain in publication', v_total_now;
END $$;
