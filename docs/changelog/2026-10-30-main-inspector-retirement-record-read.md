# Read the original MAIN Inspector retirement records

The existing release failed before announcement with a generic retirement refusal. That message also covers failures before its durable claim is written, so it cannot establish that native attachment or closure occurred. The previous recovery reader had no way to read these specific records without observing a socket or process.

Add an explicitly requested, bounded file-only mode to the existing production-integrity recovery reader. It binds the selected run and release to retained request records or its terminal failure result, then projects only validated claim/receipt identity and outcome predicates. It does not open a socket, invoke the engine, alter a record, or authorize a retry. Missing or incomplete evidence remains explicit; reading the records is not tournament recovery or deployment proof.

The existing manually invoked audit job qualifies the reader and retains its sanitized result. Scheduled audit behavior and the engine release protocol stay unchanged.
