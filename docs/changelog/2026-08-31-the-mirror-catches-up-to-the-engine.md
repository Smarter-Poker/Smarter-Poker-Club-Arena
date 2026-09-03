# The mirror catches up to the engine

2026-08-31. The second half of a deliberately two-step change, and the half
that could not be done until the engine had shipped.

## Why it was two steps

PR #2250 added six rows to `RAKE_SCHEDULE` and a proportional cap for stakes
the schedule does not name. Those changes were pushed into `ca_rake_schedule`
**ahead of the code**, which was a mistake — another agent's
`20260831145500_the_alarm_measures_the_engine_not_our_opinion_of_it.sql`
reversed their effect and was right to.

`ca_rake_schedule` exists so `fn_rake_law_violations` can judge a hand against
the cap the **engine** applies. While the deployed engine still had fourteen
rows, a mirror carrying twenty answered $1.50 for a stake the engine capped at
$3.00, and would have filed **60 correct hands as `over_cap` criticals**. The
six rows were parked as `source = 'proposed'`, excluded from resolution.

## Why it is safe now

Verified against the engine itself, not the client. The two deploy separately:
`smarter.poker` serves the World Hub bundle, and the engine is its own Hetzner
container. **Checking the client would have proved nothing** — and an earlier
version of my own follow-up instruction told me to check exactly that, which
would have flipped this hours too early.

```
curl -s https://engine.smarter.poker/health  ->  "version":"68d6f906"
68d6f906bc = fix(e2e): stabilize final production certification (#2281)
git merge-base --is-ancestor 20eac87da1 68d6f906bc          -> true
git show 68d6f906bc:server/src/config/RakeConfig.ts
  | grep -c unscheduledCapFor                                -> 2
```

The running engine carries both the twenty rows and the proportional fallback,
so the mirror was now the stale half. Leaving it stale would have made the
alarm too **lenient** in the other direction: allowing $3.00 at 0.05/0.10 while
the engine caps at $1.50, and missing a genuine over-cap hand.

## What changed

The six rows become `engine_mirror`, and `fn_effective_rake_cap`'s fallback is
held to the ladder's most generous ratio again, mirroring `unscheduledCapFor`.
Everything the 145500 migration got right is kept: the `engine_mirror` filter
on the schedule lookup, and the `max_bb` cascade with `NULLS LAST` that closed
the tier gaps.

## Verified after applying

| probe                                | result                         |
| ------------------------------------ | ------------------------------ |
| rows mirrored / parked               | 20 / **0**                     |
| derived ratio                        | 15 BB                          |
| 0.05/0.10 (the stake this was about) | **$1.50**, matching the engine |
| 1/2, 2/5, 25/50                      | $5.00, $7.50, $20.00 — unmoved |
| unscheduled 0.03/0.07                | $1.05, in proportion           |
| 0.45/0.9 (an old tier gap)           | $5.00, no longer NULL          |
| `fn_rake_schedule_drift()`           | **0 rows**                     |
| `fn_rake_law_violations('3 hours')`  | **zero `over_cap`**            |

The only findings the alarm reports are 4 `no_flop_no_drop` and 3
`board_not_recorded`, both at 1/2 — the pre-existing defects the alarm was
built to surface, unrelated to this change.

## The standing lesson

A schedule that lives in a deployed bundle **and** in a database table cannot
be changed atomically, so every such change is two steps with a window between
them where the two disagree. Getting the order right matters in both
directions: too early files false criticals, too late misses real ones. That
is the argument for the database being the single authority and the engine
reading it, which stays on the record as the standing recommendation.
