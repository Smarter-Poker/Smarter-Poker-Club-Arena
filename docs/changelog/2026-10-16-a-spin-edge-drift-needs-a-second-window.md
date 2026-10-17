# A Spin Edge Drift Needs A Second Window (2026-10-16)

Migration `20261016172618_a_spin_edge_drift_needs_a_second_window.sql`.

## What happened

`fn_spin_fairness_check` raised a critical `expectation_drift` at 2026-10-16
13:44 (alert `fffd604c`, incident `a08c56e1`): the 7-day mean multiplier
2.7849 against the published 2.7600, z 4.52 over 87,083 draws. It was the third
Spin fairness alert in three days on the same upswing of the rare tiers (25x
89 against 64.9 expected, 50x 16 against 8.7, 100x 14 against 8.7).
`20261015025123` and `20261015215216` already made the chi-square warning and
critical wait for the preceding, non-overlapping window; the mean still raised
on one window.

## What was measured before changing anything

- All 207,564 draws in 14 days have a `spin_draw_receipts` row whose rule
  manifest is the published ladder (8% rake, frequencies equal to
  `spin_tier_spec`), provenance `at_draw`.
- Draws, receipts and `jackpot_draw` ledger rows agree (100,577 each since
  10-09): nothing drawn was deleted or redrawn. The last 24 hours of database
  logs hold no failed or timed-out draw.
- The sampler (`fn_spin_draw_multiplier`: a 48-bit `gen_random_bytes` roll over
  the cumulative frequencies), run 10,000,000 times on its own: mean 2.75932
  (z -1.3), 25x 7,495 against 7,500, 50x 1,026 against 1,000, 100x 956 against
  1,008.
- 14 days together: 2.7667 (z 1.9). The 7 days before the alert window:
  2.7532. Today's 11,667 draws: 2.7808 (z 1.4).

The house paid slightly more than the ladder for a week through a rare-tier
run the sampler produces by chance. No chips were wrong and nobody is owed.

## The fix

`expectation_drift` is raised as critical when the current window is beyond
|z| 6 on its own (a sampler fault, about one in a billion by chance), or beyond
|z| 4 and the preceding, non-overlapping window of the same length drifts the
same way beyond |z| 2. A single-window |z| 4 crossing is reported as
`expectation_unconfirmed`, not raised, as `distribution_unconfirmed` already is.
The prior mean is read only when the current window already crosses. Off-ladder,
the chi-square verdicts and their confirmations, the volume floor and alert
de-dup are unchanged. The migration closes alert `fffd604c` and incident
`a08c56e1` with this measurement.

## Proof

`scripts/ci/test-spin-edge-second-window.py` (native PostgreSQL, 20 checks;
workflow `.github/workflows/spin-edge-second-window.yml`) loads the exact
production definition (md5 `7124884d...`), proves the baseline raises a
critical on a single-window run, and proves the candidate reports it without
an alert, still raises when the prior window drifts the same way and at once
beyond |z| 6, does not confirm across opposite signs or an empty prior window,
leaves an ordinary hour and the off-ladder verdict alone, closes only the named
alert and incident, reproduces the postimage derived read-only on production
(`0e6671e8...`), keeps owner, security, settings and grants, and refuses a
second run.
