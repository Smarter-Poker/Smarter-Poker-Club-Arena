# Win / loss on Players and the Player Record (2026-10-17)

Dan 2026-10-16:

> WHEN YOU ARE ON THE "PLAYERS" OR PLAYER MANAGEMENT, YOU SHOULD BE ABLE TO SEE
> THERE OVERALL WIN LOSS NUMBERS, AS WELL AS BROKEN DOWN BY DAILY, WEEKLY
> MONTHLY ETC. CURRENTLY THAT DOESN'T EXIST.

## What shows

- **Player Record**: a Win / Loss card first in the ledger grid with Today,
  This Week, This Month and Overall. Each prints the net (cyan up, red down)
  and its split, "Cash +X / Tournaments -Y".
- **Players list** (Simple and Advanced): a Win / Loss window selector beside
  Sort (Overall, This Month, This Week, Today) and the net on every row the
  viewer may see financials for. Rows ask for their figures after the roster
  page arrives, a batch of up to 100 at a time, and every window already loaded
  is kept.

## What the numbers are

`supabase/migrations/20261017035934_player_win_loss_by_period.sql` adds three
read-only functions:

- **Cash** is signed cash hand results after rake, from the same exact sources
  the record already reads: `club_member_play_totals.net` (Overall) and
  `club_member_daily_facts.net` with `NOT is_mtt` (dated windows). Checked on
  production: lifetime totals equal the summed daily facts to the cent.
- **Tournaments** is money, not tournament chips: posted `chip_ledger` legs
  between the player's wallet and a tournament prize pool in this club.
  Prizes, bounties and refunds count up; buy-ins (fee included), rebuys and
  add-ons count down. The record's existing "MTT Winnings" is tournament-hand
  CHIP net and is deliberately not used.
- **Net** = Cash + Tournaments. Windows are UTC days (the facts table's own
  buckets); the week starts Monday.

Access is the record's: `ca_club_roster_access` in staff, downline or service.
The tournament helper is not granted to `authenticated`.

Measured before writing: Overall tournament net for the heaviest tournament
player of the day took 159 ms.

Tests: `tests/components/PlayerWinLoss.test.tsx`.
