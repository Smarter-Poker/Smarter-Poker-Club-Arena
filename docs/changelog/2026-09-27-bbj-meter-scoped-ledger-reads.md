# BBJ meter reads only the pool journal it proves

The existing hourly rake/BBJ audit exceeded its 120-second statement budget in
the BBJ meter's ledger SELECT. The same query planned very differently for the
three active pools: two read broadly by creation time, while the small pool
used its entity indexes. Splitting the OR alone still chose the broad scan.

Two narrow partial indexes make the existing OR query read only its pool
legs. The entire financial function remains byte-identical, preserving the
full cumulative opening-balance proof. An outgoing leg with a NULL destination
is retained, and a self-leg is counted once. All categories, label precedence,
interval boundaries, rounding, returned financial fields, snapshot writes,
privileges and the existing schedule remain unchanged. The indexed values are
only UUID and timestamp: financial fields remain heap reads, so no new index
tuple limit can reject a valid unbounded label. There is no new job,
financial correction, baseline reset or timeout increase.

The exact online index SQL is separate from the short verification migration,
so a migration transport cannot wrap a concurrent build in a transaction. Each
build retains a six-minute statement budget, 180-second lock budget, sufficient
runway before the maintenance window and durable outcome readback. The single
verification transaction refuses a missing, invalid, unready or different index,
changed predecessor or changed authority, and verifies the unchanged function
without changing its OID or privileges. An interrupted index build requires
durable readback before any next action.

An isolated PostgreSQL 17 qualification executes the captured original and the
exact migration. It compares complete financial results against a hand-derived
boundary case and the predecessor, checks real service/denied browser roles,
missing baseline/pool, wrong/invalid indexes, oversized labels before and after
installation, rollback and concurrent bank/leg visibility. Its mixed 600,000-row
ledger requires both custom and generic plans to use the pool/time index bounds
and eliminate unrelated tuple scans. The predecessor without the indexes must fail that regression. A separate
indexes-only comparison showed the OR query already becomes scoped, so no
financial function rewrite is included. Large-pool heap work remains; timing and buffer
observations are fixture evidence, not production capacity or billing savings.

Production installation was read back on September 27 at 05:08 UTC. Both online indexes are valid, ready and live. The separate verification transaction is recorded once as `20260927050742`; the maintained filename and native/source fixture paths match that actual history version. Its 3,348 bytes are unchanged (SHA-256 `e68f3b008955dba1f7de2e7cf877585e85aa9db68887c3c44e54172521b2ad4b`). The financial function remains at the captured definition. Natural cron completion and measured production read cost remain separate acceptance evidence.
