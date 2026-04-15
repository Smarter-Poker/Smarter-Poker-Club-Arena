-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase D-2 #1 — Per-Hand Equal-Share Rake Verification
-- ═══════════════════════════════════════════════════════════════════════════════
-- Validates DECISION D-001 / FIX 144 — every dealt-in player gets exactly rake/N.
--
-- Run after a real cash hand has been played.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Show rake distribution for the last 10 hands at a sampled cash table
WITH recent_hands AS (
  SELECT id, table_id, total_rake, dealt_in_count, completed_at
  FROM hands
  WHERE total_rake > 0
    AND completed_at > NOW() - INTERVAL '7 days'
  ORDER BY completed_at DESC
  LIMIT 10
),
rake_per_hand AS (
  SELECT
    rh.id AS hand_id,
    rh.total_rake,
    rh.dealt_in_count,
    (rh.total_rake::numeric / GREATEST(rh.dealt_in_count, 1)) AS expected_per_player,
    COUNT(hrh.user_id) AS actual_credited_count,
    MIN(hrh.rake_amount) AS min_credit,
    MAX(hrh.rake_amount) AS max_credit,
    SUM(hrh.rake_amount) AS total_credited
  FROM recent_hands rh
  LEFT JOIN hand_rake_history hrh ON hrh.hand_id = rh.id
  GROUP BY rh.id, rh.total_rake, rh.dealt_in_count
)
SELECT
  hand_id,
  total_rake,
  dealt_in_count,
  expected_per_player,
  actual_credited_count,
  min_credit,
  max_credit,
  total_credited,
  CASE
    WHEN actual_credited_count != dealt_in_count THEN 'FAIL — credit count mismatch'
    WHEN ABS(min_credit - expected_per_player) > 0.01 THEN 'FAIL — min credit deviates from expected'
    WHEN ABS(max_credit - expected_per_player) > 0.01 THEN 'FAIL — max credit deviates from expected'
    WHEN min_credit != max_credit THEN 'FAIL — unequal credits (rake was weighted)'
    WHEN ABS(total_credited - total_rake) > 0.01 THEN 'FAIL — total credited differs from total_rake'
    ELSE 'PASS — equal share, FIX 144 holds'
  END AS verdict
FROM rake_per_hand
ORDER BY hand_id DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- EXPECTED: every row PASS — equal share, FIX 144 holds
-- A single FAIL means FIX 144 has regressed and rake is being weighted again.
-- ═══════════════════════════════════════════════════════════════════════════════
