# A Rake Finding Is Measured Again From The Hand's Dealt List (2026-10-16)

Migration `20261016103238_a_rake_finding_is_measured_again_from_the_hands_dealt_list.sql` (held draft, owner installs).

## What Fired

`ledger_reconcile_log:bbj_over_spec` (15 alert rows) and `ledger_reconcile_log:over_spec` (3) kept arriving at :52 every hour on 2026-10-16, after #7034 (`20261015222121`, installed about 00:10) had fixed the Lightning writer that booked payers as `rake_records.num_players`.

## Cause, Read From Rows

- No new finding exists. The last `rake_law` row in `ledger_reconcile_log` was written at 2026-10-15 21:40; `fn_rake_law_violations` over the ten hours to 10:20 returns nothing, and the 07:50 wide run filed nothing.
- The :52 job is `fn_ca_escalate_reconcile_criticals`. It takes the newest row per entity in a 36-hour lookback and measures the entity again before filing. `fn_ca_remeasure_entity` could measure a club treasury and, since `20261009180352`, a Diamond cash table. A `rake_law` finding on a chip table was "cannot measure", so it filed the stored 2026-10-15 rows of the two Lightning pilot tables every hour, one more occurrence on each storm incident, until they would leave the lookback on 2026-10-17 at 09:40.
- `fn_rake_law_violations` priced a hand by `COALESCE(rr.num_players, length of hand_history.players)`: the copy before the witness.

Not caused by an r5 install. It is the gap the 2026-10-09 branch named.

## The Money

The 176 findings are 88 hands each (over_spec, bbj_over_spec) on "Lightning Pilot NLH 9" and "Lightning Pilot NLH 6", 2026-10-15 20:12:23 to 20:53:11 UTC. Priced with the players actually dealt in, 0 are over or under spec for rake or BBJ drop: 7.43 rake and 1.65 drop against a spec of 7.43 and 1.65, and 4.66 and 1.60 against 4.66 and 1.60. Over 72 hours the two tables' 5,874 cash hands record 149.63 of rake and drop against a spec of 149.63. Nobody was over-raked; nothing to settle.

## The Fix

1. `fn_rake_law_violations` reads the hand's own dealt list first, then the copy. On 133,614 cash hands in the 40 hours to 10:20 the two agree except on the 148 Lightning hands of 2026-10-15, so no other verdict moves.
2. `fn_ca_remeasure_entity` measures a chip `rake_law` finding again over the table's cash hands of the last 72 hours exactly as the law prices them. Any disagreeing hand keeps it critical, so a real over-rake still files on fresh numbers.

Regression: `scripts/ci/test-a-rake-finding-is-measured-again.py`, run by `.github/workflows/a-rake-finding-is-measured-again.yml` (16 checks, native PostgreSQL).
