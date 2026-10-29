# Weekly quality installer read boundaries

The first production attempt of the merged but uninstalled 185823 migration was refused after five seconds while reading the original historical source generation. CREATE FUNCTION had not run, and the subsequent durable read retained the original function, metadata and absent migration history.

The corrected uninstalled file keeps its exact old and new full function bodies, metadata, ACL and all original source checks. Source65 and generation qualification run in separate bounded 15-second read statements before and after the exact five-second function DDL statement, in one transaction with one-second lock timeout. Transaction-local state retains both full guard definitions and generation; any post-check failure aborts the entire transaction. No historical source, generation owner or financial record is modified.

The maintained PostgreSQL fixture retains all original parity, fault and snapshot cases. Added accelerated timing cases prove that a read slower than the narrowed DDL budget succeeds, DDL timeout still aborts, post-source and generation mismatch roll back DDL, and LOCAL state clears on the same connection after COMMIT. Production installation and actual book closure remain separate evidence.
