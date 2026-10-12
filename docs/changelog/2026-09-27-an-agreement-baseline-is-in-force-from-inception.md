# An agreement baseline is in force from inception

2026-09-27. Migration `20260927221954_an_agreement_baseline_is_in_force_from_inception`,
law `tests/an-agreement-baseline-is-in-force-from-inception.law.test.ts`,
native proof `scripts/dev/test-accounting-agreement-history.sh`,
resolution runbook `docs/runbooks/2026-09-27-held-tournament-fees-resolution.sql` (not executed).

## What was wrong

18 completed tournaments hold 741.86 chips of fees in
`accounting_tournament_fee_custody_obligations` with
`tournament_fee_sources_require_reconciliation` (held 09-18..09-21): 9 Midway
Union events, 405.60, and 9 Deep Stack Society events, 336.26. 181 positive
fee records (199 contributor charges) were made between 2026-09-05 and
2026-09-14 04:51Z, before `accounting_agreement_history` took its baseline
snapshot at 2026-09-14 12:09:27Z. Every agreement reader asked for the row
observed at or before the charge, so none existed: the recorded-evidence
capture died in `fn_accounting_earning_contract` (`accounting_terms_not_observed`,
`cash_commission_earning_club_not_observed`) and the net plan parked the fee.

## The rule (Dan, 2026-09-27)

A baseline is in force from inception. If a key has no row at or before the
instant and its earliest row is its `baseline` row, that row answers. A key
whose first row is an INSERT/UPDATE/DELETE stays unobserved before that write.

## Why five functions, not two

- `fn_accounting_terms_at` and the union_clubs lookup in
  `fn_accounting_earning_contract` were the named refusals.
- `fn_accounting_agent_terms_at` finds an agent identity from history rows at or
  before the charge. 196 of the 199 contributors name an agent, so without it
  the contract still raises `accounting_terms_not_observed`.
- `fn_accounting_union_earned_plan` refuses any union agreement whose
  `observed_at > terms_at` (`union_earning_agreement_unverified`), and
  `fn_calculate_cash_rakeback_periods` joins membership/agent receipts only when
  `observed_at <= agreement_at` (`period_membership_contract_invalid`). Both
  would refuse the receipts the fixed producer writes, blocking the Midway
  weekly close and three clubs' rakeback for the week the fees are recognized.

## What cannot change

The new branch fires only before a key's first row; every first row is at or
after 2026-09-14 12:09:27.737Z. Measured read-only on production: 0 of 130,936
tournament fee contracts, 0 of 1,691,545 cash rake contracts and 0 of 1,820,413
payable earning sources have `terms_at` before the last baseline row
(12:09:28.153Z); 0 rake records fall inside the baseline window. Every
evaluation that now resolves raised before (or, in the preview
`fn_cash_rakeback_period_basis`, was counted `missing_terms`; the calculator
still refuses historical weeks). 30 REGISTERING sng/spin events hold 113.92 of
pre-baseline fees; when they complete they will now settle instead of going to
custody.

## Dry run (read-only, reproduced 373/373 recorded contracts exactly first)

| Event                       |    Net | Agent commissions | Bank                  |
| --------------------------- | -----: | ----------------: | --------------------- |
| Midway: Midweek Mystery     | 120.00 |             90.25 | union rake wallet     |
| Midway: Turbo Tuesday PKO   |  69.00 |             53.36 | union rake wallet     |
| Midway: Monday Knockout     | 127.50 |             96.47 | union rake wallet     |
| Midway: Midweek Bounty      |  54.00 |             40.61 | union rake wallet     |
| Midway: 5 Chip Spin NLH     |   1.20 |              0.73 | union rake wallet     |
| Midway: 20 Chip Spin PLO4   |   4.80 |              3.53 | union rake wallet     |
| Midway: Early Bird Freeroll |   2.70 |              2.08 | union rake wallet     |
| Midway: 10 Chip Spin PLO6   |   2.40 |              1.76 | union rake wallet     |
| Midway: 100 Chip Spin PLO5  |  24.00 |             17.61 | union rake wallet     |
| DSS: Monday Knockout        | 127.50 |            108.42 | standalone retirement |
| DSS: Midweek Mystery        | 120.00 |            103.67 | standalone retirement |
| DSS: Midweek Bounty         |  54.00 |             45.61 | standalone retirement |
| DSS: Breakfast Turbo        |  17.00 |             14.70 | standalone retirement |
| DSS: 2 Chip Spin PLO4       |   0.48 |              0.43 | standalone retirement |
| DSS: 1 Chip Spin PLO4       |   0.24 |              0.21 | standalone retirement |
| DSS: 20 Chip Spin PLO6      |   4.80 |              4.12 | standalone retirement |
| DSS: 50 Chip Spin PLO4      |  12.00 |             10.79 | standalone retirement |
| DSS: 1 Chip Spin PLO5       |   0.24 |              0.21 | standalone retirement |

Midway 405.60: Club JAQK gross 192.60 and SHARK CLUB 213.00 at
club_commission_rate 0.9, so the weekly close pays JAQK 173.34, SHARK 191.70
and the union keeps 40.56; agents are paid 306.40 out of the clubs' share.
DSS 336.26: agents 288.16, club residual 48.10.
