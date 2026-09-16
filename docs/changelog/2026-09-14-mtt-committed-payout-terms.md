# Tournament recovery preserves committed payout terms

Played tournaments can remain REGISTERING after a lost launch completion. On
recovery, the existing overlay trigger fitted their payout ladder to today's
field even when the pool was already finalized and prizes paid. Entry closure
independently recalculated the ladder when an older event lacked its newer
closure receipt. The paid-prize safeguard then correctly refused the changed
amounts, leaving completion pending.

Both existing database authorities now consult one private committed-terms
predicate. Finalized pools and prepared/paid settlement evidence preserve the
stored ladder; inconsistent commitments with no finalized pool refuse before
mutation. First-time uncommitted events retain their final-field generation and
overlay transaction. Spin aliases retain wheel terms. Existing closure receipt
replay and payment guards stay in place. No historical event, rank, receipt,
obligation, payout or wallet is changed by the migration.

Private PG17 rehearsal passes 57 groups, including both original counterexamples,
the real launch trigger, unchanged entry acceptance and versioned amount math,
four concurrent closers, waited-for financial commitments, rollback, source
drift and private role denial. Guarantee/alert/maintenance stand-ins delimit
provider scope. The related engine suite passes 82 tests across five files;
app TypeScript passes. Installed history 20260914144117 and all three exact
function bodies/security contracts were read back at 14:41:34 UTC. Protected CI,
full production journey and historical reconciliation remain open.
