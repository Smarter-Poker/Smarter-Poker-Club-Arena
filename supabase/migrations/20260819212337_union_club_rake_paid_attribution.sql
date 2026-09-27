-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819212337 "union_club_rake_paid_attribution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 504192a95ab415b8f1b19f34a7d0a61d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PER-CLUB RAKE ATTRIBUTION (2026-08-19, audit fix pass 3)
--
-- WHY THIS EXISTS — the accounting identity that makes the weekly settlement
-- correct. For a player on a union table:
--     buy-in : wallet -X, seated +X      (net 0)
--     cash-out: wallet +Y, seated -Y     (net 0)
--     play    : chips move seat-to-seat; rake leaves the pot
-- therefore, per club:
--     realized_net + stack_delta = (inter-club transfer) - (rake its players paid)
--
-- The rake has ALREADY been swept to the union rake_wallet per hand by the
-- engine. Settling `realized_net + stack_delta` as-is would collect it from
-- the clubs a SECOND time. Adding the rake back leaves exactly the inter-club
-- transfer, which is what the clubs actually owe each other:
--     settle_net = realized_net + stack_delta + rake_paid
-- and across all clubs in a union that sums to ~0 — an invariant the
-- settlement asserts on every run.
--
-- Attribution is by pot contribution (rake_records.player_contributions),
-- the same weighting the rakeback settler uses. Whole-union in one pass; the
-- per-hand total is computed inline rather than with a window function, which
-- avoids a multi-hundred-thousand-row external merge sort.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_rake_records_table_created
  ON rake_records (table_id, created_at) WHERE player_contributions IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_union_rake_paid_by_club(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz
) RETURNS TABLE (club_id uuid, rake_paid numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id),
  rr AS (
    SELECT r.id, r.rake_amount, r.player_contributions,
           (SELECT SUM(t.value::numeric)
              FROM jsonb_each_text(r.player_contributions) AS t(key, value)) AS total_contrib
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL
       AND r.rake_amount > 0
  )
  SELECT a.club_id,
         round(SUM(rr.rake_amount * (e.value::numeric) / rr.total_contrib), 2) AS rake_paid
    FROM rr
    CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) AS e(key, value)
    JOIN attributed a ON a.user_id = (e.key)::uuid
   WHERE rr.total_contrib > 0
   GROUP BY a.club_id;
$$;

REVOKE ALL ON FUNCTION fn_union_rake_paid_by_club(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_rake_paid_by_club(uuid, timestamptz, timestamptz) TO service_role;
