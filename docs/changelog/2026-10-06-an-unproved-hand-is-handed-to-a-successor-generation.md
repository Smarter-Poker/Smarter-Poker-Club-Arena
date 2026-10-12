# An unproved hand is handed to a successor generation (2026-10-06)

## What happened

06:10-06:19 UTC a database stall timed out tournament hand settlement. On 78
tables of two events ("Midnight Free Buy (NLH)" 795028a3, "$100 Freeroll"
f9b024a6) the engine exhausted its bounded identical replay, fenced itself and
threw "authoritative hand commit was not proved". Rows read afterwards: 78
`f06_hand_permits` in `reserved`, 78 matching `hand_submissions` retained
between 06:10:00 and 06:16:02, none in `hand_history`, no dispatch or failure
row. Every hand was replayable. Both events then stood still; the engine log
showed 1,878 unproved-commit errors and 939 `table_engine_recovery_cleanup_failed`
reports in a three-minute sample an hour later.

## The cause

`performManagedTableEngineRecovery` stops the dead engine and asks the
seat-move certificate whether it may be replaced. The certificate refuses while
the engine holds a permit (`recovery:f06_permit_retained`). A hand that started
leaves its permit `attempted`, and only a proved commit clears it; the stopped
original custody path handles `unknown`, `reserved` and `terminated` and
returns for anything else. So recovery rescheduled itself for ever.

The designed resolution is `fn_ca_resume_hand_submission` at a fresh engine's
admission, which replays the retained payload. It refuses the generation that
retained the hand, and the abandoned-generation void refuses a generation that
is live. Both need a different lease generation, and nothing in a running
process ever produced one. Only a process replacement did.

## The fix, at the cause

When the refused engine holds an `attempted` permit bound to the manager's own
lease generation and has released process ownership, the manager pauses every
other table after its current hand, waits (on the existing causal retry) until
none has cards in the air, and asks `GameServer.handTournamentToSuccessorGeneration`.
That stops the exact manager and releases its lease through
`stopTournamentManagerIfOwned`, the same owner a lost lease uses; running-event
discovery admits a manager under a fresh generation, whose admission replays
each retained hand or voids an unretained one through the existing doors.
Nothing is settled, voided or reconstructed by the new code.

## Proof

`server/src/tournament/anUnprovedHandIsHandedToASuccessorGeneration.law.test.ts`.
The live path was reasoned about and unit-tested, not executed against
production.
