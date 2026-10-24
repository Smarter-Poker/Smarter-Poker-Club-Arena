# Join Lightning goes straight to the buy-in (2026-10-24)

Dan: "WHEN YOU CLICK 'JOIN LIGHTNING' AND CONFIRM YOUR BUY IN AMOUNT, YOU ARE
'AUTO ASSIGNED' TO A TABLE AND SEAT, YOU DON'T PICK YOUR SEAT ... CURRENTLY
WHEN YOU CLICK 'JOIN LIGHTNING' NOTHING HAPPENS, IT JUST SILENTLY FAILS."

## What was read

Edge logs for Dan's session: three `fn_cash_game_join` calls (all 200) and no
`atomic_table_buyin` call at all. The join held a chair and sent the player to
`/table/:id` with no buy-in sheet. On that table the Lightning footer added in
#7894 navigated back to `/lightning/:gameId`, which joined again and sent the
player back to the same table. A loop with no buy-in in it, which reads as
"nothing happens".

## The fix

- `LightningEntryPage` sends a Lightning join to `/table/:id?buyin=1`, so the
  table's existing deep link opens the buy-in sheet on the held chair. The
  player confirms an amount; they never pick a seat.
- The Lightning footer on an anchor table (`openLightningAnchorEntry`) opens
  the buy-in on an open chair at this table when the live roster shows one,
  and otherwise goes through Join Lightning, which now always comes back with
  a buy-in.
- The database half (a full Lightning game opens a new table instead of
  queueing) is #7897's migration
  `20261024073506_lightning_join_opens_a_table_instead_of_queueing.sql`, which
  merged but had not been dispatched; it is installed through Apply Merged
  Migration.

Pinned by `tests/lightning/a-lightning-seat-buy-in-follows-the-player.test.ts`
and `tests/lightning/LightningEntryPage.test.tsx`.
