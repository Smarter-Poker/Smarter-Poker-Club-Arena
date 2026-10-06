# 2026-10-04 Timeout and reconnect audit: engine

Four defects in how the engine keeps time for an absent or stalling player,
each fixed where it was produced. Engine change: activates in a :55 window.

## Presence does not outlive the seat

The presence FSM (`DisconnectEngine`) mirrors the seats of one table. Two
paths left entries standing for players who no longer sat there:

- a tournament seat closes in the database (balancing move, elimination) and
  the engine runs no leave path for it, so nothing ever unregistered it;
- a restart restored every entry in `engine_presence_parked` without asking
  whether its player was still seated, and the next hourly park wrote it back.

Production, 2026-10-04, parks of the last two hours: 2,849 entries, every one
a horse (no human was seated at those parks). 432 were DISCONNECTED and 41
MISSING. The engine heartbeats every seated horse each ten seconds, so a
horse in either state is an entry for a seat the engine no longer held: 473
stale entries, the oldest 41 hours old. Two more were SAT_OUT with a sit-out
stamp 17 and 30 hours old and no open seat.

A stale entry is broadcast in every snapshot (`disconnect_states`), announces
PLAYER_DISCONNECTED thirty seconds after its player left, and is inherited
whole by a player who returns to the same table: a sit-out they are not in,
strikes from an earlier stay, an expired reconnect allowance.

`adoptSeatRoster` now calls `DisconnectEngine.retainOnly` with every
authoritative roster. It forgets a mirror entry only; no seat row is read or
written and the tournament seat-exit authority is untouched.

## A manual time bank that runs out is a timeout

The automatic bank's expiry has counted a strike since 2026-08-21. The manual
one did not, and it is the common path: the browser posts `/timebank` itself
when its ring reaches zero, two seconds before the engine's own deadline. A
player with the app open and a bank left therefore never accumulated a strike,
was never sat out, and cost the table a full clock and a full bank every hand.
The manual expiry now calls `recordConnectedTimeout`.

## A refused action does not buy a new clock

The action path cancels the turn clock before applying the action. When the
hand controller refused it (`performAction` returned false), the seat was
re-armed through the turn-change path: the table's whole action time again and
normal bank eligibility. A `raise` from a seat that may not reopen the betting
passes the validator and is refused by the controller, so repeating it held
the turn for as long as the sender liked. The clock that was running is now
the clock that comes back (`restoreTurnClockAfterRejectedAction`): same
published deadline, same enforcement grace, same bank state.

## The break does not burn an absence clock

CLAUDE.md 13 rule 4. Cash seats are released five minutes after a sit-out and
five minutes after the engine concludes nobody is behind the seat. Both were
judged on engine-memory stamps the freeze never moved (`sitOutSince`,
`disconnectedAt`, `pageLeftAt`); the park restored them unmoved, and a
restored sit-out never re-reads the `sit_out_at` that `fn_thaw_platform` had
shifted. A player who sat out or dropped a minute before :55 was stood up on
the first sweep after the thaw. `thawTablePresenceClock` gives the frozen
interval back once, on the same completed-freeze record the reconnect
allowance already uses, and `presenceThawedAtMs` travels with the FSM entry so
a restore before or after the thaw credits it once.

No new database deadline is introduced, so `fn_thaw_platform` is unchanged.

## Tests

- `server/src/engine/PresenceDoesNotOutliveTheSeat.test.ts`
- `server/src/engine/ARefusedActionDoesNotBuyANewClock.test.ts`
- `server/src/maintenance/theBreakDoesNotBurnAbsenceClocks.test.ts`
- `server/src/engine/RecoveredTurnClockState.test.ts` (two cases added)
- `server/src/engine/PendingAddOnIdleSweep.test.ts` (fixture gains the stub)

Each new case was run against the unfixed source and failed there.

## Not verified

No engine was deployed and no production table was touched. The roster prune
has not been observed against a live tournament; the claim that returning
players inherit stale state is read from the code and from the parked rows,
not reproduced on production.
