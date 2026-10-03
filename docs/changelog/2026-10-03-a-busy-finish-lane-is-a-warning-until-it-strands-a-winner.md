# A busy finish lane is a warning until it strands a winner (2026-10-03)

Migration: `20261003193000_a_busy_finish_lane_is_a_warning_until_it_strands_a_winner`.
Law: `tests/a-busy-finish-lane-is-a-warning-until-it-strands-a-winner.law.test.ts`
(`docs/laws.d/a-busy-finish-lane-is-a-warning-until-it-strands-a-winner.md`).

## Incident 03f5b137 (reset the burn-in gate)

`financial_alerts:Tournament.atomic_finish_refused`, SNG 4b3f2f27 (house club
fade0000), context `proven_refusal: true`, `refusal_reason: timeout`,
`refusal_streak: 3`, `outcome_unknown: false`.

| time (UTC)  | what                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- |
| 15:33:33.8  | last elimination; event decided (2 entrants)                                                       |
| 15:33-15:36 | three finish passes refused before commit with a timeout                                           |
| 15:36:37    | streak reaches `TRANSIENT_FINISH_REFUSAL_ALERT_STREAK` (3): alert, bridge files CRITICAL `unknown` |
| 15:37:02.7  | next pass commits: COMPLETED, terminal receipt v2                                                  |

Money is whole: one payout (f916c729, 3.80, position 1) to the winner 92ecbaed;
escrow closed "terminal receipt: exact zero" (gross_in 4.00 = prize_out 3.80 +
fee_out 0.20); `chip_ledger` holds two 2.00 buy-in legs, one 3.80
`tournament_prize` leg to the winner, one 0.20 rake leg. Paid exactly once,
3.5 minutes after deciding. The house club was finishing 7-24 events a minute
(15:25-15:45) through one finish lane per bank scope; `pg_stat_statements` was
reset by the 19:12 restart, so the lock wait itself cannot be re-read, but a
proven refusal is pre-commit by definition and the next pass succeeded.

## Change

- `fn_ca_financial_alert_to_incident`: a proven, known-outcome timeout or
  deadlock finish refusal files as warning. Rule refusals, unknown outcomes and
  satellite refusals keep their severity.
- `fn_ca_tournament_finished_but_not_completed` closes such an alert when the
  tournament is COMPLETED with its terminal receipt and its escrow is closed at
  zero (prize and bounty), naming the payout rows and their sum. Until then it
  is an open unknown. A finish that never clears is paged critical by the same
  detector (15 live minutes, 45 wall-clock minutes).

Rolled-back production probe before applying: a timeout refusal filed
`warning`, an `other` refusal filed `critical`; the closer closed the timeout
probe and the real alert c3edf4fb and left the rule refusal open.

## Incident 1f6646fa (not changed here; handed to the engine-lease lane)

`fn_ca_orphaned_running_tournaments` at 16:52, 17:52 and 18:52 named one event
each time, Spin 20a7de08, and it is genuinely stranded. RUNNING since 16:26:36,
last hand 16:33:34, its tournament lease is still held by the live instance
1-14d6b5c1 but has not been renewed since 16:34:22 (the 16:34:50 DB stall), its
table has no lease, and escrow holds 500.00 prize with three players still
holding chips. The sweep did not fire on events that resumed after either
restart: every other RUNNING event holds a lease with a fresh heartbeat. The
detector is right and is not changed.
