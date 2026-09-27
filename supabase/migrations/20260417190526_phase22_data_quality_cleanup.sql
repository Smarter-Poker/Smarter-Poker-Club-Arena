-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417190526 "phase22_data_quality_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c3d153a8d4f0cf1e28d1f77ae664e01a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Data quality cleanup
--  -----------------------------------------------------------------------
--  Fixes surfaced by the home-games schema audit (Friday Apr 17 2026).
--
--  1. C02: remove orphan social_page residue from the reverted Phase 16A
--     smoke test. Its linked_entity_id (015e51f2-…) points to a home_group
--     that no longer exists. The social_page row itself was never cleaned
--     up when Dan deleted the Phase 16A migration file (db317a1c).
--     is_public=false so it hasn't caused discovery leakage, but it pollutes
--     the slug namespace and could cause false joins.
--
--  2. C10: two old test-fixture games ("Game Night 3") on 2026-02-16 are
--     still marked status='scheduled' 60 days after the fact. Legal statuses
--     per CHECK constraint include 'completed' — flipping them aligns state
--     with reality. (Phase 20 API wouldn't have surfaced them anyway because
--     the scheduled_date filter also excludes past dates, but keeping them
--     as 'scheduled' is wrong state that would confuse future analytics
--     and a hypothetical "all upcoming games for this group" query.)
--
--  No behavior change for production APIs — this is janitorial.
-- =========================================================================

-- 1. Remove orphan social_page (Phase 16A smoke-test residue)
DELETE FROM social_pages
 WHERE id = '669f4c68-8210-4a12-afca-3c96e94ae247'
   AND slug = 'phase16a-smoke-test-group'
   AND linked_entity_type = 'home_group'
   AND linked_entity_id = '015e51f2-d6fa-4d5f-8bed-fcbe9611e46d';

-- 2. Flip two old-test-fixture "Game Night 3" rows from scheduled → completed
UPDATE commander_home_games
   SET status = 'completed',
       updated_at = NOW()
 WHERE id IN (
          'bcbaf98f-7ba6-464d-b312-8006263dfca9',   -- Saturday Night
          '0c5ddf03-2c93-44af-8864-1150181c0155'    -- High Rollers
       )
   AND status = 'scheduled'
   AND scheduled_date = '2026-02-16';
