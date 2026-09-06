# A sweep never makes a row the recovery will refuse (2026-09-06)

CLAUDE.md 10.11: fix it at the root. The hand settlement of PLO4 Heads-Up 25
earlier today (`2026-09-06-the-suspended-heads-up-is-settled-by-a-deal.md`)
paid two players who had been owed for three days. It did not stop the next
one. This is the cause.

## What the sweep did

`GameServer`'s boot-time stale sweep takes any tournament that has been
RUNNING for over twelve hours with no hand in the last hour, flips it to
COMPLETING, and hands it to `recoverStuckCompletingTournaments`. That is the
right instinct - Dan 2026-08-19, "TOURNAMENTS RUN. THEY DO NOT CANCEL" - and
it replaced a cancel path that voided games.

But the recovery it hands to asks a question the sweep did not:

```
fieldIsStillLive({ livePlayers, paidPlaces })   // recoveryFieldGuard.ts
```

and REFUSES when more players are left than the structure has places to pay.
That guard is correct and was written for a real incident: on 2026-08-30 the
Sunday $200 Deep Stack was paid its entire 20,880 pool to nine of ninety
players by chip count, because the rescue ranked a live tournament.

So on a stalled game with a live field the two halves disagree, and the
result is worse than either alone: **the sweep moves the row to a state
nothing can finish.** The discovery loop resumes `status = 'RUNNING'` only, so
a COMPLETING row is invisible to the one path that could still deal it out.
A game a manager could have adopted becomes permanently stuck, and the only
exit is an operator.

That is what happened to **PLO4 Heads-Up 25 (3e281f5c)**: three entrants into
a heads-up format on 2026-09-03, one busted, two left holding 2,000 and 1,000
chips against a one-place structure. It sat COMPLETING for three days. Every
watchdog that looked at it said, correctly, "left in COMPLETING for a live
engine to resume or an operator to settle" - and no live engine could, because
the state it was in is the state the resume path does not read.

Reviving it to RUNNING by hand at 15:25Z today was not a fix either: the same
sweep would have returned it to COMPLETING at the next boot.

## The fix

The sweep asks the same question, with the same pure guard, on the same
numbers, BEFORE it claims the row:

- `livePlayers` - `tournament_players` at `status = 'playing'`, `count: 'exact'`;
- `paidPlaces` - `resolvePayoutStructure(t, fieldSize).length`, the structure
  the recovery itself would resolve, trimmed to the real field.

A field the recovery would refuse is **left RUNNING** - the state it can still
be rescued from - and reported as
`GameServer.stale_sweep_left_live_field_running`, naming the counts and saying
it needs an operator if it does not deal. A count that cannot be read skips
the row rather than guessing (10.86: a signal that answers when it does not
know is the estate's failure mode).

Nothing else moves. A genuinely finished game - nobody left, or fewer left
than places - takes exactly the path it took before, which is the path that
pays the places out.

## Why the guard is not simply reused inside the recovery instead

It already is. The recovery refuses correctly; refusing is all it can do,
because ranking a live field by chipstack is the 2026-08-30 incident. The
defect was never the refusal - it was a caller manufacturing the case and then
discarding the answer. Fixed where the case is made.

## Pinned

`server/src/tournament/aSweepNeverMakesARowRecoveryRefuses.test.ts`: the guard
is before the claim, the refusing branch writes no status and continues, the
unreadable-count branch leaves the row RUNNING, and the shape that stuck
3e281f5c (two alive, one paid place) is refused.

## The net that stays

`recoverStuckCompletingTournaments`' own guard, and #3340's overstayed-manager
recovery. Both are expected to find nothing from this cause now. If
`GameServer.stale_sweep_left_live_field_running` starts firing regularly, the
question is no longer this sweep - it is why a live tournament went twelve
hours without a hand.
