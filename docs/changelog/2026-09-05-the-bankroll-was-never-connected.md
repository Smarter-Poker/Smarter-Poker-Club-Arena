# The bankroll law was written, tested, and never connected

2026-09-05. Dan: _"horses aren't supposed to have 'preferred game types' they
are supposed to play off of there 'bankroll management laws' and rules first
and foremost. THATS THE STARTING POINT."_

He was right, and it was worse than a wrong ordering.

## The measurement

`HorseBankroll.ts` is a complete bankroll management law - sit, move up, move
down, top up, buy-in sizing, stop win, stop loss, three temperaments. Callers
outside that file and its own unit test, counted this morning:

| rule                 | non-test callers |
| -------------------- | ---------------- |
| `canSit`             | 3                |
| `canMoveUp`          | **0**            |
| `shouldMoveDown`     | **0**            |
| `bestAffordableGame` | **0**            |
| `topUpDecision`      | **0**            |

Four of the seven had never run in production. The one that did ran as a
**veto**, applied _after_ the stake had already been chosen - by
`assignPreferredStakes`, which is `shHash(horseId, 'stake-band', seed) % 100`.
Money could object to a hash's choice. It could not make one.

What that produced on the live floor:

| horse        |  bankroll |   playing | buy-ins covered |
| ------------ | --------: | --------: | --------------: |
| venom        | 4,759,025 | 0.25/0.50 |          95,180 |
| foldto3b f3b | 3,843,526 | 0.10/0.25 |         153,741 |
| falcon       |   755,647 | 0.05/0.10 |          75,565 |

Across the 116 seated horses holding more than 20,980 chips, the **mean big
blind played was 0.535**.

## The second half: why the tables were empty

The tag gates are an INTERSECTION - variant AND exact blind - and both were
hash-derived. Eligible horses per open cash table, out of 1,000:

```
short_deck 2.00 -> 11    plo6 2.00 -> 16    short_deck 1.00 -> 16
plo5 2.00      -> 18     flo8 0.50 -> 26    pineapple 1.00 -> 26
every 5.00 table -> 0
```

Those counts are _before_ the rest day (142 horses today), the daily cap, the
activity window, the host occupancy curve and the four-table limit. A cell
nominally holding 16 candidates realistically offered two or three against 24
seats - which is why `No available horses` was firing on 1/2, 0.50/1 and
0.25/0.50 tables, not merely on the 2/5 tier I reported earlier.

## What changed

1. **`affordableStakeWindow(roll, ladder, policy, currentBb)`** - the stake is
   derived from the roll, with `canMoveUp` applied when the step is upward and
   `canSit` when it is not. It returns a **two-rung** window, so Dan's
   2026-08-29 ruling ("a horse plays ONE stake level", written after 64 of 210
   horses sat 0.10/0.20 and 25.00/50.00 in 48 hours) is intact - what changed
   is that the rungs follow money that moves rather than a hash that cannot.
   Broke returns an empty window; it never falls through to "anything".
2. **The seeding loop asks the roll, not the tag.** An unreadable roll still
   fails open to the old tag/band rule - the same contract as every other gate,
   for the reason recorded on 2026-08-31 when reading an unknown roll as zero
   emptied the cash floor for forty minutes.
3. **A preference never leaves a seat empty.** The candidate filter is now
   `passFilter(relaxPreferences)`, run strict first and relaxed only when the
   strict pool cannot fill the empty seats. The relaxable gates are the tagged
   variant and the tagged rung. Every hard gate - club, door, bankroll, rest
   day, daily cap, host occupancy, table ceiling, one-seat-per-game - is
   identical in both passes, and the law test asserts that line by line.
4. **The bankroll gets its own log line.** `stakeOutOfRollDropped` is counted
   apart from `tagDropped`, because "the tag said no" and "the roll cannot
   cover it" are different facts and one number for both is how a law with
   zero callers went unnoticed.

`tests/the-bankroll-chooses-the-stake.law.test.ts`.

## Still Dan's

`PHASE_MAX_BB = 2` (section 8.3): _"NOTHING sits above 1/2 this phase, however
rich the wallet."_ `STAKE_LADDER` stops at 2.00, so even an unlimited roll
cannot reach a 5.00 table. The 16 tables at 5.00 on the floor are unseatable by
the platform's own law - **either the phase advances or those tables should not
be created.** Creating a table at a stake nobody is permitted to sit at is a
defect in the table config, not in the seeder, and the decision on which way to
resolve it is a floor-shape decision.
