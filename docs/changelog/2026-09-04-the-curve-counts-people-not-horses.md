# The occupancy curve counts people, not horses

**2026-09-04.** Dan read back the justification I had written for a
horses-are-players register entry and rejected the premise rather than the
wording:

> "CORRECT THE FLEET NEVER DOES SEAT HUMANS, SO SOUNDS LIKE YOU NEED TO ADJUST
> YOUR CODE YOU BUILT, NOT FORCE A PUSH?"

He is right, and it is a correctness bug rather than a style point.

## What was wrong

`bodiesOnHostFrom` counted only horses, and `uniqueLive` in the snapshot did
the same. My argument for it was that the fleet only ever seats horses, so a
human in the count is a number the cap could never act on.

That confuses two different things. **The occupancy curve is a target for how
busy the FLOOR is** — the instruction that produced it was "there should not be
89 PEOPLE playing in the middle of the night". A human at a table is a person
on that floor. Counting only horses meant the floor overshot the curve by
exactly the number of real players in the room: a 29-body night cap with twenty
humans playing delivered forty-nine.

It also had the fleet behaving backwards. When real people turn up, the room
needs **fewer** horses, not the same number. That is the entire reason a horse
fleet exists.

## What changed

- `bodiesOnHostFrom` takes no horse predicate at all now. Every seated body
  counts, and the horses-are-players guard has nothing to flag — the register
  entry I had added is **deleted**, because the exclusion it justified no
  longer exists. `check-horses-are-players: OK - 10 registered exclusion(s)`.
- `uniqueLive` in the snapshot counts every seated body.
- The population the curve is a percentage of (`n`) is still the horse fleet.
  That is fleet sizing, a different question: target = 40% of 584 horses at
  peak; measured against = everyone who is sitting down.

## And the consequence that had to be handled with it

Once humans count toward occupancy, **the tables humans sit at are the ones
most likely to be thin**, and the wind-down takes from the thinnest tables
first. Left alone, that is how a person ends up heads-up against one horse at
3am — the exact thing Dan asked to be rid of two instructions earlier.

So the wind-down now skips a table with a human seated unless it would still be
a real game afterwards (`occupied - 1 >= NIGHT_MIN_PLAYERS`). Two tests pin
both halves: a thin table with a person on it is left alone, a full one is not.

## Why nobody would have noticed

Measured on production while making the change: **zero humans were seated on
either host**, so the old and new counts are identical today — 168 and 122
either way. The bug was invisible precisely because the room is currently all
horses, and it would have appeared the first busy evening as a floor that sat
stubbornly over its own curve.

## Verified

Server typecheck clean, 5,345 tests across 370 files. Client typecheck clean,
12,820 tests across 930 files. Read against the live floor: Midway Union 169
bodies against a 13:00 target of 164 and a cap of 176, Deep Stack 122 against
116 and 124.

`sharp` was also installed into this worktree — a devDependency that arrived
from main in `8be5b4f57` after the last install here, which made one suite fail
to LOAD locally while passing in CI.
