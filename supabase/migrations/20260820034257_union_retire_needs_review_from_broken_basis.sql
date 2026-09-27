-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820034257 "union_retire_needs_review_from_broken_basis"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bf20cb54b33d158768b61ab1615ff714 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Every needs_review row was parked by the guard while the P&L basis was wrong
-- (baseline anchored at the period end, and rake attribution excluding the very
-- horses the P&L counted). Those windows can never be settled retroactively -
-- their seated-stack baselines were captured under the broken definition - so
-- they are retired as superseded rather than left to make the governance check
-- shout about a condition that no longer exists. No chips were ever moved by
-- any of them (total_collected = total_paid = 0).
UPDATE union_pnl_settlements
   SET status = 'superseded'
 WHERE status = 'needs_review'
   AND total_collected = 0
   AND total_paid = 0
   AND period_start < '2026-08-20 03:40:00+00';

