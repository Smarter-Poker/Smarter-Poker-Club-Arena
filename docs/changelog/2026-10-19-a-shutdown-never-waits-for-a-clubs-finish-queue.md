# A shutdown never waits for a club's finish queue (2026-10-19)

## What went wrong

From 16:55 to 20:55 UTC every engine release reached its break and rolled back. The outgoing
engine (1370116c) passed its 40-second graceful-shutdown deadline, exited without releasing its
leases, and the candidate then also waited for the stale leader lease. The cutover ran out of
proof time each hour. At 21:55 the same engine stopped in about 15 seconds and 1cc08eb3 sealed.

The difference was the board. From 15:43 to 21:42 the close of 992 decided events refused with
`accounting_terms_not_observed` (the direct-owner fee incident; repaired by #7458 at 19:07 and
migration `20261019180622`, installed at 21:42:21). All 992 belong to one club,
`fade0000-0000-0000-0000-000000000001`. Read-only measurements:

- 1,141 capture proofs were written from 21:42:21 to 21:53:56, and ~990 of the held events
  completed in those eleven minutes.
- Completions fell from 700-880 an hour to 84-221 an hour between 16:00 and 20:59.
- Tables resumed after each break rose from 300-500 to 984-1,318.

## The slow step, named from the code

`withTerminalFinishLane` sends one finish per club at a time from this process. Every decided
event's elimination sweep was a finish queued in that one club's lane. Each refused finish held
the club's F lock for seconds (2-12 s measured 2026-10-03). Each request made up to five attempts,
and every attempt went back to the tail of the lane.

`TournamentManager.stop()` first joins its in-flight elimination sweeps
(`drainEliminationSchedulerJobs`), and `GameServer.performStop` awaits every manager's stop. So
shutdown waited for the whole queue to drain: its length times one finish, which grows with the
size of the board.

## What changed

1. **`closeTerminalFinishLanes()`**, called synchronously by `GameServer.stop()` before its first
   await.
   - A finish still waiting for its lane turn is never sent. It is refused with
     `TerminalSettlementNotSentError`, a `TerminalSettlementRefusedError`.
   - A request stops before its next attempt.
   - If every attempt it did send was answered by the database with a rollback, it is refused
     without the resolver.
   - An attempt whose outcome the database did not state still goes to the resolver, exactly as
     before.
   - A finish already in the database is never abandoned.
   - Shutdown therefore waits for at most one finish per club. `GameServer.start()` reopens the
     lanes.
2. **The manager treats a not-sent finish as nothing happening.**
   - An ordinary finish releases its finish guard, with no refusal count and no critical alert.
   - A final-table deal does not close the players' deal review. Their consent stands for the
     next engine.
3. **The discovery pass's COMPLETING recovery loop stops at the shutdown fence**, as every other
   per-event loop in that pass already did.
4. **Every shutdown step logs its own time** (`[GameServer] shutdown step <name> took Nms`).
   - Any owned service stop over one second logs its name.
   - The manager-stop step names its three slowest managers.
   - The next overrun names its step instead of only "graceful shutdown exceeded 40000ms".

## What did not change

- The 40-second deadline is unchanged.
- The hand drain, the between-hands park and the lease generations are unchanged.
- The order of lease release, with leadership released last, is unchanged.
- On a failed stop, leadership is still kept. Releasing it early to save the candidate's
  30-second lease wait would reopen the split-brain window that ordering exists to close. The fix
  instead makes the orderly release reachable inside the deadline.

## When it helps

The fix runs in the OUTGOING engine. It first protects the cutover after the release that ships
it: if this ships at the next :55 break, the break an hour later is the first one it covers.

Test: `server/src/tournament/aShutdownNeverWaitsForAClubsFinishQueue.test.ts` queues 300 refused
finishes of one club.

- With the lanes open, at most 21 are sent in 40 s.
- After shutdown, all 300 settle within the one finish already in flight. One is sent, none goes
  to the resolver, and none is reported as an unknown outcome.
- On today's code the queue never drains.
