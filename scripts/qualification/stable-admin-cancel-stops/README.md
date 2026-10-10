This disposable PostgreSQL17 fixture exercises the new operator owner over the
current real chip and Diamond cancellation/refund bodies. Catalog definitions
and affected column/check/key shapes were captured read-only from the configured
database on October10,2026; no user records were captured. Opening liabilities
are explicit synthetic historical inputs, so the fixture does not certify their
original registration/issuance. Exact original ledger writer/enricher and one-use
refund tranche/escrow triggers produce and prove chip settlement. Diamond custody
release uses the exact original release and wallet-credit owners. Other product
triggers and external reporting consumers are outside this isolated fixture.

Run `TMPDIR=<owned scratch> node scripts/qualify-stable-admin-cancel-stops-pg17.mjs`
from the repository. PostgreSQL17 binaries and locked `pg` dependency are required.
`STABLE_CANCEL_POSTGRES_BIN` may select the platform's PostgreSQL17 binary folder.
The runner creates its own private loopback cluster, tests two real sessions and
destroys only that cluster. It never accepts a production database connection.

The provisional PGlite runner requires `PGLITE_MODULE` pointing at an existing
owned installation and loads its actual pgcrypto extension. Its sequential
assertions cannot substitute for the required native concurrent checks. A native
initdb failure on Mac due to occupied SysV shared-memory IDs is a failed execution
prerequisite, never a passing concurrency verdict; no other cluster is removed.

Refund tests run in an outer rollback and independently assert wallet/custody,
tranche counts, terminal receipt, approval decisions and duplicate disposition.
Native races additionally prove the stop waits for previously admitted work,
later work waits for the stop and observes it, and two cancellation sessions
create one refund and replay the same immutable receipt. All concurrent commits
remain inside the disposable owned cluster.

The stop qualification invokes the real cashier request, approval, execute and
release owners. Actual ledger/receipt/invoice/delivery owners establish the hold
and prove cancellation/decline refunds remain permitted while new holds,
approval and execution roll back under the stop. All eight patched non-Arena
refund owners run against synthetic original-debit receipts, including both
chip and Diamond shop rails. The recovery candidate in rollback.sql checks
exact function postimages before restoring original owners in a savepoint.
The native runner resolves pg from the canonical server dependency installation.

PvP settlement classification is finite: scored win and stale forfeit draw
18 from two original 10-Diamond stakes; scored ties return both stakes; stale
refund returns each proved charged stake (one or two); void pays nothing.
Winner provenance proves both debits and bounds cumulative claims by the whole
original pot, retaining the original owner’s rake and exact payment/replay rules.
