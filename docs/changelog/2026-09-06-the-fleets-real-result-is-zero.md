# The fleet's real result is zero

2026-09-06. The same defect a third time, and this one closes it.

## The measurement

2026-09-06 was the first day the rake attribution ran for a whole day. Over
11,687 cash hands and 31,186 horse seat-hands:

|                                    | bb                                    |
| ---------------------------------- | ------------------------------------- |
| horse net                          | **-10,797**                           |
| attributed rake                    | **+9,020** (99.1% of the 9,103 taken) |
| **residual after rake**            | **-1,778**                            |
| bad-beat-jackpot drop at the table | **+1,761**                            |
| **true skill result**              | **~0**                                |

A 1.0% match. The fleet plays itself - 29 of 143,795 cash hands on 2026-09-05
had a human in them - so its aggregate result **must** be zero minus what the
house takes out of it. It is.

**The fleet's real win rate is 0.0 bb/100, not -34.5.** Every chip it loses is
the house taking one.

## Why it mattered

`HorseSelfTuner` regresses a horse's dials halfway to neutral when its result
is under -15 bb/100. On 2026-09-05 the rule was taught to judge `net + rake`.
It was never taught about the jackpot, so **5.6 bb/100 of house take was still
reaching it as though it were skill** - and `HorseHandReview` had carried the
note _"the fleet's -32 bb/100 was the day's rake PLUS BBJ DROP to within one
percent"_ since the day the rake half shipped.

Three instances of one defect, now: an incomplete accounting judged against a
band that assumes a complete one. The rake (2026-09-04, 221 of 383 horses
regressed), the VPIP floor (2026-09-05, 216 of 383 tightened), and this.

## What changed

- `ServerTableEngineSettlement` already had `bbjAmount: snap.bbjFee` going into
  `logHandHistory`; it now travels on to `recordHorseHandReviews`.
- `HorseHandReview` allocates it with `allocateWeightedShareCents` over the
  **same contributions list** as the rake - one allocator, one list, so
  `bbj_bb` agrees with the money pipeline the way `rake_bb` does.
- `horse_daily_nets.bbj_bb` carries it; the drain and the failed-flush requeue
  both keep it.
- `RegressionContext.bbjBB100` and `fleetQuartile` judge **net + rake +
  jackpot**. Each half is independently optional, so a row from before either
  shipped behaves exactly as it did.

## What watches it

`fn_audit_fleet_drop_identity` asserts the closed system nightly and is
reported inside `fn_audit_tuner_health` - not as a separate step, because a
short attribution makes every verdict there a symptom rather than a fact. It
reports the residual, and names the missing half for free when one is flowing
and the other is flat zero.

**Its first cut timed out.** It summed a whole day of `hand_history` to compare
drop taken against drop attributed - the same 700,000-row scan that made the
nightly audit unable to finish on 2026-09-04 and had to be rewritten out of
`capture_coverage_gap`. Adding it back one step later would have re-broken the
nightly job. The residual **is** the shortfall, so the second source was never
needed: the rewritten version reads `horse_daily_nets` alone and runs in
milliseconds.

`TheDropIsTheRakeAndTheJackpot.law.test.ts` pins the chain in eight tests,
including the arithmetic difference the missing half makes: the identical
horse at -50 raw with 26 rake and 12 jackpot is **left alone** on both halves
and **regressed** on the rake alone.

## Migrations

- `20260906021958_the_drop_is_the_rake_and_the_jackpot`
- `20260906022346_tuner_health_reads_the_whole_drop`
- `20260906022655_the_drop_identity_costs_one_small_table`

## Still open, and named

`fn_run_horse_daily_audit` takes **17.5s cold, 3.3s warm**, and the engine
client aborts at 15s. It has grown from 34 findings on 08-31 to 82 today. The
06:00 window is exactly when those pages are cold. This work added 0.6s of it;
the rest is older. It wants the same treatment `capture_coverage_gap` got.
