# The floor offers what it lets you play, and is sized for the hour

2026-09-05. Two defects with the same shape: a number decided in one file that
another file had already contradicted, with nothing in between to make them
argue.

## 1. The clamp was two days out of date with Dan

`PHASE_MAX_BB` read **2** — _"NOTHING sits above 1/2 this phase, however rich
the wallet."_

Dan, 2026-09-03: **"ADD THE HIGHER STAKES FOR MIDWAY UNION, CAP IT AT 25-50."**
`HorseFleetManager.DEFAULT_TABLES` carries that instruction out — NLH 2/5,
5/10, 10/20, 25/50 and PLO4 5/10 — and its own comment records the supply check
behind it: 48 high-band horses, every one rolled for 5/10 and 10/20, 35 for
25/50.

`STAKE_LADDER` stopped at 2 and `stakeIsLegalThisPhase` refused everything
above it, so **not one of those tables could ever seat a horse**. Sixteen 2/5
tables were live: ninety-nine seats, **zero horses ever** — not rarely, zero
since creation — with `No available horses ... band mid` logged at them every
cycle, forever. The higher rungs never got that far.

The fleet is rolled for it. Bankrolls across the 1,000 horses that day: median
**73,873**, p90 385,614, max 5,626,482. At the 20-buy-in rule that is **822 of
1,000 clearing 2/5, 593 clearing 5/10, 557 clearing 25/50**. The old note's own
worked example — 10,000 chips licensing 2/5 — is the fleet median times seven.

The clamp is now Dan's ceiling exactly: 25/50 and not a rung higher. The ladder
carries 5, 10, 20 and 50.

Two things deliberately did **not** follow it up:

- `EXOTIC_MAX_BB` stays at 2. Short deck and pineapple are thin enough at 1/2,
  and that cap is now the stricter of the two on purpose rather than a
  duplicate of this one.
- `stakeBandOf`'s `top` band stays at 1/2. A band spanning 1 through 50 would
  let one label point a horse at both, which is the scatter Dan's 2026-08-29
  one-stake-level ruling exists to prevent. The high rungs are reached by the
  **bankroll** (`affordableStakeWindow`), not by a band label.

**The law test found the second instance itself.** Written to assert "every big
blind in `DEFAULT_TABLES` is a rung of the ladder", it failed on `bigBlind: 10`
before I had noticed the high ladder existed. That assertion is the one that
would have caught the original defect on the day it was introduced, and it now
makes the two impossible to diverge again.

## 2. Dan's night rule was never applied to the day

Dan, 2026-09-04: _"fewer tables, more players at each table. late night
shouldn't have any 2-3 handed games."_ Implemented for the **night window
only**.

The occupancy curve caps bodies by the hour — 18% mid-morning, 40% at peak — and
at 10:44 Chicago on 2026-09-05 that was **202 bodies of 964 eligible, spread
across 152 open cash tables**. The head count was exactly what the curve asked
for and every table still looked empty: Dan's night complaint happening at
eleven in the morning, with no rule to catch it.

`tablesNeededForHour` now sizes the floor at every hour from the same
arithmetic. It **changes no percentage of the curve** — the curve still decides
how many horses are awake, this decides how thinly they are spread. The day
keeps a much higher floor (`DAY_MIN_OPEN_TABLES = 24` against the night's 6) and
tolerates a smaller table (three by day, Dan's four at night), so it thins a
spread-too-thin room without ever emptying one. The three protections are
untouched: never a table with a human seated, never one with a human waiting,
never a cluster table.

The night path is bit-for-bit the old arithmetic, asserted as such.

`tests/the-floor-offers-what-it-lets-you-play.law.test.ts`.

## Test churn

Five existing tests pinned the old clamp (`T12 rejects 2/5 and 5/10 however
rich the wallet`, the OPORD wallet table, the exotic ceiling, the controller's
above-clamp exclusion, and `stakeForBand('top')`) and one pinned "parks nothing
in the daytime" — which was passing for the wrong reason after the change,
because twenty tables is below the day floor. All updated in the same commit
with the reason written in, per CLAUDE.md rule 8.
