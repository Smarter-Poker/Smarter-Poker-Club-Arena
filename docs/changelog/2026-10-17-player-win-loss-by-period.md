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

## Review fixes (same day)

- **Agents saw a loading mark for ever.** The list only fetched figures when the
  roster summary granted the club-wide financial view. An agent can see their
  own downline's financials without it, so those rows waited on a fetch that
  never started. The window selector and the fetch now follow any financially
  visible row.
- **Figures went stale.** A loaded window is now re-asked in full after two
  minutes (`WIN_LOSS_TTL_MS`), keeping the old figures on screen until the new
  ones land.
- `tests/components/playerCommandWalletUpdates.test.tsx` captured whichever
  broadcast channel registered last; `PlayerChangeHistory` renders inside the
  page with its own, so any page re-render handed those cases the wrong
  handler. The mock now captures only the roster's `wallet_changed` channel.

## Installation

Applied to production on 2026-10-17 at 11:12 UTC (after Dan confirmed this
session may apply production migrations), recorded in schema_migrations as
version `20261017111202`, name `player_win_loss_by_period`. Read back: the two
public functions are executable by `authenticated` and not by `anon`; the
tournament helper is executable by neither. Figures checked against direct
queries: a member's Today tournament net matched the ledger sum to the cent
(-518.10), and a cash player's Overall matched `club_member_play_totals`
(-3,180.55). `scripts/ci/schema-manifest.d/player-win-loss-by-period.json`
declares the three functions until the nightly manifest absorbs them.
