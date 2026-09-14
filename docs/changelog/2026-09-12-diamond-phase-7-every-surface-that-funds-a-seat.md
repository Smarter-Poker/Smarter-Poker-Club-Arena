# Diamond Phase 7: Every Surface That Funds A Diamond Seat

Status: Phase 7 In Progress. Checklist Line Two Is NOT Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## One Question, Six Places, Two Answers

`fn_poker_diamond_top_up` shipped on September 12 and gave a Diamond cash seat a funded top-up writer for the first time. The seat's own Top Up button learned about it that day. Five other surfaces did not, and they were not found by looking for them: they were found while proving, for checklist line four, that no side feature is gated on the arena asset. Reading every `arenaAsset` condition in the table page for that proof is what surfaced the ones that had gone stale.

- The multi-table tab bar's **Top Up** item. `createDefaultMenuSections` renders it unconditionally, because the tab bar cannot see the arena. The bus case behind it broke for every non-chip asset, so at a Diamond table a player tapped Top Up and nothing happened at all: no sheet, no refusal, no error.
- The tab bar's **Auto Top Up** item, which had no asset condition at all and so switched on a setting that the automatic top-up would then refuse to read.
- The **automatic top-up** itself, still `=== 'chips'`.
- The **bust prompt**, which returned for every non-chip asset on a note saying Diamond re-entry needed a new custody occupancy.
- The **confirm** behind that prompt, which calls `atomic_table_rebuy`.

Five surfaces answering one question, and the answers had drifted apart. That is a rule living in five places rather than a bug in five places.

## The Rule Now Lives Once

`seatCanAddFunds(asset, isTournament)` is in `server/src/domain/ArenaContext.ts`, the pure contract the browser and the engine already share. Every chip seat can be funded; a Diamond cash seat can, because `fn_poker_diamond_top_up` reserves into the same custody row the seat is bound to and raises `table_seats.stack` in the same transaction; a Diamond tournament seat cannot, because prize escrow is a later phase and the custody door refuses a tournament table.

All six surfaces read it. Auto top-up asks the narrower question and composes it: a cash game with a funded writer.

## The Bust Prompt Needed No New Door

The note that closed it said Diamond re-entry needs a new custody occupancy. That was true when it was written and is not true now. `fn_poker_diamond_top_up` accepts an expected stack of **zero** and reserves into the custody the seat already holds, so a felted Diamond seat re-enters through the door that already exists. Until this change the player sat at zero with no prompt and no way back in but standing up, until the sit-out sweep cashed them out.

The confirm routes by asset, because the chip RPC cannot serve this seat: `atomic_table_rebuy` debits `club_members.chip_balance` and a Diamond entitlement has no row in that table. The Diamond branch goes through the engine's add-on path instead. The player is felted, so the hand is over and the door's between-hands rule is already satisfied. One idempotency key per bust event and amount, on both paths, unchanged.

## Whole Diamonds, And The Word For What Moved

A Diamond does not divide. The custody door reserves whole units and floors anything else, so a fractional request reports one number and moves another. The automatic top-up and the bust rebuy both floor to whole Diamonds; a shortfall under one Diamond waits for the next hand. The chip arithmetic is untouched and still sized to the cent, for the reason it always was: `atomic_table_addon` stores the number verbatim and a non-cent `table_pending_addons.amount` can never be resolved against the post-commit obligation.

The automatic top-up's toast said "Chips" at a Diamond seat. It now names what moved, and says "Diamond" rather than "1 Diamonds" when one moved.

The tab bar's menu item said **Add Chips**, which was two problems in one label: it named a denomination at a table the menu cannot see the arena of, and it disagreed with the table page's own control for the same action, which has said **Top Up** on a cash seat all along. It says Top Up now. The tournament seat's own menu still says Rebuy, because that one knows what kind of table it is on.

## Pins Moved With The Code

Three existing pins named expressions this work changed, and each moved to the structure that now holds the rule rather than being widened to keep matching.

- `aDiamondSeatTopsUp` read the `canTopUpSeat` declaration for two asset literals. The rule is a pure function now, so it is asserted by CALLING it, and the table page is pinned to delegating. Its census of surfaces went from four to six, and the six are named in the test, because a count of a named set is an enumeration and a count of an unnamed one is a guess.
- `a-chip-is-two-decimals-on-every-money-path` and `a-top-up-is-charged-once` both named the single rounding expression that used to do both jobs. Both now read the declaration and assert both denominations, so "two decimals on every money path" no longer reads as an omission at a unit that has none.

## Not Claimed

Line two also covers mid-hand add-ons, waitlists, offers, seat changes, must-move and clusters. A mid-hand Diamond add-on is not a rounding problem: the deferred `zzz_diamond_seat_keeps_custody` trigger requires a Diamond seat's stack to EQUAL its custody balance at every commit, so money cannot be taken at request time and applied at the end of the hand the way `table_pending_addons` does for chips. It needs a holding lane of its own, which is separate work.
