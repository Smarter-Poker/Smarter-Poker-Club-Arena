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

## Second pass: the felt is not asked which chair is free

A running physical table of a Lightning game paints a pool room's hand
(LightningObserverProjection), so every seat on it looks taken whatever is
free underneath, and a buy-in opened "on the first open seat" found none.
Migration `20261024150545` makes the join door name the chair it holds
(`seat_number`, from `fn_lightning_join_chair`: the lowest physically free
chair, stepping past earlier holds of other players), and refuses up front with
`LIGHTNING_JOINS_DISABLED` when an operator has stopped Lightning joins. The
entry page carries the chair on `?seat=`, and `handleSeatClick(seat,
{ lightningChair: true })` opens the buy-in on it without consulting the
projected felt. The anchor-table detection now requires the game's mode to be
Lightning, so a Classic must-move table keeps its waiting list and never marks
a Lightning entry intent.

Pinned by `tests/lightning/a-lightning-join-names-its-chair.law.test.ts` and `tests/lightning/a-lightning-seat-buy-in-follows-the-player.test.ts`
and `tests/lightning/LightningEntryPage.test.tsx`.

## Two more from the same audit

- Check/Fold in a Lightning room no longer folds a free check. While the hero
  owes nothing the pre-action is Check/Fold, and it now arms the ordinary auto
  check/fold; only a plain Fold facing a bet takes the immediate fast fold.
- A seated player whose pool session closed (sat out, or a disconnect) while
  the game is still Lightning is no longer told "Lightning Has Ended"; the card
  says the seat is waiting.
