# The lease renewal loop is supervised, and a predecessor finishes its own envelope

**2026-09-12.** Two fixes for one live outage: the loop that renews every lease
in the engine process stopped and nothing restarted it, and the alarm that fired
414 times while it was down was describing work no engine had attempted.

## What was happening

`heartbeat_table_leases_v4` frozen at exactly 27,886 calls while
`claim_table_lease_v2` kept climbing. 73 of 76 live leases with
`heartbeat_at = acquired_at`. Every table's 20-second lease proof expiring, the
engine self-killing, rebuilding, claiming a lease nothing renewed, and dying 20
seconds later - 14,141 kills in the last hour, hand volume down 61%.

Earlier work the same day closed the two SILENT exits of
`runOwnershipLeaseRenewalLoop`: a pass that never settles is abandoned on a
timer, and `poker_lease_renewal_passes_total` makes the absence of passes a rate
rather than a silence. Both were right and neither was enough, because
`launchServerLifecycleJob` reports what a job throws and then forgets it. The
loop's exit was no longer silent. It was still permanent.

## Fix B - the loop is supervised

`GameServer.superviseOwnershipLeaseRenewal(generation)` now wraps the loop and is
what `performStart` launches. It relaunches whenever the loop throws or returns
while the admission generation is still current, sleeping one renewal cadence
between attempts so a loop that throws on entry cannot become a hot spin. The
generation check is the same fence the loop itself uses, so a stopped or
superseded server ends the supervisor instead of resurrecting a dead
generation's renewals, and `renewOwnedEngineLeaseProofs` still serialises passes
on `ownershipLeaseRenewalOperation`, so a relaunch cannot double-renew.

**A relaunch is an event, not a log detail.** Supervision on its own would have
hidden the very fault it cures: passes keep completing across a relaunch, and
`poker_lease_renewal_loop_running` is back at 1 within a tick, so nothing any
dashboard samples would ever have shown that the loop died.
`poker_lease_renewal_loop_relaunches_total` is that fault. Zero is the normal
reading for the life of a process; any movement means the loop left while its
generation was live, and
`GameServer.ownership_lease_renewal_loop_left_early` in Sentry carries the
reason. No alert rule reads it yet, deliberately - CLAUDE.md 10.84 requires a
derived threshold with its measurement beside it, and this counter is how that
measurement gets taken. `LeaseRenewalLoopStopped` already pages on the outcome.

## The amplifier - a catch handler that could throw

`reportError` began with `console.error(...)`, outside every try in the
function. That write is synchronous on fd 2 and throws EPIPE or EAGAIN when a
container's log pipe is saturated or its collector has gone away. Every
`catch (e) { reportError(...) }` in this engine is written assuming reporting
cannot fail; when it can, the handler throws, the `while` around it unwinds, and
the loop is gone - with no log line, because the thing that failed was the log
line. That is the most likely way this particular loop left.

Fixed at both ends: the console write in `reportError` and `reportWarning` is
inside its own try (kept where it is rather than moved into the Sentry try, so
an uninitialised reporter still logs), and the three report sites in the renewal
loop and its supervisor are wrapped as well. A catch handler that can throw is
not a catch handler.

## Fix A - the zero-attempt envelope

The post-commit drain in `postHandTasks` was gated on `lifecycleCanMutate()`, a
DEALER-LEASE check, around a call that disclaims the lease in its own contract:

> This call deliberately carries no dealer lease: once the exact settlement
> transaction commits, completing its frozen obligations is authorized by the
> durable hand receipt, not by whichever process happens to resume it.

So on the single path the barrier exists for - a hand committed by an engine
whose proof lapsed while the settlement was in flight - the loop body never ran.
`attempt` stayed 0, and the give-up branch filed a CRITICAL financial alert
reading "abandoned its durable post-commit envelope ... after 0 attempt(s)": an
alarm about work this process had never once tried to do. 935 of 949 such alerts
all-time carry `attempts: 0`; 414 landed in the eight hours of this outage,
because every engine in the fleet was losing its proof every 20 seconds.

The drain is now `while (!obligationsApplied && mayStillDrain())`, where
`mayStillDrain()` is `lifecycleCanMutate() || Date.now() < drainDeadline`. Two
things follow, and both matter:

- a predecessor always gets at least one attempt at its own envelope, and a
  `POST_COMMIT_DRAIN_BUDGET_MS` (5s) handover window to finish it - one
  projection-worker poll interval, so the successor is already awake when this
  gives up;
- **the healthy path is unchanged.** While the engine can still mutate the
  barrier is exactly as unbounded as it always was. Capping a live retry would
  have filed the critical alert on hands that were about to succeed, which is
  the defect `aDetectorMayNotCryWolf` exists to prevent.

The backoff in the catch was gated on the same lease check, so an engine past
its proof slept zero and would have spun the whole handover into one tight
retry; it now runs unconditionally, with the last sleep clipped to what is left
of the budget so the ceiling really is the budget.

**What did NOT change: `postCommitStateCanReflect = this.lifecycleCanMutate()`.**
Only the DRAIN loses the lease term. Process-local reflection - the stack
refresh, the add-on announcement, every later money step - is still fenced on
the lease, and the guard test now pins that explicitly, because the easy
over-correction is to take the lease out of both.

Safety was never what the lease was providing here.
`fn_ca_process_hand_post_commit_obligations` takes a per-table
`pg_advisory_xact_lock`, reads the hand `FOR UPDATE`, and returns
`already_completed: true` for a receipt somebody else finished.

## Pins moved, and why that is not weakening them

Two source-text guards pinned the behaviour being replaced, so both moved in
this commit rather than after it:

- `PostCommitObligationBarrier.guard.test.ts` pinned
  `while (!obligationsApplied && this.lifecycleCanMutate())` under the title
  "unbounded ... until completion or lease loss". It now pins the properties
  that pin was reaching for - no attempt cap, no break, the lease never the only
  thing keeping the drain alive, and the reflection fence intact - plus the
  regression itself by name, so it cannot come back quietly.
- `DirectEngineRecovery.guard.test.ts` pinned the boot position of
  `this.runOwnershipLeaseRenewalLoop(generation)`. It pins
  `this.superviseOwnershipLeaseRenewal(generation)` in the same position, with
  the supervisor's own body pinned beside it. Intent unchanged: ownership
  renewal still starts before discovery.

`theLoopThatRenewsEveryLeaseCannotStopSilently.law.test.ts` was EXTENDED rather
than joined by a second law - two laws about one loop is a coin flip decided by
whichever test the next agent reads first (CLAUDE.md 10.8).

## Tests

- `server/src/engine/APredecessorMayStillFinishItsEnvelope.law.test.ts` (new
  law, registered in `docs/laws.d/`): builds a cash table whose proof lapses on
  the way back from the accepted commit, and proves the envelope is attempted,
  the give-up alarm can never carry `attempts: 0`, the handover is bounded by a
  clock, and reflection still stops at the fence. Verified to bite: with the old
  guard restored, four of its five assertions fail with `expected 0 to be
greater than or equal to 1`.
- `server/src/GameServerLeaseRenewalSupervision.test.ts` (new): a loop that
  throws on its first pass is running again within one cadence with the counter
  incremented; it keeps being relaunched while it keeps dying, and is paced
  rather than spinning; it survives a `reportError` that throws; and it stops
  for good on a clean generation change or a stopped server. Verified to bite:
  with the relaunch removed, three of six fail.
