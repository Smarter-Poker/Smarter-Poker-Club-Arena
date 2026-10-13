# Hand-history pruning respects the existing settlement installation lane

The qualified scoped launch reset could not install because the existing hand-history pruner held a chip-ledger read lock for about 21 seconds every 30 seconds while bypassing the settlement lane. The bounded installer correctly refused instead of holding live financial traffic behind a longer schema lock.

The original pruner now tries the existing shared transaction lock before reading any relation. If an installer owns that lane exclusively, the prune returns zero. An already admitted prune completes normally. The schedule, retention window, deletion predicates, execution budget and function authority remain unchanged. The migration guards the exact original definition and privileges and refuses drift or replay.

The required native installer qualification also verifies this admission against real PostgreSQL connections and the exact migration. Scoped launch financial source and its recovery/cache certificates are unchanged. Installation and the launch reset still require independent production readback, the scoped drain, live rollback proof and final postconditions.
