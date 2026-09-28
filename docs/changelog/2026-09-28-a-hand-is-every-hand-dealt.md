# 2026-09-28 - horse_daily_nets counts every hand dealt

## What was wrong

The 2026-09-27 audit flagged 38 horses with 1,500+ hands whose `real_bb100`
was the `-9999` sentinel. The tuner was not at fault: `horse_daily_nets`
records only about 60% of the hands a horse is dealt.

For one horse on 2026-09-27:

| source                        | cash hands | tournament hands |
| ----------------------------- | ---------- | ---------------- |
| `hand_history` (ground truth) | 3,101      | 302              |
| `horse_daily_play`            | 3,101      | 302              |
| `horse_daily_nets`            | 2,136      | 198              |

Fleet-wide, nets ran at 0.59 to 0.71 of play every day from 09-15 to 09-28.

## Cause

`accumulateHorseNets` skipped a horse whose invested and returned chips were
both zero, a line commented "dealt in but never posted". That is every hand a
horse folds preflop without posting a blind. `net_bb` stayed right, because
such a hand nets zero, but the hand count did not:

- every bb/100 built on `horse_daily_nets` was inflated about 1.45x;
- the tuner's 1,500-hand gate for `real_bb100` read about two thirds of the
  sample, which produced the sentinels;
- `REGRESS_BB100 = -15` fired on horses whose true rate was nearer -10.

## Fix

A horse's hand counts when it was dealt in: it holds cards in the hand's deal,
the same rule `horse_daily_play` uses. With no deal recorded, having moved
chips still counts. A seated horse that was not dealt still does not.

## Transition

The tuner reads a rolling seven-day window, so for seven days it mixes old,
undercounted rows with corrected ones. Rows already written are not rewritten
(CLAUDE.md 10.12); they age out of the window.

Pinned by `server/src/services/HorseRealNets.test.ts`.
