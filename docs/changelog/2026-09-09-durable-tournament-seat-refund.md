# Durable Tournament Seat Refund Requests

Before: TournamentService.leaveTournamentSeatAndRefund at line 1536 generated a fresh UUID per invocation. Its two transport attempts shared an ID, but a later retry could not recover the original operation.

Change: require the expected authenticated account and invoke the existing durable refund intent helper with a table-scoped key. Preserve canonical receipt parsing and returned ticket values. The database remains the only refund authority. No migration or balance adjustment.

Verification: two new regressions failed before the fix; 108 tests in three files pass after it. TypeScript and production build pass (behind-main=0). Both TablePage exit handlers call this method. The unchanged durable helper already has module-reload and storage-failure coverage. Normal publication remains pending. Overall accounting Phase 3 remains open.
