# Union Statement Balances And Access

The live statement RPC filtered old invoices and payments before calculating its running total. A fixture with an opening balance of 80 and three current movements produced 50, 40 and 10 instead of 130, 120 and 90. The original SQL reproduced this failure. The corrected query computes the full history first, then filters displayed entries. Stable row IDs disambiguate identical timestamps and references.

The RPC was SECURITY DEFINER with authenticated EXECUTE but no actor check. It now uses the existing ca_can_view_club_finances, ca_can_oversee_union and fn_is_platform_admin helpers before returning rows. Anonymous execution remains revoked. No role policy was redefined and no stored invoice, payment or balance was altered.

A self-aborting pg_temp test passed opening balance, whole-history totals, credit-note signs, date boundary, denied caller, permitted club/union/platform branches, tenant row separation, and an empty date range. Permission helper responses are stubbed in this test; the real helper definitions and ACL were inspected, but every real role/session combination has not been exercised. Empty ranges still return no entries, preserving the existing RPC shape; a balance-only account-summary API remains a separate completeness item.

Production migration 20260907195229 was assigned by Supabase MCP, applied under a source-hash precondition, then the deployed function body passed the same rollback-only test. Source uses that actual migration version. No financial mutation or reimbursement was necessary for a corrected read.

GitHub MCP submission is used because direct clone authentication is unavailable. Full project TypeScript/build checks and browser flows were not executable locally and are not claimed. Required repository gates remain enabled. This closes the specific read-path defects, not the entire union accounting audit.

CI follow-up: server engine passed. The source ACL checker required explicit REVOKE/GRANT statements in the new migration even though CREATE OR REPLACE retained the verified live grants. Those existing grants are now restated. The migration assertions were moved into a separate test rather than the sentinel array that intentionally accepts only src/ paths. No gate or expectation was weakened. Full replacement-run results must be checked separately.
