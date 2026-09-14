# An empty table retains its unfinished close

After a table break moves the complete source roster, an unavailable close
response leaves the stopped engine registered until the database proves the
close. The next balancing pass used to rebuild its candidates exclusively from
tables with live seats. That deliberately excludes the empty source, including
a source whose close committed before its reply was lost. With zero or one
occupied tables the pass returned before ever reaching retirement. Scheduling
another pass alone could not complete this operation.

The manager now retains one pending retirement: table ID, exact engine object
and original moved-player count. The existing shared scheduler retries that
operation before the occupied-table read or any new balancing plan. It makes
one attempt per pass and keeps its coalesced five-second wake while unfinished.
The wake is armed before stop or the close request, including a thrown transport
error. Ambiguous seat moves must resolve first. Empty-table retirement still
requires physical engine stop, current manager authority, an exact durable
database receipt and the existing global engine identity check. Only then are
the local/global/hub/hand-for-hand registries released and the pending operation
cleared. The retry broadcasts the original moved-player count after success.

The occupied-table reader is unchanged, so singleton tables without engines
remain visible to ordinary consolidation. No timer, fleet sweep, forced close,
chip mutation, migration or deployment-control change is introduced.

Four new regression cases failed before the change: an empty source still
running or already closed, each with zero or one occupied tables. All failed
because the second close was never attempted. They pass after the change. The
runtime tests also enter through the actual balancer and occupied-table reader,
move a two-player source roster once through a simulated committed move result,
lose the close response and finish only the close on the next balancing pass.
The database transport and physical stop are controlled fixtures; this is not
a native database concurrency test or production recovery receipt.

Further cases cover repeated unavailability, a thrown transport error, invalid
or nonempty receipts, stopped manager authority, changed engine generation,
physical-stop quarantine, ambiguous seat-move precedence and authority lost
during the close request. Compilation and all 60 focused retirement, movement,
capacity and ownership checks passed. The complete server suite passed 11,290
tests in 767 files, with 145 existing skipped tests and one skipped file.
Protected publication results are recorded separately; a local pass does not
certify a live release.

This repair followed a read-only investigation of a naturally stalled tournament
table. Its historical recovery event and current runtime/database discrepancy
do not prove that this defect caused that particular stall. The change retains
future unfinished closes within the owning manager generation; it does not
manufacture a pending operation for an already-stalled production object or
infer a winner, payout, chip balance or recovery from stale telemetry.
