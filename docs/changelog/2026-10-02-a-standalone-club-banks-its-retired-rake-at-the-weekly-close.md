# A Standalone Club Banks Its Retired Rake At The Weekly Close

**Date:** 2026-10-02
**Migration:** `20261002145829_a_standalone_club_banks_its_retired_rake_at_the_weekly_close.sql`
**Follows:** `2026-10-02-a-horse-rebuys-from-its-own-wallet-before-the-club-treasury.md`

## The Bug

Since `20260917181100` a standalone game's rake is retired at the hand, while the
standalone weekly close still pays commission and rakeback out of `clubs.chip_treasury`.
Deep Stack Society retired 989,904.00 of rake from 2026-09-17 to 2026-10-02 15:00 UTC
(cash 677,981.00, tournament fees 311,923.00) and paid 522,102.61 of commission from a
treasury that had no inflow. It is the only club with retired standalone rake.

## The Fix

- `fn_bank_standalone_week_rake(club, week)`: sums the week's retired standalone legs
  for the club (cash legs with their standalone bank receipt, standalone tournament fee
  legs) and credits the sum to the treasury through `fn_ca_fund_club`, key
  `standalone-rake-bank:<club>:<week>`. Closed weeks only; a replay is a no-op.
- `fn_process_weekly_accounting_scope`: one statement added in the standalone branch,
  inside the money block, before round 2. Preimage md5 pinned, anchor counted, postimage
  asserted (length +80, EXIT rule present). Nothing else changes.
- No per-hand `clubs` write: the lock removed by `20260929040413` stays removed.

## Backlog

Banked once, from the same ledger proof, for the closed weeks whose commission the
treasury already paid:

| Week               | Cash rake  | Tournament fees | Banked     |
| ------------------ | ---------- | --------------- | ---------- |
| 2026-09-14 (from 09-17 18:11) | 185,562.68 | 52,545.90 | 238,108.58 |
| 2026-09-21         | 279,799.97 | 89,356.54       | 369,156.51 |
| Total              |            |                 | 607,265.09 |

Week 2026-09-28 (382,640.81 retired by 15:00 UTC on 2026-10-02) is banked by its own
close on 2026-10-05 (cron 272 at :40 after 09:00 UTC), before its round 2. Rake before
`20260917181100` was already credited per hand and is not touched. The two direct
top-ups of 2026-10-02 (49,255.53) stay recorded.

## Bridge Funding

None minted. Measured need before each club's next inflow: Deep Stack Society holds the
backlog bank; Club JAQK (44.76) has no open guaranteed tournaments, no treasury outflow
outside its weekly close in 30 days other than horse rebuys, and its smallest horse
wallet is 12,353.18, so horse rebuys no longer reach its treasury. Its next inflow is
the union close on 2026-10-05, which credits it before it pays commission.

## Verification

Production probe in one self-aborting DO block: week 09-14 banked 238,108.58, week 09-21
369,156.51, treasury +607,265.09, register +607,265.09, replay no-op, the open week
refused; `fn_ca_fund_club` passed every deferred constraint under
`SET CONSTRAINTS ALL IMMEDIATE`.
