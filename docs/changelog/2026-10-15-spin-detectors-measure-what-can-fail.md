# The Spin Detectors Measure What Can Fail (2026-10-15)

Migration `20261015025123_spin_detectors_measure_what_can_fail.sql` (held for
install). Supersedes held PR #6473.

## SpinReservePoolThin

`fn_spin_metrics.reserve_thin_clubs` counted every thin reserve pool: 1,143 of
1,146 on 2026-10-15, while every Spin started in 30 days drew from one owner
pool (Midway Union, balance 50,881.24 against a 15,000.00 thin line). The draw
reads only the pool of the Spin being drawn, so a pool that hosts no Spin locks
no tier. #6473's rule (`spin_count > 0`) still counted Deep Stack Society, a
pool drained to 0 that funded 86,048 Spins and has hosted none in 30 days.

Now a thin pool is counted only when it owns a Spin started in the last 24
hours (through `fn_spin_reserve_owner`, so a union pool funding a member club
counts). The read uses `idx_tournaments_spin_unbooked_scan`: 20 ms measured.

## fn_spin_fairness_check

The check runs hourly over a sliding 7-day window, so its p < 0.01 warning
line is crossed by chance on an on-spec ladder. 2026-10-14 22:44 it raised at
chi-square 18.51 against 18.475; the 7 days before gave z -1.33, 28 days z
0.87, and 21 days of tier counts match the published ladder. A warning now
needs the preceding, non-overlapping window to cross too; an unconfirmed
crossing is reported as `distribution_unconfirmed` and not raised. Criticals
(p < 0.001, |z| > 4, off-ladder) are unchanged. The one open warning is
resolved by the migration with that measurement.

## Proof

`scripts/ci/test-spin-detectors.py` (native PostgreSQL, 25 checks) loads the
exact production definitions (md5 equal), proves both baselines page on the
harmless cases, and proves the candidate pages only on the real ones,
reproduces production's derived postimage md5, keeps every other gauge, owner,
security, settings and grants, and refuses a second run. Workflow
`.github/workflows/spin-detectors.yml`.
