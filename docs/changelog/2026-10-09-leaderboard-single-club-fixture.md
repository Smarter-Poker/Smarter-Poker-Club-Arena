# Separate Isolated Club Opening Statements

The faithfully restored Auth fixture reaches signup but refuses its final deferred constraints with SQLSTATE 23514. Its three-club insert lets all BEFORE seeders replace a transaction-scoped opening key before the queued AFTER journal triggers consume it. Create each synthetic club in a separate statement within the same transaction, preserving the original seeder, journal, issuance checks, amounts, actor identity and final constraint enforcement.

Refresh only the shared fixture and signup-section fingerprints. Retain a generated-SQL regression requiring three one-row statements and one diagnostic stage. Actual restored-schema Auth and financial qualification remain required; no production function or frozen financial candidate changes.
