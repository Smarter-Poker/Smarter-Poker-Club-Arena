# Every Running Event Is Watched, And A Paid Satellite Is Not Reported (2026-10-08)

Part of Dan's tournament hardening order (tournaments, Spins and Sit & Gos
must self-heal, never freeze, always pay out and finish).

## Three gaps in what watches a tournament

1. **A single-winner satellite on its last player was watched by nobody.**
   `fn_ca_tournament_finished_but_not_completed` skipped satellites, and the
   dark watch needs two or more live players. Seven days of production: 12 of
   122 single-winner satellites took over 15 minutes from their deciding bust
   to completion (healthy: about 20 seconds), up to 101 minutes, none paged.
   Satellites are now in the watch (20261008150332). Together the two watches
   cover every RUNNING event of every format.
2. **A break that never ended was invisible.** The dark watch skipped every
   event with `on_break` set; on 2026-08-25 seven events carried a stuck break
   flag, one for 41 hours. An event still on break thirty minutes after its
   break started is now a dark candidate (20261008150342), so it is paged and
   the engine's dark rebuild (PR #6503) resumes it.
3. **A paid satellite was reported as unpaid every hour.**
   `fn_satellite_conservation_audit` raised 21 critical alerts in a day for
   satellites settled exactly: it read cash only from `wallet_transactions`
   and capped awards at positioned players, so a cash ticket, a bubble
   remainder and a cohort's qualifiers were all invisible to it. A satellite
   with a settlement header is now judged by the contract its receipt proves:
   payouts sum to the header pool, the payout and award counts match, the
   prize balance is zero (20261008150323). The full replay runs daily
   (`fn_ca_replay_terminal_receipts`).

## Alerts closed with evidence

56 `Tournament.atomic_finish_refused` alerts (and their drift-incident twins)
from the 2026-10-06 replica-mode session: all 32 tournaments are COMPLETED,
replay their terminal receipt clean, closed escrow at zero and paid out. Each
alert carries that evidence in its resolution.
