-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION 02: WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29)
-- Replaces 02-equal-share-rake.sql (FIX 144 / D-001 — RETIRED for new hands;
-- the old harness also referenced tables that no longer exist, so nothing was
-- actually guarding attribution).
--
-- What must hold, per hand settled under WEIGHTED_CONTRIBUTED:
--   1. A rake_attributions row exists for every positive contributor.
--   2. Σ weighted_rake_credit == rake_records.rake_amount (exactly, 2dp).
--   3. Each credit is proportional to eligible contribution (allocator-exact:
--      recomputing with fn_allocate_rake_credits reproduces the stored row).
--   4. Zero-contribution players receive nothing.
--   5. BBJ attribution sums back to the hand's BBJ drop (when contributions
--      exist) and never leaks into regular rake credit.
--
-- Run against production (read-only). Recent window to keep it cheap.
-- ═══════════════════════════════════════════════════════════════════════════

-- A. Per-hand reconciliation: allocated == collected
WITH recent AS (
  SELECT r.hand_id, r.rake_amount, r.bbj_contribution, r.player_contributions, r.rake_method
    FROM rake_records r
   WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
     AND r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.created_at > now() - interval '24 hours'
), agg AS (
  SELECT rec.hand_id,
         rec.rake_amount,
         COALESCE(SUM(ra.weighted_rake_credit), 0)        AS allocated,
         COALESCE(SUM(ra.bbj_attributed_contribution), 0) AS bbj_allocated,
         rec.bbj_contribution,
         COUNT(ra.player_id)                              AS credited_players,
         (SELECT COUNT(*) FROM jsonb_each(rec.player_contributions) e
           WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric > 0) AS positive_contributors
    FROM recent rec
    LEFT JOIN rake_attributions ra ON ra.hand_id = rec.hand_id
   GROUP BY rec.hand_id, rec.rake_amount, rec.bbj_contribution, rec.player_contributions
)
SELECT
  COUNT(*)                                                          AS hands_checked,
  COUNT(*) FILTER (WHERE round(allocated, 2) <> round(rake_amount, 2))
                                                                    AS rake_reconcile_failures,
  COUNT(*) FILTER (WHERE credited_players <> positive_contributors) AS credited_count_mismatches,
  COUNT(*) FILTER (WHERE bbj_contribution > 0
                     AND round(bbj_allocated, 2) <> round(bbj_contribution, 2))
                                                                    AS bbj_reconcile_failures,
  CASE WHEN COUNT(*) FILTER (WHERE round(allocated, 2) <> round(rake_amount, 2)) = 0
        AND COUNT(*) FILTER (WHERE credited_players <> positive_contributors) = 0
        AND COUNT(*) FILTER (WHERE bbj_contribution > 0
                               AND round(bbj_allocated, 2) <> round(bbj_contribution, 2)) = 0
       THEN 'PASS — weighted contributed rake reconciles'
       ELSE 'FAIL — see failure counters'
  END AS verdict
FROM agg;

-- B. Spot-check: stored credits match a fresh run of the canonical allocator
-- (any row returned is a defect — the ledger and the allocator disagree).
SELECT ra.hand_id, ra.player_id, ra.weighted_rake_credit AS stored, a.credit AS recomputed
  FROM rake_records r
  JOIN rake_attributions ra ON ra.hand_id = r.hand_id
  JOIN LATERAL fn_allocate_rake_credits(r.rake_amount, r.player_contributions, r.rake_method) a
    ON a.user_id = ra.player_id
 WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
   AND r.created_at > now() - interval '24 hours'
   AND round(a.credit, 2) <> round(ra.weighted_rake_credit, 2)
 LIMIT 50;

-- C. Zero contributors must never be credited (invariant 6).
SELECT ra.hand_id, ra.player_id, ra.eligible_contribution, ra.weighted_rake_credit
  FROM rake_attributions ra
 WHERE ra.rake_method = 'WEIGHTED_CONTRIBUTED'
   AND COALESCE(ra.eligible_contribution, 0) <= 0
   AND ra.weighted_rake_credit > 0
 LIMIT 50;
