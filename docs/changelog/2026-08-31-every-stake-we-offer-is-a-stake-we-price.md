# Every stake we offer is a stake we price

2026-08-31. Dan's ruling on the rake gap the game-creation audit surfaced,
verbatim:

> "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE THE SAME
> PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE OR BBJ
> SCHEDULE FOR A SPECIFIC GAME."

## What was wrong

`RAKE_SCHEDULE` had 14 rows and the create-table form offers 12 blind presets,
and only six of those presets appeared in it. For the other six
`findScheduleMatch` returned null and `getRakeConfig` fell through to
`getTierForBB` — a stakes tier whose cap is an **absolute dollar amount**
applied regardless of stake.

A dollar cap is a sane number at the stake its tier was written for and an
absurd one two rungs below it. Expressed as a share of a big blind, the
fallback was charging:

| preset                             | fallback        | cap | as BB      |
| ---------------------------------- | --------------- | --- | ---------- |
| 0.01/0.02                          | tier Nano       | $3  | **150 BB** |
| 0.02/0.05                          | tier Nano       | $3  | **60 BB**  |
| **0.05/0.10 (the default preset)** | tier Nano       | $3  | **30 BB**  |
| 0.10/0.25                          | tier Micro      | $3  | **12 BB**  |
| 25/50                              | tier Nosebleeds | $20 | 0.4 BB     |
| 50/100                             | tier Nosebleeds | $20 | 0.2 BB     |

against a published ladder whose most generous row (0.1/0.2 at $3) is 15 BB and
whose typical row is between 1 and 6 BB. The database creation guard had
declined to police it in as many words: _"NOT enforced here and left for Dan:
the official stakes schedule."_

## Both halves of the ruling

**The six missing rows now exist.** No rate was invented — every number is
derived from the ladder that was already published:

- `rakePercent` is **10**, which is what all fourteen existing rows already are.
- `rakeCap` for the three stakes below the schedule's bottom rung takes the same
  BB proportion that bottom rung charges (15 BB): $0.30, $0.75, $1.50.
  `0.10/0.25` sits inside the schedule's own flat-$3 band — 0.2, 0.4 and 0.5 are
  all $3 — and takes $3. The two nosebleed rows take the $20 the Nosebleeds
  tier already charges them, so publishing them moves no price at all; it just
  makes the price published rather than inherited.
- `bbjFeeBB` is the tier's own fee for that stake, unchanged: 0.6 at Nano and
  Micro, 0.03 at Nosebleeds.

**And the fallback itself is fixed**, which is the other half of what Dan
asked. A stake with no row can still arrive from a fleet config or a direct
writer, and it was being priced by a flat dollar figure. `unscheduledCapFor()`
now holds any unscheduled stake to `UNSCHEDULED_CAP_BB` — the most generous
share of a big blind any published row takes, **derived from `RAKE_SCHEDULE`
itself** rather than written down, so it cannot drift from the ladder it
describes. Today that is 15 BB. An unscheduled 0.03/0.07 game was capped at $3
(43 BB) and is capped at $1.05 (15 BB) now.

This binds the fallback only. A stake with its own row is charged that row, and
`MAX_RAKE_CAP_BB` continues to bind operator **overrides** — a separate ceiling
for a separate thing. An earlier note in this audit described the schedule as
pricing "above the ceiling the same file enforces"; that was imprecise and is
corrected here. The 10 BB constant never bound the schedule, and the schedule's
own bottom rung has always been 15 BB. What was genuinely broken is that
UNSCHEDULED stakes got a flat dollar cap — ten times the ladder's own bottom
rung at the cheapest preset.

## What this changes for players

Measured against production before committing. Of 972 cash tables, exactly
**two** sit on a stake whose price moves: the two at 0.05/0.10, whose cap falls
from $3 to $1.50. Both are closed. Every other live stake — 794 tables at 1/2,
129 at 2/5, and the rest — was already on the schedule and is untouched.

**No player pays more than before at any stake.** The only movements are
downward, and only at the bottom of the ladder where the flat cap was never
meant to apply.

## Still open, and still Dan's

`RAKE_SCHEDULE` contains `{ sb: 5, bb: 5 }`. The table-creation guard refuses
"big blind must exceed small blind", so no table can ever match that row. 5/10
already exists; 2.5/5 would fit the ladder. It is a separate question from the
coverage ruling and it is a money row, so it stays recorded and untouched —
pinned as a `.skip` naming what has to be decided.

## Files

- `src/config/RakeConfig.ts` and `server/src/config/RakeConfig.ts` — six rows
  and the proportional fallback, applied identically (the schedule lives only
  in these two files; there is no SQL copy, and
  `scripts/ci/check-rake-schedule-parity.mjs` pins them to each other)
- `tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts` — the gap pins
  become coverage pins; the `.skip` invariant now runs, against the correct
  constant
- `tests/unit/RakeConfig.schedule.test.ts` — the schedule-length pin updated in
  this commit, per CLAUDE.md rule 8

Verification: `tsc` clean both sides; client unit 483 files / 6,852 tests;
client non-unit 249 / 3,446; the thirteen server rake and BBJ suites (203
tests) green; `check-rake-schedule-parity`, `check-rakeconfig-parity` and
`check-rake-bbj-collection-law` all pass.
