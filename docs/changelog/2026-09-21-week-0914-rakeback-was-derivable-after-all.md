# The week of 2026-09-14 was derivable after all

2026-09-21

`accounting_deferred_obligations` carries the two rows Dan acts on when he
authorises the one-off payment for the weeks the settlement floor skips (his
decision of 2026-09-20, recorded in `union_settlement_floor.reason`). For the
week of 2026-09-14 they said **26,542.66** and they said this:

> THE PAYABLE IS NOT DERIVABLE: accounting_agreement_history holds no
> observation before 2026-09-14 12:09:27Z, so no per-player rate observed at
> earning time exists for this week. Applying current rates would be an
> assumption, not a reading. The amount owed is Dan's decision.

Both halves are wrong. The debt is **138,303.43**, and it was measurable the
whole time. The record understated it by **111,760.77**.

## The 12:09:27Z boundary bounds five hours, not the week

The week runs 2026-09-14 07:00Z to 2026-09-21 07:00Z. Agreement history begins
at 12:09:27Z, so the unobserved head is 5h06m. Measured from
`rake_attributions`, that head holds **17,048.42 of a 615,842.54 basis, 2.77%**.
For the other **97.23%** the terms in force at earning time are observed.

"Begins at 12:09:27Z" was read as "the week has no rates". It has rates for
almost all of it. The one number nobody took was how much rake sat in front of
that timestamp.

## The reconstruction is validated, not asserted

`accounting_payable_earning_sources` holds 705,112 cash rows for this week
(440,835.71 of rake) whose `contract` was captured by
`fn_accounting_earning_contract` **at earning time**. Resolving membership and
agent terms out of `accounting_agreement_history` by observation interval, and
applying the rate rule of `fn_calculate_cash_rakeback_periods`, reproduces them:

| check                              | result                                 |
| ---------------------------------- | -------------------------------------- |
| membership `history_id` mismatches | 0                                      |
| tier-2 / tier-3 amount mismatches  | 0                                      |
| `rake_credit` mismatches           | 0                                      |
| rows differing in effective rate   | 0                                      |
| rakeback reconstructed vs recorded | 97,570.32 vs 97,570.32, error **0.00** |

2,753 rows (0.39%) resolve a different tier-1 agent ROW identity - the case
`fn_accounting_agent_terms_at` resolves by identity rather than by
(club, user) - but the effective rate is identical on every one, so no money
turns on it.

All of it ran in a rolled-back transaction (CLAUDE.md 11.5): one call, one `DO`
block ending in `RAISE EXCEPTION`, the error being the success case.

## What is owed

| scope | clubs                          | rake       | rakeback       | players |
| ----- | ------------------------------ | ---------- | -------------- | ------- |
| club  | Deep Stack Society             | 238,816.96 | **44,931.08**  | 275     |
| union | Midway: Club JAQK + SHARK CLUB | 377,025.58 | **93,372.35**  | 369     |
|       |                                | 615,842.54 | **138,303.43** | 674     |

Strictly observed: **134,439.33**. The 5h06m head at the earliest observed
terms: **3,864.10**.

The commission cascade for the same week is 486,671.69 (agent 213,095.95,
super-agent 180,030.97, sub-agent 43,984.90, a third tier 49,559.87) leaving
129,170.85 of club residual. 486,671.69 + 129,170.85 = 615,842.54 exactly.
Rakeback is not additive to that: 136,840.64 of the 138,303.43 is paid by
agents out of their commission, and 1,462.79 by club treasuries.

## The head slice is an inference, and it is 2.79%

Agreement history opens with a baseline snapshot of live state at 12:09:27Z, and
`fn_accounting_terms_at` refuses any earlier instant. The first recorded
**change** to any entity is 2026-09-16 08:35:47Z, 44 hours later, so terms were
demonstrably stable for a long stretch after the snapshot - but nothing observed
the 5h06m before it. Pricing the head at the baseline is back-extrapolation.

`pending_amount` records the upper bound, 138,303.43. The band is
134,439.33 - 138,303.43 and its width is 3,864.10. The missing observation is
our defect, and CLAUDE.md 10.9 does not let a player carry the cost of our
defect.

## Why 26,542.66 was in the record

It is the sum of 866 pending `rakeback_periods` rows written by the legacy daily
path, whose cache `rakeback_daily_user` last refreshed 2026-09-17 07:29Z and
then stopped. Those rows carry 173,311.84 of a 615,842.54 basis: **28.1%** of
the week. The number was never the debt; it was whatever the stalled writer had
got through. That stall already has its hard fix in
`20260921064151_rakeback_close_refuses_a_stale_daily_cache.sql`.

## The week of 2026-09-07 is not the same, and keeps its figure

Its attribution covers **8.8%**, and agreement history begins after that week
had already ended, so every rate for it really would be back-extrapolation. Its
amounts are untouched. Only its now-false cross-reference to 2026-09-14 is
corrected, so the retracted claim is not carried forward.

## This pays nothing and schedules nothing

The floor of 2026-09-20 is Dan's and is untouched.
`fn_calculate_cash_rakeback_periods` still refuses this week
(`historical_week_before_observed_source_cutover`, its cutover is
2026-09-17 18:24:04Z), no certificate exists, and
`fn_settle_accounting_rakeback_stage` would refuse on the floor before it read
one. So nothing settles this automatically, and nothing here tries to: no cron,
no sweep, no backfill, no compensating write (CLAUDE.md 10.12). What changes is
the **record**, so that the one-off Dan authorises is for the right number.

## The 0.86

Three cash rake records at 2026-09-14 11:47:00.101111Z have no
`rake_attributions` rows: `fc3c97d1` 0.13 on Deep Stack Society, `5c13db94` 0.60
and `f4ce701b` 0.13 on the union house club. It is not a live defect - all 1,747
cash records since the week closed are attributed with no gap - and two of the
three sit on the union house club, which is excluded from attribution clubs by
design. They stay uncredited and the reason is recorded on both rows. The
rakeback they would carry is about 0.19.

## Horses

All 674 players in this basis are horses. Under CLAUDE.md 10.5 they earn and are
paid exactly as humans; none is filtered anywhere in this work, and the totals
above are the totals.
