# Diamond Phase 7: A Diamond Table May Straddle

Status: Phase 7 In Progress. Checklist Line Three Is NOT Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## Why Straddles First

Phase 7 checklist line three covers bomb pots, board counts, straddles and run it twice. The straddle is the only one of the four that asks nothing of the chip economy, which makes it the honest place to start.

`StraddleEngine` prices a straddle at exactly `straddleMultiplier` (2) times the current blind, and every Diamond guard already refuses a table whose blinds are not whole positive integers. A Diamond straddle is therefore a whole number by construction, with no division anywhere on the path. There is no counterparty, no ledger and no obligation: the units leave one stack and enter the pot, which the accepted-hand guard already requires to be whole.

`HandController` never refused a straddle for Diamond either. It validates every straddle amount as a non-negative safe integer and says nothing more about them. Only two places refused one: the table-load boundary and the SQL admission door.

## What Changed

- `assertDiamondCashTable` drops `straddle_enabled`, `auto_utg_straddle` and `voluntary_straddle` from its refusal list. They leave that list rather than joining `explicitlyOff` because every engine read of them is truthy, so an unset column disables the feature in the engine exactly as it did in the guard. The run-it columns are the opposite and stay where they are.
- `fn_poker_diamond_buyin` drops the same three clauses (migration 20260912013000).
- `fn_poker_diamond_set_table_straddle` is a new staff door that turns straddles on for a table that already exists. The seventeen live arena tables were opened with every optional feature explicitly false, which was correct then. It carries the same authority as the creation door, `fn_is_platform_admin()`, moves no money, and refuses any table the Diamond boundary would not admit afterwards, so the flag can never be the thing that makes a table unplayable. The engine re-reads these columns on its own refresh and re-validates the row against the boundary before applying it, so a running table picks the change up without a restart.

`seven_deuce_enabled` is not a straddle and stays refused: it is a side bet paid between players at a table-configured amount, which is a separate money fact this phase has not certified.

## What The Fixture Found

Certifying this in the isolated Phase 6 Postgres fixture turned up a real defect in the door, and it was not the one being changed.

UNSET IS NOT OFF was taught to the TypeScript boundary on September 11 and never to the SQL door. A table with `run_it_twice` set to NULL passed the admission door, reserved the player's Diamonds and seated them, and would then have been refused by the engine's own table load on every attempt. Admitted, funded, seated and unable to deal, which is exactly the failure the boundary's own header was written about. `rake_cap_bb` was not read by the door at all, and its unset value is the published schedule cap for the stake, which is nonzero everywhere.

Migration 20260912014500 makes the door read all four columns the way the engine does. All seventeen live arena tables already carry explicit zeros and falses, so nothing that exists today is affected.

The fixture also had to gain the `rake_cap_bb` column itself, because its `tables` is a subset of production's. That is the same shape as the defect: a check that cannot see a column cannot refuse on it.

## Evidence

- `server/src/engine/DiamondCashBoundary.test.ts`: a straddling table is admitted with either straddle mode, an unset straddle column is admitted, and the side bet beside it is still refused.
- `server/src/engine/DiamondCashHand.test.ts`: a four-handed Diamond hand posts a whole UTG straddle, the straddle is live so the raise floor is the straddle rather than the big blind, the table conserves to the unit, and a fractional straddle is refused before anything is dealt.
- `tests/sql/run-diamond-straddle.py`: in the isolated fixture, a straddling Diamond table admits a seat and funds it from custody under both straddle modes; a side bet, an unset run-it column, an unset allow-run-it column, an unset rake cap and an unset jackpot percentage are each still refused at the door; and the staff door asks for a caller first and for staff second.

## Still Unavailable

Bomb pots, board counts and run it twice. Run it twice halves a pot, and an odd pot of whole Diamonds does not halve, so it needs an odd-unit rule certified before it can be admitted. Bomb pots ride the `p_units` award lane, which `fn_ca_commit_hand_settlement` refuses for a Diamond hand. Neither is claimed here, and checklist line three stays open.
