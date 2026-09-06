-- 20260906144259_phase_4_game_management_health_scope_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The Phase 4 health RPC filters one scope and two short time windows. Its
-- original indexes could answer either the scope or the time, never both, so
-- PostgreSQL chose a parallel sequential scan of the whole append-only feed.
-- Measured on production before this index: 1,470,044 rows read and 1.26s for
-- the largest union's health aggregate.
--
-- ONE STATEMENT, NO TRANSACTION, ON PURPOSE. This table receives several game
-- invalidations per second and a plain CREATE INDEX would block those writes.
-- CREATE INDEX CONCURRENTLY is the only safe build and PostgreSQL forbids it
-- inside a transaction block. The companion transactional migration refuses
-- to replace the RPC unless this index exists and is valid.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_management_events_scope_created_cover
  ON public.game_management_events (scope_kind, scope_id, created_at DESC)
  INCLUDE (sequence, event_type)
  WHERE scope_kind IS NOT NULL AND scope_id IS NOT NULL;
