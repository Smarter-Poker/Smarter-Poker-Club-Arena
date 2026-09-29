# A retained break source is not a seat move (2026-09-25)

## What production said

Release `778075b4`, instance `1-1bcee94e`, twenty-five minutes of engine log:

```
13326  Error: Tournament table <uuid> retained time-bank custody
 5678  Error: Tournament <uuid> retained an unresolved seat-move UUID
```

Every one of the 8,667 `AggregateError: Tournament <id> failed to stop N table
engine(s)` carried a block of time-bank errors and, for thirteen of the twenty
quarantined tournaments, exactly one seat-move error. `/health` reported
`tournamentManagersQuarantined: 20`, `claimErrors: 1504`,
`breaksSinceRestartCertified: 12`, `readyForRestart: false`.

## There was no seat move

`pendingTournamentSeatMoveOutcomes` gains an entry in exactly one place —
`executePlayerMovesOwned`, on `TournamentSeatMoveOutcomeUnknownError`, which
always reports `Tournament.atomic_move_refused_or_unknown` first. Over the whole
retained container log (2026-09-25 20:55:33Z onward; the container started
15:41:24Z and json-file rotation has dropped the earlier hours):

```
atomic_move_refused_or_unknown          0
atomic_move_quarantine_unresolved       0
atomic_move_outcome_still_unknown       0
atomic_move_replay_boundary_unavailable 0
atomic_move_receipt_only_unresolved     0
f06_mixed*                              0      (no custody transfer loaded a pending vector)
"Atomic move"                           3      (three certified moves, all of them)
```

Not one ambiguous UUID was created, and not one replay was attempted or
refused, across 5,678 refusals of the certificate. The errors named a UUID that
did not exist.

The database says the same thing, and says which clause it was instead. The
thirteen tournaments that log the seat-move error and the five quarantined
tournaments that do not split perfectly on `smarter_private.f06_operations`:

```
 13 seat-move tournaments : 109 F06 break operations, every one of them >= 1,
                            68 still park_requested / begun / close_confirmed
  5 other quarantined     :   0 F06 break operations, all five
```

`retainedTournamentBreakSources` is populated in exactly two places, both inside
F06 break preparation (`prepareParkedTournamentBreak`,
`dispatchTournamentBreakMembers`, plus the stopped-original path in
`retireTournamentBreak`). A quarantined manager with no break has nothing to put
in it and does not raise the error; a quarantined manager with an unfinished
break raises it on every attempt. Meanwhile the move machinery itself is
healthy: 365 rows landed in `public.tournament_seat_move_receipts` in the
preceding eight hours, the most recent minutes before this was written.

No player and no chips are stranded in transit. `humansSeatedTotal` is 0 across
the platform, and every unfinished break attempt is a durable
`smarter_private.f06_attempts` row (56 `active`, 36 `winner` with receipts, 1
`fenced`) carrying its own immutable `request_id` for the successor to
re-dispatch — not an in-memory UUID that only this process knows about.

## The clause that actually refused

`resolveTournamentSeatMoveQuarantine(null, null)` is the manager-SHUTDOWN
certificate. With the pending set empty it can still answer false from two
places, neither of which logs anything:

```ts
if (this.pendingTournamentSeatMoveOutcomes.size > 0) return false;
if (this.retainedTournamentBreakSources.size > 0) return false;   // #4799, 2026-09-17
for (const sourceEngine of this.tableEngines.values()) { ... }
```

`TournamentManagerBase.stop()` turned that bare false into
`retained an unresolved seat-move UUID` regardless of which one it was.

The second line is the defect. In the RECOVERY branch of the same method its
sibling — `retainsTournamentBreakSource(tableId, engine)` — is correct and is
unchanged here: that branch is asked whether one named engine may be released
while the manager lives, and a manager still fencing that engine for a break
must say no.

The shutdown branch is a different question, asked once, about the whole
generation — and **nothing on that path can clear the map**.
`retainedTournamentBreakSources` is cleared only when a durable break reaches
`acknowledged` (`retireTournamentBreak`, `finishAcknowledgedTournamentBreak`) or
by `forgetContinuedNoStartPark`, and none of those run while a fenced manager is
being stopped. A manager that was fencing one break source when it lost its
lease could therefore never stop again for the life of the process. It is the
shape the maintenance-break bound was written against: _"a fail-closed gate with
no bound, on a resource the whole platform shares, trades 'breaks get
dismantled' for 'a stuck table never recovers', and the second is the worse
bug."_

## Nothing is discarded by letting it go

`retainTournamentBreakSource` says what it is in its own declaration: _"Local
custody only; durable discovery and completion belong to the break RPC."_ The
break row, its members and their immutable `active_request_id`s are durable; a
successor re-discovers the break and re-dispatches the same request identities.
The single obligation that lives only in this process is an ambiguous move UUID,
and that is fenced by the guard above, replayed through
`requestTournamentSeatMoveAtBoundary` to a receipt, and forgotten only after the
receipt returns. **No move is discarded on any path.**

What was genuinely unsafe is kept: a retained source whose engine is still in
this manager's registry and has _not_ released process ownership is a dealer
this teardown has not joined, and it still refuses — by name.

## The changes

1. **`TournamentManager.resolveTournamentSeatMoveQuarantine`** — every guard
   names itself before it is tested (`shutdown:unresolved_seat_move_uuid`,
   `shutdown:break_source_owns_running_engine`, `shutdown:claimed_move_boundary`,
   `recovery:break_source_retained`, `…:replay_unresolved`, …). Same conditions,
   same order, same booleans, except the one below.
2. **The blanket `retainedTournamentBreakSources.size > 0` refusal is replaced**
   in the shutdown branch by the precise condition: refuse only while a retained
   source's engine is still registered here _and_ has not released process
   ownership. The map itself is not mutated — `captureDrainedF06Custody` still
   reads it on the failed-stop fallback.
3. **`TournamentManagerBase`** — `noteSeatMoveQuarantineRefusal()` /
   `seatMoveQuarantineRefusal()` beside the `drainedF06OriginalsRefusals` map
   added by #5257, and `stop()` reports the named clause:
   `Tournament <id> refused its seat-move release certificate: <clause>`, or
   `refusal_unnamed` when a refusal named none.

## What this does and does not unblock

This is engine source. The running `778075b4` cannot benefit from it before a
deploy, and **no operator or DB-level disposition can clear the existing
refusals**: `retainedTournamentBreakSources` is in-process memory with no
durable row behind it. There is nothing durable stranded — a restart clears
every one of them.

The restart gate itself is not held by this defect. `unparkedReasons` is
`{stopped_bank_custody_unconfirmed: 154, f06_preparation_stuck: 13}`, and
`f06_preparation_stuck` is past the #4909/#5251 bound and no longer vetoes the
gate, so the 154 time-bank tables are what `readyForRestart: false` is counting.
What this defect holds shut is the manager quarantine loop: thirteen of the
twenty quarantined managers cannot complete `stop()` even once their engines
stop cleanly.
