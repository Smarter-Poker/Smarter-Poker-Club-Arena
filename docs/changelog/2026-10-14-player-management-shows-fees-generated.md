# Player Management Shows Fees Generated, From The Fee Ledgers

Dan, 2026-10-14, on `/clubs/:club/members`: "IT SHOULD ALWAYS SHOW FEES
GENERATED, NOT WALLET BALANCES."

## What changed on the page

- Simple mode: every row's one figure is now **Fees Generated** (the player's
  own fees). An agent with a downline also sees **Downline** fees under it.
  The player wallet is gone from Simple mode.
- Advanced mode: fees lead the metrics (Indiv. Fees, Downline Fees). Wallets
  are now an opt-in column and are off by default.
- Fees under 1,000 print exactly (`feeFigure`), because `compactChips` floors
  to whole chips and a 0.50 fee read as 0.
- The role label is visible again in Simple mode. "Group By Role" ordered the
  list by a value nobody could see.
- Dormancy reads "Seen 1mo Ago" instead of a bare "1mo".
- Metric Definitions say where fees come from.

## The number itself was wrong

Read from production for Deep Stack Society (`2a1132b9-...`) before the
change:

| source | fees |
| --- | --- |
| roster (`club_roster_hand_totals`) | 675.00 |
| attributed cash rake (`ca_club_rake_daily_user` = `rake_attributions`) | 820,309.86 |
| tournament fee receipts (`accounting_tournament_fee_sources`, 400 players) | 532,750.21 |

The roster, the downline list and the player detail read fees from
hand-statistics projections (`club_roster_hand_totals`,
`club_member_play_totals`, both built from `ca_hand_facts`). They carry no
tournament fees, and they lose cash rake whenever a hand's statistics card is
absent: 300 raked hands of this club on 2026-10-03 had no `ca_hand_facts`
rows at all. Statistics are not the money ledger.

## The root fix

Migration `20261015092518_player_management_fees_come_from_the_fee_ledgers`:

- `ca_club_member_tournament_fee_daily`: per club, player and UTC day
  projection of the immutable tournament fee receipts, written by a statement
  trigger in each receipt's own transaction and backfilled under the
  trigger's lock, so every receipt is counted once. The migration aborts unless
  the projection equals the receipts.
- `ca_club_member_fee_totals(club, from, to, user)`: the one reader, cash rake
  from `ca_club_rake_daily_user` plus tournament fees from the projection.
- `ca_club_roster_rows` (page, export, filters, sorts), `ca_club_member_downline`
  and `ca_club_member_detail` (Total Fee, MTT Fee, overall or ranged) are
  patched against md5-checked preimages to read it. Hand counts stay on the
  statistics tables.

Pinned by `tests/unit/playerManagementShowsFeesGenerated.test.tsx`.

## Installed

Installed on production 2026-10-15 and recorded as version `20261015092518`;
the file was renamed from its reserved `20261015014037` to the recorded version
so the merged and installed migration ledgers agree. Read back after install:
tournament receipts equal the projection to the cent, and Deep Stack Society
reads 1,368,142.01 of fees generated (it read 675.00 before).
