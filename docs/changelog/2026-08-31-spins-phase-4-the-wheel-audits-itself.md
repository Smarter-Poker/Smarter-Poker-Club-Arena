# 2026-08-31 — Spins Phase 4: the wheel audits itself

Phase 4 of the Spins end-to-end audit. Phases 1-3 fixed the seat, the refund
and the animation. This one closes the check that had been done twice, by
hand, and left nothing behind.

## The gap

The Spin draw distribution had been audited exactly twice — once in the
2026-08-28 deep dive, once in the round-11 changelog. Both passed. Neither
installed anything that would notice the third time.

A skewed wheel is the worst-shaped bug in this system, because it is invisible
to a player **and** to the ledger. The money conserves. The reserve balances.
Every game pays exactly `buy_in x multiplier`, and `fn_spin_unpaid_check`
confirms it hourly. Only the FREQUENCIES are wrong, and nobody sees a
frequency.

This is not hypothetical here. Before 2026-08-22 three multiplier tables
disagreed (EV 3.00 / 2.75 / 2.24) and the one that ran was not the one that was
documented; the all-time draw data still carries a ten-sigma 2x/3x skew from
that era. `spinSpec.ts` and its byte-identical test now make the two TypeScript
copies impossible to fork. Nothing watched the copy PostgreSQL deals from.

## What shipped

`fn_spin_fairness_check(days)`, hourly on pg_cron at :28, raising into
`financial_alerts` and moving no money. Four checks, none of which anything
else looks at:

1. **Off-ladder draws** — a multiplier not on the published ladder at all.
   Zero tolerance at any volume: it means a table forked again.
2. **Distribution** — Pearson chi-square of observed tier counts against the
   published frequencies.
3. **Expectation** — the mean multiplier against 2.763773, as a z-test. A
   distribution can pass a chi-square and still drift the house edge if the
   error concentrates in the tail, which is exactly where the money is. The
   edge is therefore tested on its own terms rather than inferred from check 2.
4. **Tier locking** — the reserve gate can exclude 100x from a draw, and the
   odds sheet shown at buy-in carries no "when available" qualification. That
   is honest only while nothing is ever locked, so anything locked is a
   disclosure warning.

`v_spin_draw_distribution_7d` is the per-tier view you read to see WHY it
alerted.

## Two decisions worth recording

**The ladder now has a fourth copy, and that is a liability unless something
asserts it.** `spin_tier_spec` is what the guard measures against. A guard
measuring a stale ladder is not a guard, it is a machine for generating false
confidence — it would report the exact bug it exists to catch as "pass". So
`tests/config/spinSpecMatchesDatabase.test.ts` parses the migration and
`spinSpec.ts` and compares them row for row, and the migration itself RAISEs at
apply time if total frequency (10,000,099) or weighted units (27,638,000) move.
Verified both directions: bumping 100x from 1008 to 2008 in the migration turns
three of the five tests red; restoring makes them green.

**The rare tail is pooled, deliberately.** At a week of current volume 50x and
100x each expect ~2.1 draws. A chi-square cell with an expected count under 5
does not follow the chi-square distribution — it inflates the statistic on a
single lucky 100x and would page somebody at 3am because a player got paid.
Cells are walked rarest-first and folded together until the bucket expects at
least 5, which at present gives 6 cells and 5 degrees of freedom.

## Proven to fire, not just to pass

A gate that passes by doing nothing is a failure this repo has already
documented, so the guard was probed against production inside a transaction
that was ROLLED BACK (CLAUDE.md 11.5 — what you want from a probe is the error
message, not the side effects):

| Probe                          | Verdict                 | Detail                                                      |
| ------------------------------ | ----------------------- | ----------------------------------------------------------- |
| remove 10x from the ladder     | `off_ladder`            | 236 draws flagged, 1 alert                                  |
| swap the 2x and 3x frequencies | `distribution_critical` | chi-square 739.17 on 5 df (crit 20.515), z = -7.34, 1 alert |

The rollback held: 8 tiers, totals intact, zero probe alerts left behind.

## What the live wheel actually reads

At apply time, 21,263 draws over 7 days:

| Tier | Actual  | Spec    |
| ---- | ------- | ------- |
| 2x   | 48.211% | 47.720% |
| 3x   | 38.941% | 39.685% |
| 4x   | 9.274%  | 9.000%  |
| 5x   | 2.389%  | 2.500%  |
| 10x  | 1.110%  | 1.000%  |
| 25x  | 0.052%  | 0.075%  |
| 50x  | 0.014%  | 0.010%  |
| 100x | 0.009%  | 0.010%  |

Chi-square 10.31 on 5 df against a 0.01 critical value of 15.086. E[multiplier]
2.763251 against a published 2.763773 — z = -0.047. Zero off-ladder draws, zero
locked draws. The wheel players are sold is the wheel they get, and now
something says so every hour instead of every time a human thinks to ask.

## A predicate worth not getting wrong

`spin_type IS NOT NULL` is **not** a Spin predicate. It is also set on heads-up
sit-and-gos and on ordinary MTTs — 13,709 of them since 2026-08-22, every one
carrying `spin_multiplier = 0`. A population built on it is one third
non-Spins, and every percentage computed from it is wrong; I built one that way
first and the tier shares summed to 65%. `variant = 'spin'` is the predicate,
which is what the existing money views already use. The test pins it, and pins
that no `is_horse` filter ever appears in the guard.

## Horses

No `is_horse` filter anywhere, and no `p_include_horses` parameter to default
to true, because there is nothing to opt into (CLAUDE.md 10.5). Horses are
~all of the Spin volume; a guard that excluded them would be measuring a few
hundred draws a week and blind to the fleet the wheel actually deals to.
