-- ============================================================================
-- AUDIT M6 — the rakeback settler's high-water mark can skip rows forever
-- ============================================================================
--
-- RakebackSettlerService reads new rake with a timestamp-only cursor:
--
--     .gt('created_at', sinceIso).order('created_at').limit(10000)
--
-- and then persists `rows[rows.length - 1].created_at` as the new watermark.
-- Two rows sharing one `created_at` value straddling the LIMIT boundary are
-- therefore lost permanently: row 10000 sets the watermark to T, and row
-- 10001 (also at T) is excluded forever by the strict `>` on the next cycle.
-- Rakeback that is never paid is never noticed, because nothing downstream
-- knows the row existed.
--
-- Production today has 12 exact-duplicate `created_at` groups out of 481k
-- rake_records, so the collision is real, not theoretical. It has not fired
-- yet only because `new Date(pgTimestamp)` truncates microseconds DOWNWARD in
-- V8, which pushes the saved watermark strictly below every existing tie and
-- accidentally re-includes both rows. That is an undocumented artifact of a
-- lossy conversion — it would evaporate the moment anyone made the timestamp
-- handling more precise. The cursor has to be made exact instead of lucky.
--
-- The fix is a composite keyset cursor on (created_at, id): a total order, so
-- there is no boundary a row can hide inside.
--
-- Re-processing is safe (every downstream accumulator is idempotent —
-- credit_agent_commission_from_rake dedupes on (user_id, source_id,
-- source_type), apply_rakeback_player_stats claims through
-- rakeback_stats_applied, rakeback_periods recomputes from source), so a
-- cursor that occasionally repeats a row costs nothing while a cursor that
-- skips one loses money. This migration only widens the cursor; it cannot
-- move it forward.
--
-- Two other daemons share this table and are deliberately untouched:
--   * tournament_sentinel     — watermarks tournaments.updated_at
--   * weekly_financial_close  — stores a week-start date, not a row timestamp
-- Neither reads high_water_mark_id, and the column is NULLable, so both keep
-- working unchanged.
-- ============================================================================

-- 1. The id half of the composite cursor.
--    NULLable on purpose: on the first cycle after deploy the settler has a
--    timestamp but no id, and falls back to today's plain `.gt(created_at)`
--    read. That is exactly current behaviour, so the deploy is a no-op until
--    the first cycle writes an id — and exact from cycle two onward.
ALTER TABLE public.daemon_state
  ADD COLUMN IF NOT EXISTS high_water_mark_id uuid;

COMMENT ON COLUMN public.daemon_state.high_water_mark_id IS
  'AUDIT M6: id half of the (created_at, id) keyset cursor. NULL means "no id '
  'component yet" and the reader must fall back to a timestamp-only filter. '
  'Only rakeback_settler uses this; tournament_sentinel and '
  'weekly_financial_close leave it NULL.';

-- 2. The index that makes the keyset read a range scan rather than a sort.
--    rake_records already has idx_rake_records_date on (created_at) alone,
--    which cannot serve the (created_at, id) tie-break.
--
--    PRODUCTION NOTE: this index was built against the live database with
--    CREATE INDEX CONCURRENTLY, not with the statement below — rake_records
--    is 301 MB and takes a write on every hand played, so a plain build would
--    have held an ACCESS EXCLUSIVE lock across the rake-distribution path.
--    The IF NOT EXISTS form is what a fresh environment replays; on
--    production it is already a no-op.
CREATE INDEX IF NOT EXISTS idx_rake_records_created_at_id
  ON public.rake_records (created_at, id);
