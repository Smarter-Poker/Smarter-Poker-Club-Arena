# server/src/engine/AHaltedTableFinishesItsHandAndDealsNoOther.law.test.ts

A halted table finishes its hand and deals no other (Lightning 2.0 Phase 5, 2026-09-21).
`tables.dealing_halted_at IS NOT NULL` means FINISH THE HAND YOU ARE IN AND START NO
OTHER, and it means nothing else: it never closes a table, never drops an engine, never
unseats anybody and never moves a chip. The gate therefore sits at the TOP of the dealing
loop's iteration and ABOVE everything that changes a seat - above the sit-out eviction
that cashes a player out, above `announcePendingSeatMoves`, above `dealHand` - and its one
writer, `applyDealingHaltFromRow`, touches no seat, no stack and no other table.
`stopIfClusterTableClosed` remains the only member that may end an engine over Cluster
state, and it still demands a closed row AND an empty table. The hand in the air is never
killed: the loop cannot come back around to the gate until `dealHand()` has resolved and
the settlement barrier has drained, so "already-started hands resolve normally" is the
POSITION of this one check rather than a second check bolted on beside it. It is a POLLED
lock, in the `adminPauseLock` / `maintenanceLock` family, and never a pause-gate owner -
the writer is a database transaction that has committed and gone home, so nothing in this
process will ever call `releasePauseGate` for it; `awaitPauseGate` would return at once
for a non-owner and the branch would go round again, which is why all three polled locks
are excluded from that call together. The authority is the ROW, not the object: `start()`
reads it, so an engine reaped by the zombie sweep and rebuilt within five seconds comes
back halted, and `refreshRakeConfig`'s RAKE_CONFIG_TTL_MS re-read carries the column on
the request that already runs every hand, so the halt costs the hand in progress plus AT
MOST 60 SECONDS and a read that fails leaves a halted table halted rather than resuming a
converting Cluster on a database blip. Clearing the column resumes dealing on the same
engine object with no restart, inside that same 60 seconds - acceptance F04, "conversion
canceled, state returns to MUST_MOVE, regular tables resume".
