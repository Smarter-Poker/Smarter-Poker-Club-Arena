# A refused finish asks for another pass, and now somebody hears it

2026-09-09

## What was wrong

Ten tournaments were sitting on production at exactly one player.

Read at 04:09 UTC, every one of them the same shape: one row `status='playing'`
holding chips, every other row already `status='eliminated'` on a zero stack,
zero pending knockout candidates, one open table. Decided events. Nothing about
them was ambiguous and nothing about them was in progress.

| tournament                        | one survivor since | waited |
| --------------------------------- | ------------------ | ------ |
| `Sunday Deep Stack Satellite $10` | 2026-09-08 23:00   | 5h 09m |
| `5 Chip Deep Stack Spin PLO6`     | 02:52              | 1h 17m |
| `10 Chip Deep Stack Spin PLO6`    | 03:10              | 59m    |
| `PLO4 Heads-Up 1`                 | 03:12              | 57m    |
| `1 Chip Spin PLO5`                | 03:13              | 56m    |
| `50 Chip Spin PLO4`               | 03:24              | 45m    |
| `NLH Heads-Up 5`                  | 03:27              | 42m    |
| `10 Chip Deep Stack Spin PLO6`    | 03:39              | 30m    |
| `100 Chip Deep Stack Spin PLO6`   | 03:40              | 29m    |
| `10 Chip Spin PLO4`               | 03:40              | 29m    |

## The cause, read rather than guessed

`finishTournament` fails closed in about thirty-five places. Every one of them
ends the same way:

```ts
this.tournamentFinished = false;
return;
```

under a comment at the top of the method that states what that release is for:

> One in-process finalizer at a time. On every fail-closed exit below the flag
> is released **so the next elimination sweep can resume** the durable
> COMPLETING claim and prepared obligations.

**There is no next elimination sweep.** A sweep is woken by an elimination, and
`finishTournament` is only ever entered once the field is down to its last
player: there is no hand left to deal, nobody left to bust, and therefore
nothing left to wake one. The release was a request that nothing was listening
for, which made every refusal terminal - whatever its reason:

- the hourly maintenance freeze (`isMaintenanceFrozen()`, five minutes in every
  hour, so roughly one finish in twelve arrives inside one);
- a refused or ambiguous `claimTournamentFinish`;
- an unreadable `tournament_players` row while proving the durable winner
  marker;
- an unreadable `tournaments` row;
- a failed `cleanupCommittedTournament()`.

Each of those guards is correct: they are meant to refuse rather than guess with
somebody's prize. What was wrong is that refusing was the end of the story.

This is CLAUDE.md 10.86 exactly - a component answering confidently about
something it had no way to know. The comment asserts a recovery mechanism as
fact, the mechanism does not exist for this shape, and it reads as covered to
every agent who has opened the file since.

## The fix

The flag is the only signal there is, so it is read where the call was made.
Both call sites in `runEliminationSweep` now end with:

```ts
await this.finishTournament(winner.user_id);
if (sweepStopped()) return;
this.rearmIfTheFinishWasRefused();
```

and the helper is four lines:

```ts
private rearmIfTheFinishWasRefused(): void {
  if (this.tournamentFinished) return;
  this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
}
```

Still set means the finish owns the event or completed it, and nothing is armed.
Cleared means it handed the event back, and the sweep comes round again in five
seconds - the same interval every other unresolved path in this file already
uses.

It covers all thirty-five exits and every one somebody adds later, because it
reads the state they all leave behind rather than naming any of them.

### Why this is not a band-aid (10.12)

Nothing here back-fills, compensates, tops up or repairs a row. No job is
scheduled, no cron is added, no second write cancels a first. The finish has
simply not happened yet, and this is the identical work being attempted again
the moment it can succeed - the live path made restartable from its own record,
which is what 10.12 asks for in place of a sweeper. A tournament that finishes
five seconds late is the correct outcome; one that never finishes is not.

`tournamentEliminationScheduler` keeps exactly one pending wake per tournament,
so the exit that already re-arms (the maintenance-freeze branch, below)
coalesces with this rather than stacking a timer.

## Also in this change: the freeze branch defers instead of dropping

The first line of `finishTournament` was:

```ts
if (isMaintenanceFrozen()) return;
```

No log, no retry, nothing. CLAUDE.md 13 rule 4 says a deadline is thawed, not
burned; this one was burned. It now says what it is doing and re-arms, so the
finish resumes after the thaw.

## Pinned

`server/src/tournament/aRefusedFinishAsksForAnotherPass.test.ts` - seven pins,
all bounded by structure via `testHelpers/sourceWindow`:

- both finish call sites re-arm;
- a finish that SUCCEEDED never re-arms (or a completed event sweeps forever);
- the retry goes through the sweep scheduler, never a bare `setTimeout`;
- `finishTournament` still releases the flag on its fail-closed exits - if a
  later edit stops doing that, the re-arm silently becomes a no-op and this
  defect returns wearing the fix, so the coupling is pinned explicitly;
- the freeze branch defers rather than returning bare.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/tournament`: 116 files, 1207 tests, all passing.
- `tests/unit/noFixedSizeSourceWindows.test.ts` and `tests/law-registry.law.test.ts`:
  passing.
- Production: the ten wedged tournaments are the measurement. They clear on the
  next engine restart once this deploys, and the count is expected to stay at
  zero afterwards rather than being cleared again by hand.
