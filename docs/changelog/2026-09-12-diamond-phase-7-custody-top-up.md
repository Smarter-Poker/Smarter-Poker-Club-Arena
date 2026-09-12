# Diamond Phase 7: A Diamond Seat Tops Up From The Custody It Sat With

Status: Phase 7 In Progress. No Phase 7 Checklist Item Is Claimed Complete. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## What Was Missing

A seated Diamond player could not add to a stack. `addChips` answered them with "Diamond Add-Ons Are Not Available Yet", which was true rather than lazy: the shared chip add-on debits `club_members.chip_balance`, and a Diamond entitlement has no row in that table. The supported feature survey filed this as the one item in Phase 7 checklist line two that needs a new writer rather than a certification.

## What Changed

`fn_poker_diamond_top_up` is a new engine-only door. It reserves settled Diamonds out of `profiles.diamonds` into the SAME `poker_diamond_custody` row the seat is already bound to, and raises `table_seats.stack` in the same transaction, because `zzz_diamond_seat_keeps_custody` is a deferred constraint that holds the two equal at commit. That shape is not a preference; it is the only shape the constraint allows.

It repeats the Phase 6 admission boundary rather than trusting that the table passed it once: the arena identity, `cash_games_enabled`, the plain cash refusal list, whole blinds and buy-in band, the settled purchase lot window, unsettled Diamond debt, and the table maximum. It is idempotent on the caller's request id through `poker_diamond_movements`, and it journals an `arena_deposit` in `diamond_transactions` before it moves a balance, so the existing audit sees its evidence inside the same atomic transaction.

Two details are worth naming because getting either wrong loses money.

- `poker_diamond_lot_reservations` is keyed `(custody_id, lot_id)`, and the hand settler consumes a lot by that key. A second row for the same pair would let one loss be taken twice, so a top-up that draws on a lot the custody already holds RAISES that row's amount instead of inserting beside it.
- A top-up is a BETWEEN HANDS operation. Mid hand the engine owns the live stack and the row on disk is the hand's opening stack, which the accepted-hand settler checks before it pays anyone. The engine refuses mid hand, and the door refuses again on its own side: it is handed the stack the caller believes it is raising and fails on anything else, so a top-up that slipped into a dealt hand stops at the door rather than under the hand.

No `app.money_path` is declared. That setting exists for the seat CREATION guard; this path creates no seat and revives none, and declaring a path no guard reads would say something untrue about which door this is.

The engine's `addChips` now routes a Diamond table to `addDiamonds`, which floors to whole units, caps at the table maximum, derives its request id from the caller's attempt id so a lost response retries the same reservation, and adopts the stack the database wrote rather than the one it asked for.

On the client, the cashier opens for a Diamond CASH seat and for no Diamond tournament seat, which has no top-up writer at all. Every number the cashier offers there is whole: a typed fraction floors rather than rounding up, because rounding up would ask the custody door for a unit the player never chose and the door refuses a fraction outright. One `canTopUpSeat` decision feeds all three surfaces that open the cashier, so they cannot drift apart the way the lobby's three join controls did on September 11. Auto Top Up stays chip only: it re-reserves by itself, and no Diamond door offers that yet.

## What Is Still Honestly Unavailable

- Mid hand add-ons for Diamond. They need a Diamond pending add-on lane in `fn_ca_commit_hand_settlement`, which still refuses a non null `pending_addons` for a Diamond hand.
- Auto Top Up for Diamond.
- Bust rebuy for Diamond. Re-entry after a bust is still leave and take a new occupancy.
- Seat changes, must move and clusters, which the survey places outside Phase 7 entirely.

## Migration

`20260912004100_a_diamond_seat_tops_up_from_the_custody_it_sat_with.sql`, applied once to `kuklfnapbkmacvwxktbh` on 2026-09-12. It pins the md5 of the four Phase 6 functions it depends on and refuses to apply if any has changed, and it registers the function in `ca_money_rpc_registry` above its own `CREATE`, which that guard requires of anything that can move money.

## Evidence

- `server/src/engine/DiamondCashBoundary.test.ts`: the add-on reaches `fn_poker_diamond_top_up` and never `atomic_table_addon`, carries the expected stack, stays whole and inside the table maximum, and is refused while a hand is live.
- `tests/unit/aDiamondSeatTopsUp.test.tsx`: the cashier opens for a Diamond cash seat and not a Diamond tournament seat, a typed fraction floors, the floored amount is what is sent, and the chip cashier still works to the cent.
- `tests/a-top-up-is-charged-once.law.test.ts`: the transport sentence is now written in the seat's own unit, and the law it protects is unchanged.
