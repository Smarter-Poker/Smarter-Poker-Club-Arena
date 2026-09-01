# A dead layer and two lying feeds (2026-09-01)

## 1. The squeeze branch has never fired

V18 shipped a squeeze response on 2026-08-26: hero opens, someone calls, a
3-bet arrives, and since squeeze ranges are polarised toward air the opener
defends wider (`fourBetThresh` -0.03, `callThresh` -0.02).

The test was `raises === 2 && callers >= 1`. But `callers` is reset to 0 by
**every** raise -- including the 3-bet that creates the squeeze. At the moment
the opener is asked to respond, `callers` is always 0, so the branch was
**unsatisfiable in the exact spot it was written for**.

The league had been reporting this since day one: `v18_squeeze_response`,
`0.00 bb/100`, stderr `0.00`, over 12,000 hands. Not a small effect -- an
_identical_ one, because both arms play the same when the flag can never turn
on. Nobody read it.

That is why the daily audit now raises `league_matchup_inert` on that exact
shape (shipped this morning in `a-lost-nightly-job-is-loud`). This is its
first catch, and it caught a layer that had been dead for six days.

Fix: save the count before the reset. `callersOfPreviousRaise` holds the
number who called the OPEN at the instant the 3-bet lands -- the squeeze
condition, stated correctly.

## 2. Both self-tuner feeds paged over a non-unique sort key

`horse_daily_nets` is keyed `(horse_user_id, day, game_variant, format)`.
`horse_review_rollup` is keyed `(horse_user_id, day, game_variant)`. Both were
paged 1,000 rows at a time ordered by `(horse_user_id, day)` alone.

In a seven-day window that is **2,589** tied groups in the first and **3,413**
in the second. Postgres does not promise a stable order within ties, and
LIMIT/OFFSET pagination over an unstable order silently drops rows and repeats
others.

Measured consequence: two horses with 2,141 and 2,332 cash hands in the window
-- both comfortably past the 1,500-hand bar -- came out under it and were
logged with the `-9999` "no real sample" sentinel. Their dials were then tuned
from frequency estimates rather than settlement truth, which is the exact
substitution `MIN_REAL_HANDS_FOR_BB100` exists to prevent.

The leak-tag feed has the same bug, and those counts drive `tightness`,
`aggression` and `bluffFreq` directly.

Fix: order by the full unique key in both loops, so page boundaries are
deterministic.

## How this was found

The `-9999` sentinel on two horses looked like a rounding edge at the 1,500
boundary and was filed as a `note` this morning. It was not: the horses had
thousands of qualifying hands. Checking the format filter first (the tuner is
cash-only by design, so tournament hands legitimately do not count) ruled out
the innocent explanation before the pagination was suspected.

## Verification

`npx tsc --noEmit` clean. Full server suite: 307 files, 3418 tests, 0
failures. Six new pins in `SqueezeAndPagination.law.test.ts`, including that
the capture happens _before_ the reset -- the ordering is the entire fix -- and
a guard that every paged read in the tuner carries enough ordering to be
deterministic.

Note that `v18_squeeze_response` cannot be read as a real measurement until
the league runs again; see `a-lost-nightly-job-is-loud`.
