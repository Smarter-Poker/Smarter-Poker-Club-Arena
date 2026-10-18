# Player Stats Read The Funded Club

JAQK and SHARK players' retained hand facts name the shared Midway table
host. Scoped Stats, comparisons, shared-player views and hand evidence filtered
that physical host as though it were the player's funding club. Completed union
tournament results likewise filtered the event host instead of the entrant.

Historical funding witnesses now scope these readers using dated
buy-in receipts, the tournament entrant and rake witnesses. Tournament results
use the entrant's recorded club, with the original host as the fallback for old
unattributed entries. Self, shared-membership, asset and active-club checks,
existing ACLs, source facts and monetary records remain unchanged.

The required Stats club-scope PostgreSQL fixture reproduces loss of cash hands
and tournament results before the patch, then compares all tab/evidence readers
and club comparisons to an independently captured baseline. It covers a future
funding receipt, shared Stats, refusals, internal-helper ACLs, source preservation
and migration replay refusal. This is a database-only reporting change; it does
not require engine activation. Installation and affected live reads are separate
delivery evidence.

The first broad query plan took50.93s on a measured89k-hand history. Joined
witness reads, selective columns and one shared overview basis reduced the
actual overview query to13.76s. Only the four full-history aggregate readers
receive a20s function-level transaction budget and heap-ordered bitmap reads;
the role-wide8s limit and keyset/detail readers retain their existing budgets.
