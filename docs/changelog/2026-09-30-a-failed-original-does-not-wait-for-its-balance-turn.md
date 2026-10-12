# A failed original resolves its own retained preparation

On September 30, Table36 of tournament `59bf87e1-bbc9-4e7b-9288-4ed940354829`
stopped at 12:14:22 UTC with an unknown BEGIN and a healthy parent lease. Its
restart event joined teardown, then the retained-permit quarantine correctly
refused replacement. The owning original no-start path was reached only by
the balance pass, which selected one of 39 tables per turn. At 12:26:43 UTC
that existing path obtained custody and later retired the table with an
acknowledged movement/close receipt. The table was delayed, not permanently
orphaned. This change does not claim to identify the initial BEGIN transport
error.

The exact table's restart event now calls that same original admission owner
before asking whether replacement is safe. The ordinary balance pass remains
unchanged in scope, and concurrent callers join one in-flight disposition per
original engine. Existing lease, lifecycle, registry, no-start evidence,
movement and durable receipt checks remain authoritative. A last-table
continuation lets its already-running exact recovery finish readmission,
avoiding a self-join. No new polling, retry, scheduler expansion, database
contract, bank default or custody-release exemption is introduced.

Regression coverage extends `F06OriginalManagerFlow.test.ts`: the actual
restart callback reaches the failed table without advancing a 39-table
cursor; a concurrent balance caller shares its disposition; unknown receipts,
ownership loss and possibly attempted hands retain the original; and both
balance and restart entry points continue a last table only after the existing
positive receipt. The pre-change recovery regression failed with no
acknowledged disposition. The maintained original-flow and recovery-contract
checks pass after the fix. Production publication and behavior proof remain
separate from this source qualification.
