# A refused finish asks for another pass, and now somebody hears it

2026-09-09

## What this is, and what the evidence for it actually is

**Read the correction in the next section before quoting any number from this
page.** This defect is real and was found by reading the code, not by watching
it bite. The first version of this changelog claimed a ten-tournament
production incident and it was wrong; the claim is retracted below rather than
quietly deleted, because a wrong measurement left in a changelog is how the
next agent inherits it as fact.

The defect: `finishTournament` can refuse, and a refusal was terminal.

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

## RETRACTED: the ten wedged tournaments (2026-09-09, same hour)

The first version of this page opened with a table of ten tournaments "wedged"
at one survivor, the oldest for 5h09m, presented as the incident this fix was
written for. **That table was wrong twice over and none of it should be
believed.**

1. **The waits were fabricated by a column misread.** The "one survivor since"
   column was `tournaments.started_at` - when the event STARTED. It says nothing
   about when the field came down to one player. There is no column on that row
   that says what I claimed it said, so the 5h09m and every other duration in
   that table was arithmetic on the wrong number.
2. **They were not wedged.** Re-read seven minutes later, at 04:16 UTC, the
   count of RUNNING tournaments at exactly one player had gone from 10 to 1, and
   `Sunday Deep Stack Satellite $10` - the "5h09m" case - was `COMPLETED` with
   zero players. Every one of them finished on its own. A snapshot of a
   population that turns over constantly (Spins and heads-up events finish all
   day) was read as a backlog.

So: this fix ships on a code reading. `finishTournament` genuinely has about
thirty-five exits that hand the event back and nothing that asks for it again,
and that is worth closing on its own terms - but **no production incident has
been attributed to it**, and if one is later, it should be recorded here rather
than assumed from this page.

The irony is the point. This changelog's own thesis is CLAUDE.md 10.86 - a
component answering confidently when it could not tell - and its first draft did
exactly that from a single sample. Two reads seven minutes apart cost nothing
and would have caught it. That is the rule: **before a snapshot becomes a
finding, take the second sample.**

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
- Production: nothing to verify, and that is the honest answer. See the
  retraction above. The behaviour this closes is a path that had no retry;
  proving it fired would need an engine log line from inside one of the refusal
  branches, which is what the new `finish deferred` log gives the next person
  who looks.
