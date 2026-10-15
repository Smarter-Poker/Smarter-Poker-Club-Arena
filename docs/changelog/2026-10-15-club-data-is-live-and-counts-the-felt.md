# Club Data Is Live And Counts The Felt (2026-10-15)

Dan, 2026-10-14: "THE DATA PAGE IS NOT ACCURATE, AND THE UI NEEDS TO BE IMPROVED TO BE MORE 'POKER BROS' STYLE AND SIMPLICITY. MAKE SURE THAT ALL THE DATA IS REAL TIME ACCURATE DATA."

## What Was Wrong (Read From Production, 2026-10-15 00:59 UTC)

1. Cash figures were up to an hour old. Tournament fees and prizes reached `ca_club_tournament_daily` by trigger as they landed, but cash rake, buy-ins and cash-outs reached `club_table_daily` only through `fn_club_table_daily_refresh_day`, run by `club-rake-rollup-catchup` at :25 each hour. The last cash rollup write was 00:25 while cash hands were being raked every second.
2. Cash winnings counted chips on the felt as losses. `club_table_daily.net` is cash-outs minus buy-ins, so a seated player's stack was a loss until they stood up. SHARK CLUB showed -120,379.07 cash winnings for 2026-10-14 on 14,707.89 of fee while 53,904.92 sat on its players' seats.
3. The screen itself was a 4,000-line operator console. Dan asked for the PokerBros layout: date bar, 1 / 7 / 14 days, four totals, search, game and stakes filters, the games.

## What Changed

Migration `20261015010318_club_data_is_live_and_counts_the_felt.sql`:

- `trg_ca_reporting_rake_insert` now writes each raked cash hand into `club_table_daily` through `fn_ca_club_table_daily_add_rake`, with the rebuild's exact attribution (first union club, else the table's club; a hand with no usable contribution goes to the table's club whole). Contributors are kept in `ca_club_table_player_daily` so the player count matches the rebuild.
- `trg_ca_reporting_wallet_insert` now writes cash buy-ins, add-ons, rebuys, refunds and cash-outs into `club_table_daily`, in its own block so a failure never costs the player rollup.
- `fn_club_table_daily_catchup` walks complete days only; the live day is the triggers'. `fn_club_table_daily_refresh_day` also rebuilds the contributor set and merges additively, so a trigger that commits while it runs is kept.
- `ca_club_data_snapshot` adds every seated club player's live stack (`fn_ca_club_cash_felt`, seats taken inside the window, same filters as the list) to cash and total winnings, to the previous window, and to each cash row, which is marked `live` with its seated count.

No trigger was created or dropped and no hot table was altered: only function bodies changed, so `rake_records` and `wallet_transactions` take no lock from it.

Client: `src/pages/club/ClubDataSimplePage.tsx` is the screen at `clubs/:clubId/data`. One read, re-run every 15 seconds on 1 Day and every 60 seconds on 7 / 14 Days, and on returning to the tab. A failed read keeps the last good figures and says so. The full operator report (union statement, player breakdown, export) moved to `clubs/:clubId/data/advanced`, linked from the header.

Pinned by `tests/club-data-is-live-and-counts-the-felt.law.test.ts` and `tests/components/club-data-simple-page.test.tsx`.

## Installing

After merge, the migration is applied once with `apply-merged-migration.yml` (migration `20261015010318_club_data_is_live_and_counts_the_felt.sql`), and the migration's last statement rebuilds today's cash rows from the ledger inside the same transaction, so the live day starts exact. Days are UTC, like every statement on the platform.
