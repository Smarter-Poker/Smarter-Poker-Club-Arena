# Accepted hand roster mirrors keep their shared tournament lane

The twelve-argument hand settlement RPC acquires a shared tournament lane.
Its inner financial writer mirrors chips, table_id, and seat_number into the
playing roster, including when the latter two values are unchanged. PostgreSQL
fires the existing column-filtered F06 roster trigger for that UPDATE. The guard
then requested the same lane exclusively before checking whether custody changed.
Another table's accepted hand could therefore cause all three existing retries
to fail with F06_RETRY_CANONICAL_LANE even with no active F06 break.

The guard now takes shared global/tournament lanes for updates that preserve
the actual OLD and NEW occupant, table, seat, and custody status. Canonical
movement, admission, deletion, and vacating still use the original exclusive
lane and receipt checks. A NULL new seat occupant is a custody change; the old
COALESCE comparison mistakenly treated it as the old occupant even for a bound
source. No money, hand, lease, permit, or player state is backfilled.

The migration refuses unexpected predecessor definitions, helper definitions,
trigger bindings, or execution grants. It preserves the security-definer owner,
search path, trigger bindings, and closed browser execution permissions.

Validation: 44 native PostgreSQL 17 checks cover the original three-retry
failure, both actual column-filtered trigger bindings, NULL identity, exclusive
global/tournament owners, structural writes, bound receipt denial, canonical
receipted movement, rollback, installer drift, and installer replay. The same
runner is part of the required accounting CI job.

Additional private full-schema qualification uses a copy-on-write clone of a
cold PostgreSQL 17 fixture. Its 32 F06 and hand-settlement function definitions
and execution grants were aligned with the live September 13 snapshot before
running the unchanged native custody and accepted-hand probes. The actual
twelve-argument financial RPC refuses the baseline concurrent shared holder
with SQLSTATE 40001, then accepts the candidate hand and its replay while that
holder remains active. Hand receipts, time-bank obligations, unchanged chip
totals, rollback, permit fencing, move/cleanup, and delayed-completion checks
pass. The source fixture stays cold and unchanged and each private clone is
removed. This does not attribute every historical rebuild to one lock holder
or establish that all financial and horse incidents are repaired.
