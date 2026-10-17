# Cashier Conservation Retains Cutoff Statistics

Reconcile Now returned SQLSTATE57014 in production client job117218677928. The report's UNION-derived baseline materialization loses timestamp statistics: the live plan estimated200 cutoffs instead of1 and22million grouped legs instead of1183, reserving a1,048,576-bucket64-batch hash and spilling a tiny result.

The report now reads the identical distinct cutoff set directly from ca_chip_baseline. Later-member synthetic baselines reuse its minimum, so they add no new cutoff. Missing, null, future and individual cutoffs, exact amounts, all booked wallet sides, bank and inventory output, authorization and read-only posture remain unchanged. No timeouts or indexes change.

Live read-only query comparison returned identical whole JSON; the candidate used one hash batch and no temporary writes. The historical8second timeout is retained evidence; the later cold read2.573seconds and warm generic read0.845seconds did not recreate that transient failure. Disposable PostgreSQL checks preserve whole-report equality across coverage boundaries and demonstrate the old generic-plan spill versus the candidate's single covering pass without spill. Required CI runs that qualification in the existing accounting lane. Protected delivery, guarded installation and live Reconcile verification are separately required.
