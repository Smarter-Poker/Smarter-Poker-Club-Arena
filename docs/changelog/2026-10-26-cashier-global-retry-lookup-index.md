# Cashier retry lookup index

The send's exact-intent guard checks legacy operation IDs across every club and transaction type. Its unindexed JSON expression scanned the full transaction history before a new send could start; a database cancellation left the browser correctly retaining an unknown outcome.

Add a nonunique concurrent expression index for non-null operation IDs. The guard remains unchanged, including cross-club ownership and exact-intent replay protection. The existing migration installer builds it without blocking financial writers and verifies its catalog shape before recording installation.

The requested 25-chip transfer was recovered through its original batch and operation IDs after a self-aborting transaction probe, then independently read back as one committed transaction with matching debit and credit. No wallet rows were manually adjusted.
