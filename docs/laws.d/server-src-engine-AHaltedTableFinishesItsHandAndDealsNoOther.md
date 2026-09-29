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

REMEDIATION, 2026-09-25 - IT IS NOT ONLY THE DEALING LOOP. A table below
`minPlayersToDeal()` lives in `start()`'s wait-for-players loop, which reached no gate and
re-read no row, and which goes on running `evictExpiredSitOuts` (that one stands a player
up and CASHES THEM OUT), `executeIdleSeatMoves`, `processPendingAddOns` and
`restoreEntryHoldsFromSeats`. A feeder that went quiet before a halt was raised therefore
had no worst case at all: it emptied a seat in the middle of a transition whose law is
that it unseats nobody. That loop now takes the SAME throttled `refreshRakeConfig` re-read

- cash tables with a `cluster_id` only, so a quiet TOURNAMENT table makes no extra request
  and `theQuietTournamentTableBacksOff` is untouched - and then the same POLLED gate, which
  is why gating it no longer wedges it: it can watch the flag lift. Worst case is now 60
  seconds for a quiet table exactly as for a dealing one. `isPausedByDesign()` names the
  halt too, so a table halted while its FSM still says `waiting` reads as parked on purpose
  to the zombie reaper, the drain and the turn watchdog; `pausedSinceMs` is deliberately not
  stamped for a polled lock, so `MAX_HEALTHY_PAUSE_MS` cannot condemn a long conversion, and
  the mid-hand branch of `isParkedByDesign()` still excludes the halt so a frozen hand is
  worked and reaped as usual. The dealing loop's `'running' -> 'paused'` transition now has
  its matching edge back to `'running'`, guarded by `isNextHandPaused()`: nothing else ever
  wrote it, so a table that had resumed dealing went on telling every reader it was parked
  for the life of the process.

AND ONE THING ABOVE THE GATE IS NOT A READ, WHICH IS JUDGED RATHER THAN MISSED:
`prepareNextHand`'s `leave_pending` sweep, which writes `table_seats.left_at` and cashes a
seat out. It stays above the gate. The halt stops what the ENGINE decides to do to a seat;
it does not stop what the PLAYER asked for. Every population query the conversion asks -
`fn_cash_cluster_live_eligible`, the commit's re-ask, the pool-session INSERT, the
stranded-player check - carries `coalesce(ts.leave_pending, false) = false`, so the seat
left the counted set when POST /leave wrote the flag, outside this engine; turning
`leave_pending` into `left_at` cannot move the number the commit re-asks and so cannot be
what sends a conversion back to MUST_MOVE, and the chip-total assertion takes both of its
sums inside the commit's own transaction over `left_at IS NULL` seats. Refusing it would
strand a departed player's money at a table for an unbounded conversion to protect a
number that cannot change. The sit-out eviction below the gate is the opposite case and is
stopped: that player asked for nothing. The per-player teardown sits below the gate too,
so a halt defers it to the first pass after the lift rather than losing it, and no second
sweep can start while the first is un-taken.

REMEDIATION, 2026-09-25 (second pass) - THE TABLE ACKNOWLEDGES, HEARS FAST, AND STAYS HEALTHY
WHILE PARKED. The conversion commit now refuses until every leased member table has
ACKNOWLEDGED its halt, so a table parked at either halt gate with no hand in progress calls
`fn_cash_table_observe_dealing_halt(p_table_id)` once per distinct `dealing_halted_at` value
(`observeDealingHalt`), calls it again when the value changes (an abort followed by a new
begin), forgets the acknowledgement when the column clears, and treats every failure -
PGRST202 while the migration is not yet live included - as "retry on the next parked pass",
logged at most once a minute and never a reason to deal. Once acknowledged the table leaves
the gate only on a read showing the column cleared, which is what makes the answer true. A
cash table with a `cluster_id` also re-reads the two halt columns alone on
`DEALING_HALT_TTL_MS` (5s) through `refreshDealingHalt` - one select, primary key, the same
single writer - inside the prepared-hand inputs (once per hand, in parallel with the roster,
honoured by the `isNextHandPaused()` check after the rest with no second read there, so the
two-second rest law is untouched), and on every parked or quiet pass; every other table
keeps only the 60-second rule re-read, so the halt costs a dealing Cluster table the hand in
progress plus at most five seconds. Both halt branches now run `passWhileDealingHalted`, which
reaches `stopIfClusterTableClosed` (an EMPTY table on a closed row ends its engine; a seated
one never does), the dealing branch resets `consecutiveErrors` after each completed parked pass
so a long conversion cannot age a table into `dealing_loop_10_consecutive_errors`, and
`releasePauseGate` relabels a paused table `running` only when `isNextHandPaused()` names no
owner, so a maintenance break lifting over a halted table leaves it `paused`. The `leave_pending`
sweep above the gate is no longer one-per-halt: the database refuses a seat change for a player
in a live Lightning hand with LIGHTNING_HAND_IN_PROGRESS, `leaveTable` answers that by writing
the durable `leave_pending` request and telling the client the leave is queued, and a halted
table re-arms the sweep on every pass while its roster shows a leaver (the halt branch takes
the prepared sweep and releases the departed seats), while a quiet table runs
`sweepQueuedLeaves` above its own gate. A deferred seat is never reported as departed, and
every retry is the same occupancy-keyed one-transaction cash-out, so the leave is neither
dropped nor paid twice.

VERIFIER FIXES, 2026-09-26. Every read that carries the halt columns (`start()`'s loadTable,
the rule re-read, the halt poll) takes a number from `beginDealingHaltRead()` before it is
sent; `applyDealingHaltFromRow` ignores an answer older than one already applied, and a read
sent before the acknowledgement can never release the halt it acknowledged, so a step budget
abandoning a slow rule read cannot let a late, pre-halt answer lift an acknowledged halt. The
5-second poll is earned: it runs only while the table is halted or its Cluster has
`lightning_enabled` (read in the same select through `cash_games!cluster_id`); any other
Cluster table polls once a minute. The every-pass leave retry covers only seats deferred by
LIGHTNING_HAND_IN_PROGRESS (tracked in memory, found after a restart by one probe per halt or
engine start); a leave the stay clock holds keeps its own release.
