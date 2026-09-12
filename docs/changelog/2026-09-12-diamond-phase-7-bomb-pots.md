# Diamond Phase 7: A Diamond Table May Bomb

Status: Phase 7 Checklist Line Three Is Complete. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## The Contradiction

A bomb hand that paid anybody **must** carry its per-pot award breakdown: since `20260906143315` the database refuses a bomb hand that distributed chips and carries none. The Diamond branch of `fn_ca_commit_hand_settlement` refused the opposite, any hand that carried one.

Together those two rules made a Diamond bomb pot a hand that could be dealt and could never be committed. Not a missing feature. A trap.

`bomb_pot_award_units` is a breakdown, not a movement: it records which winner took which slice of which pot on which board, for the client's ship sequence and for audit. The money itself moves in the stacks, which the commit already holds to whole Diamonds. So the Diamond rule became the same rule the commit already applies to every other amount on the hand: each unit's amount must be whole.

## What Changed

- `fn_ca_commit_hand_settlement` accepts a Diamond hand's award units when every amount is whole (migration `20260912041500`).
- `fn_poker_diamond_buyin` drops `bomb_pot_enabled` from its refusal list and gains two rules in its place (migration `20260912043000`).
- `assertDiamondCashTable` does the same on the engine side.
- `HandController` no longer refuses a Diamond hand with a bomb pot, and the bomb ante now rounds to the table's own unit rather than to the cent.
- `fn_poker_diamond_set_table_bomb_pot` is the staff door, the third of its family. It writes every bomb column so nothing is inherited, clears any variant override, refuses an ante that would not be whole, and moves no money.

The multi-board settlement needed nothing. `HandController` has cut its per-board shares in the table's own unit since the tournament fix, and passes that unit to `determineWinners` on every board, so one, two and three board bombs all divide in whole Diamonds by the same rule run it twice does.

## Two Things About The Row Are Still Refused

Either one deals a hand the rest of the boundary then rejects, and a table that deals a hand it cannot settle is worse than a table that never deals.

**An ante that is not a whole Diamond.** The multiplier slider steps by 0.5, so 1.5 times a one Diamond blind is one and a half Diamonds. Worth recording: `bomb_pot_ante_multiplier` is an INTEGER column, so the fractional multiplier cannot reach the database at all; that risk lives entirely on the engine side, where the config is a plain number. `bomb_pot_ante_fixed` is numeric and can be fractional, and a multiplier of zero antes nothing. All three are refused, on both sides.

**A bomb variant override.** `bomb_pot_variant` lets an NLH table deal PLO bombs, which is the classic bomb pot, and it is refused for the same reason `plo4` is refused on the table itself: no variant beyond NLH is certified for Diamond yet. An override the scheduler would IGNORE is refused too, because a column that says one game while the table deals another is a lie whichever way the engine resolves it.

Both rules bind only while `bomb_pot_enabled` is true. A stale multiplier on a table copied from a template is not a reason to refuse the table.

## Why These Migrations Edit The Live Definition

`fn_ca_commit_hand_settlement` is 34,418 characters and every chip hand in the estate settles through it. Restating the whole body to change three lines means retyping 34KB by hand, and a single character wrong anywhere in it is an estate-wide outage that no test on the changed clause would catch.

So the body is not retyped. It is read from the live function with `pg_get_functiondef`, the one clause is replaced in it, and the result is re-created. The preflight pins the md5 of what the migration is allowed to start from, the replacement must match exactly once, the function must actually change, the new clause must be the one written in the migration, and the refusals the branch already carried must still be present afterwards. The edit is exact by construction rather than by proofreading, and the migration file records which clause moved instead of burying it in a 34KB diff.

Measured afterwards: the function grew by exactly 136 characters, which is the difference in length between the old clause and the new one.

## Evidence

- `server/src/engine/DiamondCashHand.test.ts`: a Diamond bomb pot deals over one, two and three boards and on a fixed ante, every player antes the same whole number, the pot is that ante times the field, and the table conserves to the unit. A 1.5 multiple of a three Diamond blind rounds to a whole Diamond rather than a fraction; the chip bomb ante stays on the cent.
- `server/src/engine/DiamondCashBoundary.test.ts`: seven bombing shapes admitted, four refused, and the bomb columns say nothing while bombs are off.
- `server/src/engine/DiamondTableConfigurations.test.ts`: bomb pots join the permitted shapes, including all three board counts and a table with every arena feature on at once, across all four live statuses and all seventeen stake rungs.
- `server/src/engine/aDiamondTableKeepsItsBoundaryWhileItRuns.test.ts`: a bomb pot lands on a running table without a restart; a bomb pot with a bad ante or a variant override does not.
- `tests/sql/run-diamond-bomb-pot.py`: in the isolated fixture, a bombing table admits and funds a seat, three boards are admitted on the same terms, four bad bomb rows are refused at the door with their own error, a stale bomb column on a table that is not bombing refuses nobody, insurance is still refused, and the staff door asks for a caller first and staff second.

## Phase 7 Line Three Is Complete

Bomb pots, board counts, straddles and run it twice: all four are reusable at a Diamond table, each behind its own Diamond tests, and each refusing the row shapes it cannot honour. No variant beyond NLH is admitted by any of them.
