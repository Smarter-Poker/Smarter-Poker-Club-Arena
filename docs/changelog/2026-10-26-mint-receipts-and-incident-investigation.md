# Mint receipts and incident investigation

The 13:20 UTC Money Check Failed notification counted three completed operator
Mint issuances of 620,000 chips each as unexplained mint velocity. Their journal
keys are `mint:<operation>`, while the detector recognized only the older
fund-club door's equal keys and function label. The Mint records the operator's
display name. The detector now verifies its completed operation receipt, exact
journal link, amount, asset, destination, holder, actor, reason and balances.
The three-operation limit remains: a fourth counts all declared mints again.
Unfinished, mismatched and automatically registered journal receipts count.
No money is moved by this change.

Successful explicit financial incident actions now update the corresponding
routed inbox investigation in the same transaction. Previously acknowledgement
could succeed while the alert remained new with no investigation timestamp.
Unrelated alerts and terminal investigation states remain intact. Bell reads
do not imply investigation. The existing silence warning stays enabled; this
change does not provide unattended incident investigation.

The isolated PostgreSQL regression loads captured production functions,
reproduces both defects before applying the exact migration, then covers valid
and malformed receipts, repeated mint volume, authorization, failed/unknown
actions, persistence failure rollback, unrelated records and terminal states.
The existing informational-alert workflow runs it on migration changes.
