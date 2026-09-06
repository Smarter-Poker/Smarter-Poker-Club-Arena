# The tuner was fighting the VPIP floor

2026-09-06. The rake bug again, in a different input.

## What was happening

`HorseSelfTuner` judges each horse's VPIP against the winning-player band
(19-32%) and moves `tightness` when it falls outside. Its own log:

| run        | tightened for "too loose" | fleet VPIP |
| ---------- | ------------------------- | ---------- |
| 2026-09-03 | 104 of 429                | .277       |
| 2026-09-04 | 180 of 386                | .312       |
| 2026-09-05 | **216 of 383 (56%)**      | .338       |

Tightening the fleet was making the fleet looser, three nights running. That
shape means the measurement is wrong, not the horses.

It was the VPIP floor. A table with `nit_game` and a `maintain_percent_min`
stands a seat up after ten hands below the floor, and horses are players
(CLAUDE.md 10.5), so `HorseLogic.vpipFloorMul` widens the brain toward it. A
horse at a floored table is **required** to play 40-70% of hands. Of the 72
cash tables the fleet played on 2026-09-05, 15 were floored at a mean floor
of 49.3% - one at 70%.

`horse_daily_play` summed that play together with ordinary play, so the tuner
saw one blended VPIP and judged it against a band that assumes the horse was
free to fold. And `tightness` is a **global** dial: the horse was tightened
everywhere, re-widened by the floor at the floored table, and played nittier
at every ordinary table it sat at. Every night, cumulatively.

This is exactly the 2026-09-04 rake defect - a blended number judged against
an unblended band - and it gets the same treatment: give the measurement the
context it was missing rather than move the band.

## What changed

The floor now travels with the hand, and the frequency row is keyed by it.

- `ServerTableEngineSettlement` passes `this.vpipFloor()` into
  `logHandHistory`; `handHistory.ts` forwards it to `recordHorseHandReviews`.
- `HorseHandReview` accumulates floored and unfloored play under separate
  keys, and `horse_daily_play.floored` joins the primary key - both kinds of
  play are still recorded, and the panel can still show either.
- `HorseSelfTuner.loadPlayRows` and `fn_horse_frequency_leaks` read
  `floored = false`. The V49 detector stops reporting the floor as a leak.
- The `BENCH` bands did not move. That was the wrong fix and the law says so.

## What now watches it

- `fn_audit_tuner_health` gains `tuner_tightened_the_fleet`: **critical** when
  over 40% of tuned horses are moved the same way in one night. Run against
  2026-09-05 it fires immediately - 216 of 383 - which is the point. A mass
  move in one direction is a broken input before it is 216 broken horses.
- `fn_audit_frequency_leaks` gains `frequency_floored_share`, so the share of
  cash hands the bands can no longer see is reported rather than silently
  excluded. Warn at 40%: past that, the bands judge a minority of the play
  and horses stop reaching the 1,000-hand gate. Silently narrowing an input
  is how the rake bug survived for weeks.
- `TheTunerDoesNotFightTheFloor.law.test.ts` pins the whole chain - settlement
  sends it, handHistory carries it, the review keys by it, the tuner filters
  on it, and the bands stay put. Six tests; removing any single link fails at
  least two of them.
- `HorseDataLedger` names the second consumer of `vpipFloor`, so the datum has
  a receipt on both paths.

## Migrations

- `20260906020147_the_floor_is_not_a_leak`
- `20260906020732_the_audit_says_how_much_play_the_bands_cannot_judge`

Both applied to production and recorded in `schema-manifest.d`.

## Gates

`tsc --noEmit` clean; 101 horse test files, 1,279 tests, all pass;
`check-phantom-columns`, `check-phantom-tables`, `check-horses-are-players`,
`check-no-emoji`, `check-new-migration-version-collisions` all OK. The new law
was mutation-checked: reverting the accumulator key fails it.
