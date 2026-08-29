-- RETIRED 2026-08-29 (Dan): equal-dealt rake attribution (FIX 144 / DECISION
-- D-001) is superseded by WEIGHTED CONTRIBUTED rake for all new cash hands.
-- This harness also referenced `hands.total_rake`, `hands.dealt_in_count` and
-- `hand_rake_history`, none of which exist in the live schema any more, so it
-- had been unrunnable and guarding nothing.
--
-- The live verification is: scripts/verification-harness/02-weighted-contributed-rake.sql
-- Historical DEALT_EQUAL rows are still processed under their historical equal
-- split (see fn_allocate_rake_credits, method 'DEALT_EQUAL').
SELECT 'RETIRED — use 02-weighted-contributed-rake.sql' AS notice;
