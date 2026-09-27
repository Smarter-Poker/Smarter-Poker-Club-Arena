-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819215131 "union_pnl_retry_baseline_and_window_fixes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 24f970eebb025b65217294821d5b6eb7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION P&L — AUDIT ROUND 2 FIXES (2026-08-19)
--
-- Three defects found by auditing the fixes themselves:
--
-- A. CRITICAL — 'needs_review' PERMANENTLY BLOCKED RETRY. The idempotency
--    index on (union_id, period_start) is status-agnostic, so once the guard
--    recorded a period as needs_review, every later attempt hit
--    unique_violation and returned {already_settled:true}. That week could
--    never be settled again, and it reported SUCCESS while doing nothing.
--    Fix: the unique index now covers only rows that actually claim the
--    period ('in_progress'/'settled'); a needs_review row is superseded on
--    retry instead of blocking it.
--
-- B. HIGH — THE FIRST WEEKLY RUN HAD NO BASELINE. Baselines were looked up
--    with period_start < p_start, but the bootstrap row is dated at the time
--    it ran (mid-period), so the next window (previous Monday -> this Monday)
--    found nothing, forced stack_delta = 0, and would have tripped the guard
--    — then been permanently stuck by (A). Fix: the baseline is the most
--    recent settled snapshot before the window ENDS, so a mid-period
--    bootstrap is usable exactly once and every later run chains off the
--    previous settlement.
--
-- C. MED — SEATED STACK WAS MEASURED AT CALL TIME, NOT AT period_end. A job
--    running Monday 10:00 for a window ending Monday 00:00 mis-stated every
--    club's closing stack by 10 hours of play. Fix: fn_union_settle_player_pnl_weekly
--    chains the window from the last settlement to NOW, so the closing stack
--    is measured exactly at the boundary it is recorded as — and consecutive
--    periods cannot leave a gap that loses flows.
-- ============================================================================

-- A. Retry-safe idempotency ---------------------------------------------------
DROP INDEX IF EXISTS ux_union_pnl_settlements_period;
CREATE UNIQUE INDEX IF NOT EXISTS ux_union_pnl_settlements_period
  ON union_pnl_settlements (union_id, period_start)
  WHERE status IN ('in_progress', 'settled');

-- B + C. Baseline lookup + self-chaining weekly window -------------------------
CREATE OR REPLACE FUNCTION fn_union_pnl_baseline(p_union_id uuid, p_end timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT club_results
    FROM union_pnl_settlements
   WHERE union_id = p_union_id
     AND status = 'settled'
     AND period_start < p_end
   ORDER BY period_start DESC
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_union_settle_player_pnl_weekly(
  p_union_id uuid,
  p_min_hours numeric DEFAULT 12
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz := now();
BEGIN
  -- Chain from the end of the last settled period so no flows fall between
  -- two windows. First ever run falls back to 7 days.
  SELECT period_end INTO v_start
    FROM union_pnl_settlements
   WHERE union_id = p_union_id AND status = 'settled'
   ORDER BY period_start DESC LIMIT 1;

  IF v_start IS NULL THEN
    v_start := v_end - interval '7 days';
  END IF;

  -- Guard against a double-run settling a near-empty sliver of time.
  IF EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0 < p_min_hours THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_too_short',
      'hours', round((EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0)::numeric, 2),
      'period_start', v_start, 'period_end', v_end);
  END IF;

  RETURN fn_union_settle_player_pnl_guarded(p_union_id, v_start, v_end);
END $$;

REVOKE ALL ON FUNCTION fn_union_pnl_baseline(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_union_settle_player_pnl_weekly(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_baseline(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION fn_union_settle_player_pnl_weekly(uuid, numeric) TO service_role;

-- Assertions ------------------------------------------------------------------
DO $$
DECLARE v_partial boolean;
BEGIN
  SELECT indexdef LIKE '%WHERE%status%' INTO v_partial
    FROM pg_indexes WHERE indexname = 'ux_union_pnl_settlements_period';
  IF NOT COALESCE(v_partial, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: idempotency index is not retry-safe';
  END IF;

  -- The bootstrap must now be reachable as a baseline for a window ending later.
  IF (SELECT fn_union_pnl_baseline(
        (SELECT id FROM unions LIMIT 1), now() + interval '7 days')) IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: no baseline reachable after bootstrap';
  END IF;
END $$;
