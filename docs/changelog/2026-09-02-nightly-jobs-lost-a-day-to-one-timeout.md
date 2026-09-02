# 2026-09-02 - three nightly jobs claimed a day, timed out, and lost it

Found by the daily horse audit analysis, which could not run because the thing
it analyses had itself been lost this way.

## What happened

| Job           | Day        | Claimed      | Died on                                        | Rows written |
| ------------- | ---------- | ------------ | ---------------------------------------------- | ------------ |
| `daily_audit` | 2026-09-01 | 06:03:13 UTC | `supabase_timeout`                             | 0            |
| `self_tuner`  | 2026-09-01 | 08:00:43 UTC | `canceling statement due to statement timeout` | 0            |
| `self_tuner`  | 2026-09-02 | 08:03:17 UTC | same                                           | 0            |

The 2026-09-01 audit row did not exist until this analysis generated it by
hand, 28 hours late. It then succeeded on the FIRST retry and returned 44
findings, which is the whole point: nothing here was broken except the
recovery.

## Why nothing retried

Not the claim lock. `claimNightlyJob` has been able to take over a claim that
is stale and has written no rows since 2026-08-30, and both services tick
every 10 minutes inside a 3-hour window - 18 chances.

The in-process memo is what shut the day. Both services set it on the
STAND-DOWN path (`claimed by another instance`), so it recorded "we looked at
this day", not "this day is done". After a failure the next tick returned at
that memo before it could re-ask for the claim, 30 minutes before the stale
claim became takeable. With one engine container, that memo is the whole world
and the 2026-08-30 takeover machinery could never engage.

`HorseSelfTuner` even sets `lastRunDate = null` in its catch specifically to
allow a retry. The stand-down branch on the very next tick set it straight back
to `today`.

## The fix

- `runDailyAudit` returns a boolean. Only `true` closes the day.
- Neither stand-down branch touches the completion memo. Each keeps a separate
  stand-down memo that suppresses the repeated LOG LINE and nothing else.
- A failed audit says so at `warn` and leaves the day open.

## Also: `river_raise_war` had no denominator

Same bug shape, in the detectors. `river_aggr_lost` was given a win-side mirror
on 2026-09-01 precisely because a tag that exists only on losses cannot be
tuned against. `river_raise_war`, added underneath it, was left one-sided:
measured 2026-08-28..09-01 it carried 1,696 hands and zero wins, and on
2026-09-01 it was the worst average line in the audit at -87.7bb over 226
hands - unactionable, because the sample is selected for being negative.

`river_raise_war_won` is now recorded on the winning side by the same counting
rule (shared `riverAggressiveActions` helper), and is excluded from the
self-tuner by the existing source-level guard test.

## Verification

`npx tsc --noEmit` clean; `npx vitest run` 323 files / 3,578 tests pass.
