# Real Player Totals: the day, the last 7 days and the month to date

**2026-10-26.** Dan: "FOR THE REAL PLAYERS TOTAL, GIVE ME A MONTH TO DATE,
WEEKLY AND DAILY COUNT."

The Real Player Totals card in the Daily Operations Digest showed one Central
day. It now shows three columns, Day / Last 7 Days / Month To Date, for real
players who played, hands, time played, won/lost (with cash games and
tournaments), rake (cash, tournaments, total) and their chip wallets.

One query over a month ran past 120 s on production, so migration
`20261026140704` keeps each day's per-player result once in
`sp_digest_player_days` and `fn_sp_digest_player_period` adds the week and month
up from the kept days. Players are a distinct count per column; wallets are the
period's players' balances at the end of the day. A day costs 3-7 s cold, so a
call keeps at most three earlier days; until every day is kept the card says how
many are still missing.

Checked read-only on production for Oct 25 before shipping: the Day column
matches the sent email exactly (27 players, 3,659 hands, 49h 20m, -2,890.48,
rake 751.45 + 50.76, wallets 5,540.42); last 7 days 44 players, 15,527 hands,
-3,124.66; month to date 44 players, 16,226 hands, -5,315.43.

The email side is World Hub `src/lib/dailyDigest` (`loadPlayerTotals` falls back
to the day alone if this function is not installed yet).

Recovery validation: the explicit-access check correctly refused inherited
service-role defaults on both snapshot tables. The migration now revokes all
service-role table privileges before granting SELECT, keeping writes inside
the existing security-definer functions. This changes no player balance.
