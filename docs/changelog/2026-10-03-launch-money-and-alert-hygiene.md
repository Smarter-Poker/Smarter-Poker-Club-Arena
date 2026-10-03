# Launch money and alert hygiene (2026-10-03)

Read from production 2026-10-03 07:50-08:40 UTC. Three migrations, no money moved.

## 1. The agent commission "backlog" is not one thing

`agent_commission_unsettled_rollup` (a trigger-maintained table, not a view)
showed ~2.35M owed across 239 (club, agent) pairs. It matches its definition
exactly (rows with no `settled_at` and no covering `agent_commission_settlements`
period; e.g. one Deep Stack pair 154,281.72 = 36,257.14 + 36,375.79 + 81,648.79
of three uncovered weeks), so it is not a view bug, and no settled-but-unmarked
rows exist: every paid week (08-10, 09-07, 09-14, 09-21) is covered by its
settlement rows and drops out.

| part                          | amount (08:00 UTC)                                                            | what it is                                         |
| ----------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| open week 2026-09-28 -> 10-05 | ~1.18M (JAQK 431,759.00, SHARK 344,905.36, Deep Stack 406,689.40), 3.83M rows | accruing; not due until the weekly close of 10-05  |
| pre-floor legacy weeks        | ~1.16M, ~3.6M rows                                                            | real unpaid accruals from 2026-04-28 to 2026-09-14 |

The legacy part is the residue the 2026-09-08 round-2 change already named
("239 pairs hold 1,008,358.25 of unsettled legacy commission older than any
period round 2 will ever pay"), plus Deep Stack Society's weeks of 08-31 and
09-07. No payment for it exists in `wallet_transactions` or `chip_transactions`.
The sanctioned weekly path refuses it by design (`routed_commission_historical_period_uncertified`:
union and club settlement floors are 2026-09-21 and the accrual cutover is
2026-09-17), the agent claim is retired, and `fn_accounting_legacy_certify_week`
only discharges a week recorded in `accounting_deferred_obligations` (the
pre-08-10 and 08-17/08-24 weeks have none, and the 09-02 floor decision left the
union weeks of 08-17..08-31 unsettled because their rake basis credited the
union-as-a-club). 236 of the 239 pairs are house horses; one human (kingfish)
holds 8,469.48, of which 4,913.18 is the open week. Paying the legacy part needs
a basis decision and a one-off payer like operation 19aa02d6; it is not paid
here.

## 2. Alerts

- `79cdb720` (satellite 00efaa48) and the 19 open lease-loss refusals of
  2026-10-02 22:27 are closed on their evidence by
  `20261003082013_the_launch_alerts_close_on_their_evidence`. The closer is not
  broken: its class 4 certifies only an exact original hand that later
  committed (the 309 siblings); these 19 hands never committed and stage 1 of
  `20260917044635` deliberately does not certify a rollback.
- Open Claw is not retired; three of its routes are. They are registered in
  `ca_retired_cron_jobs` by `20261003082023_three_retired_open_claw_routes_stop_reading_as_silent`
  after reading the running dispatcher. The cron rules stay: the remaining
  firing jobs are real World Hub defects (pokernews-videos missing
  content_author and RSS 404; training-cache-drift-audit statement timeout) or
  a deliberate off switch (phase9-content).
- `StatsWitnessAuditDisagrees` was the audit, not the engine: 87 of 87 button
  disagreements in an hour were TDA Rule 30 dead buttons.
  `20261003082051_the_witness_audit_knows_the_dead_button` teaches the audit
  the gap.

## 3. Deadlocks after #5926

`deadlock detected` per 10 minutes from 06:40 UTC: 1, 1, 4, 1, 1, 1, 7, 0, 1, 1
(18 in 1h50m, max 7) against 116 in 03:03-05:02 and the alert's > 10. Not
elevated. Remaining pairs: hand post-commit x hand post-commit on
`union_wallets`/`bbj_pools` (7), one tournament finish holding a
`club_members` promo row (one 07:41 burst, 7), and singles. refresh-player-stats-hourly
succeeded every hour from 04:17 (it failed 02:17 and 03:17 before
20261003032438).
