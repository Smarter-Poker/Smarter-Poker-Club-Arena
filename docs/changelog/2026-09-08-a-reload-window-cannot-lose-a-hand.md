# A Schema-Cache Reload Cannot Lose A Hand

## What Happened

Two migration windows exposed the same mismatch in the hand persistence
budget. PostgREST schema-cache reloads take about 28 seconds on this database,
but the stack writer exhausted five attempts after about 11.5 seconds. Eighteen
hand stack writes were reported without a database settlement receipt. The
captured payloads represented 155,335 chips of seat movement across 111 seat
rows.

The proposed upstream response moved those writes into a timer-owned pending
queue and let play continue. That is not an acceptable settlement boundary. A
later hand or a replacement engine could then run while the prior hand existed
only in process memory, and the queue itself was a watcher prohibited by the
no-band-aids rule.

## Root Repair

`syncStacks` now builds one immutable RPC payload for the hand and keeps that
same payload inside the original awaited settlement promise. It makes at most
13 calls with 41 seconds of scheduled delay. Even if every call consumes its
full 15-second database deadline, the total remains below the existing
five-minute gameplay settlement barrier.

The promise has exactly three outcomes:

- A complete authoritative receipt returns success.
- A definitive database refusal returns failure and writes no fallback.
- An unreachable or incomplete result remains unconfirmed through the entire
  bounded persistence window, raises a critical financial incident with the
  exact payload, and prevents the engine from treating that hand as durable.

For tournament hands, a generic `success: true` is insufficient. The receipt
must bind the tournament identity, every expected user, every written target,
and the exact mirrored `tournament_players` chip rows. The engine latches a
missing proof and terminates only after the same awaited promise finishes. A
replacement engine can never silently take ownership of the old payload.

The next-hand cadence work remains intact. Roster preparation, hand-number
allocation, settlement lanes, and the visible rest overlap when the database is
healthy. Only an unconfirmed money write holds the table, which is the required
failure mode when the alternative is dealing from stacks the database does not
have.

## Removed Band-Aid

The merge does not ship `pendingWrites.ts`, `enqueuePendingWrite`,
`drainPendingWrites`, or a pending-write timer. The stack path also has no
per-seat fallback, `syncTournamentChips`, or table-seat count reconciler.

Fee queue insertion remains a separately registered Tier 1 accounting item.
This change keeps the useful tri-state evidence check so an unreadable database
is never described as proof that chips are missing, but it does not create a
background retry path or claim that the fee atomicity item is closed.

## Verification

`tests/a-reload-window-cannot-lose-a-hand.law.test.ts` pins the measured-window
budget, the five-minute upper bound, single-payload identity, absence of every
off-path owner, and visibility of the raw promise to process drain and terminal
closeout. Engine behavior tests additionally require exact tournament receipt
proof and reject mismatched written stacks or standings.

The historical hand-damage migrations already on main used the platform's own
idempotent hand authority. They are preserved unchanged; this release changes
the live cause so a new hand cannot enter that recovery state.
