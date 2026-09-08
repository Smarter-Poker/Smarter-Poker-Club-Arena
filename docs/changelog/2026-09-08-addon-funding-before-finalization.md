# Fund the add-on guarantee before marking the pool finalized

The original add-on completion method wrote prize_pool_finalized before calling fn_apply_prize_guarantee. That RPC treats an already-finalized pool as complete, so the write prevented the missing guarantee from being funded. The memory flag also prevented another invocation after a failed funding call.

The RPC now owns database finalization, and the existing applyPrizeGuarantee method owns the memory flag after success. Eliminated prizes use the returned funded pool. The add-on period-end notice still closes the elapsed window when funding fails.

Verification: an executable test extracts both actual manager methods using the TypeScript AST. With an RPC stub reproducing the database finalization shortcut, the baseline failed three of four cases. All four pass after the correction, including failure followed by a later invocation and duplicate successful invocation. Server TypeScript passed; the full server suite passed 6,490 tests across 458 files.

Limits: the test stubs database I/O. It does not prove concurrent database sessions, production wallet triggers, or automatic retry scheduling for minute-based add-on windows. No new recovery mechanism, historical payout, or wallet edit is introduced. Runtime deployment and the complete platform audit remain separate verification gates.
