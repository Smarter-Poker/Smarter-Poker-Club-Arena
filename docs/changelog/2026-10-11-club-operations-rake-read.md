# Club Operations Rake Snapshot Reads

Frequent club-ledger invalidations could replace an in-flight rake snapshot before it finished, leaving the initial totals on Reading Rollups. The panel now lets the same account, context and reporting question finish before accepting another refresh. A changed reporting question still reads immediately and rejects late responses from the previous view. Unmount and identity changes invalidate ownership, and completion or failure releases the pending read.

Regression coverage reproduces repeated refresh requests before the repair and verifies completion, changed-context response rejection and retry after refusal. This is a client request-lifecycle repair; it introduces no scheduler, database change or financial write.
