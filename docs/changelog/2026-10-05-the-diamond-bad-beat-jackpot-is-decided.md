# The Diamond bad beat jackpot is decided, and its pool is player side

2026-10-05. Migration `20261005152000_diamond_bad_beat_jackpot_is_decided_and_its_pool_is_player_side`.
Law: `tests/the-diamond-jackpot-is-decided-and-never-a-chip-pool.law.test.ts`.
Fixture: `tests/sql/run-diamond-bad-beat-jackpot.py`, on isolated PostgreSQL 17.

## What this answers

B14 to B22 of `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md`, plus B12 and B13,
which no open pull request and no branch had decided. Dan, verbatim, 2026-10-05:
"NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.", answering the list that
carried these questions back to him. Under CLAUDE.md 10.8 that later explicit
owner instruction governs over the design document's earlier framing of them as
decisions he had to make. It is not a licence to invent a number: every value is
derived from what the chip estate already runs, read from production on
2026-10-05, and each row records its derivation in its own `basis` column
beside the authority quote, so no row can be read as an approval he never gave.

|     | Decision                                                                                                                                                                                                          | Derived from                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B14 | Yes, there is a Diamond bad beat jackpot. The switch ships at 0.                                                                                                                                                  | The arena is a diamonds-only clone of a chip club that runs a BBJ on every eligible cash game; the six boundary layers refuse a CHIP jackpot object because "the counterparty does not exist", which this builds. A drop can only come out of a cash pot, and `cash_games_enabled` is false.                               |
| B15 | `floor(big blind * the tier's bbj_fee_bb)` whole Diamonds. For the 17 live stakes: bb 2, 5, 10 drop nothing; 20 and 25 drop 1; 50 drops 1; 100 drops 3; up to 10000 dropping 300.                                 | The chip drop is published in big blind units, which carry no currency. The Diamond estate floors a proportional charge at the whole unit (`fn_ca_unit_floor_cents`, and the tournament fee under which a 9 Diamond entry pays nothing). A stake that drops nothing can never hit, by the chip estate's own symmetry rule. |
| B16 | nlh/flh AAAJJ; plo4/flo4 KKKK2; plo5/flo5 87654; plo8/flo8 KKKK2 on the high hand; pineapple KKKK2. No jackpot: plo6, short_deck. Double boards excluded, first runout only, strongest qualifying loser takes it. | `BBJ_QUALIFYING_HANDS` and `ca_rake_rules.bbj_ineligible_variants`, verbatim. Which hand qualifies is a property of the game, not the currency.                                                                                                                                                                            |
| B17 | To drop: a flop and 3 dealt in, no pot minimum. To hit: a pot above 10 big blinds and 3 dealt in.                                                                                                                 | `ca_rake_rules` (3 and 10) and RakeConfig.ts stating in words that the pot floor is a payout floor and never a fee gate. Nothing needed flooring.                                                                                                                                                                          |
| B18 | Three pools: 50 / 25 / 25, pivoting to 25 / 25 / 50 at 100,000 Diamonds in main. Remainder by carried residue.                                                                                                    | `ca_bbj_policy` row 1. Three pools because `fn_bbj_reseed_main_from_backup` is what survives a 100 percent hit. The remainder rule is the chip allocator's own `ca_bbj_alloc_state` residue, at the Diamond's unit, so the three always re-sum to the drop.                                                                |
| B19 | The tier's `payout_total_pct` of main (15/25/40/55/70/85), divided half to the loser, a quarter to the winner, a quarter among the rest of the table.                                                             | All six live `bbj_stakes_tiers` rows carry loser/winner/table as exactly 1/2, 1/4, 1/4 of the total. Every Diamond no floor could allocate stays in the main pool.                                                                                                                                                         |
| B20 | No seed, and no account funds it.                                                                                                                                                                                 | Measured: of the 402 rows in `bbj_pools`, the count whose balances exceed contributions less payouts is ZERO. The chip estate has never seeded a pool.                                                                                                                                                                     |
| B21 | No maximum, so no drop is turned away.                                                                                                                                                                            | The chip estate has no maximum either; the pivot is what stops main growing without bound. A maximum would have to send a drop somewhere, and ruling 21 says a platform pot never refuses a player.                                                                                                                        |
| B22 | To the surviving Diamond pool, marked `retired_settled` and naming it. If none survives, to the contributing players pro rata. Never to the house.                                                                | The one chip pool ever withdrawn did exactly that. The pool is money owed to players: 10.9 condition 3, and design rule R1.                                                                                                                                                                                                |
| B12 | No rakeback.                                                                                                                                                                                                      | Eleven tables already refuse a Diamond rakeback, agent or commission row; ruling 16; and chip rakeback is paid out of a union rake wallet that does not exist here. Answering no leaves those refusals correct rather than absent.                                                                                         |
| B13 | No VIP points.                                                                                                                                                                                                    | Chip VIP points come from a trigger on `rake_records`, a chip money table a Diamond rake must never write. The leg was never connected.                                                                                                                                                                                    |

Each lives as a row in `ca_diamond_economics`, read through `fn_ca_diamond_economic`,
which refuses an unset value by name under SQLSTATE `DE001` and never falls back to
another scope, to a chip value or to a literal. A row is never updated or deleted; a
new answer is a new row. So every number above changes by appending a row.

## What it builds

- `ca_diamond_economics` and its refusing reader. SHARED with the other Diamond
  destination lanes: it did not exist anywhere, so this creates it. Extend the
  name list and the unit table; do not replace them.
- `poker_diamond_jackpot_pools` and `poker_diamond_jackpot_ledger`. The pool is
  player-side, inside the arena float, with NO stored balance: a bank's balance
  is the sum of its append-only rows, so it cannot drift from its own history
  and no repair job can ever be needed. A unique index on
  (ref, bank, person, role) is what makes a replay pay nothing twice.
- The carried-residue allocator, the drop, the hit, the reseed and the withdrawal.
- `fn_ca_arena_diamonds()` counts the pool (design rule R5), by asserted
  substitution against md5 `86863a12...`.
- The settler's refusal of a drop becomes CONDITIONAL and RECOMPUTED, not
  removed: rake and insurance are still refused outright in the same statement,
  a drop is admitted only when the switch is 1 and the amount equals what the
  stake owes, and conservation becomes "the deltas sum to minus the drop".
  Asserted substitution against md5 `3aab9170...`.
- `bbj_pools` and `bbj_contributions` refuse a Diamond Arena row by name, in the
  `poker_arena_no_hierarchy` pattern. The other step 0 chip money tables are
  left to the rake and step 0 lanes.

## What it does not do

It opens no switch: `cash_games_enabled` stays false and `tournaments_enabled`
stays true, and the migration asserts both. It touches no engine file, so layer 3
and `applyJointDeductions` keep refusing a non-zero Diamond deduction. It writes
no Diamond rake path. It does not touch `fn_ca_diamond_trial_balance`: the pool is
owned by nobody in particular, so there is no fixture account to split it between,
and the trial balance already attributes every change in the arena float to players,
which is where the pool's Diamonds are owed.

## Proof

`python3 tests/sql/run-diamond-bad-beat-jackpot.py` stands up its own PostgreSQL 17
on a private socket, installs the production preimages of the settler and the arena
float and pins them by md5, loads the migration verbatim and unnarrowed, and then
proves through the real doors: a 300 Diamond drop out of a four-handed hand splits
150 / 75 / 75 and attributes by loss (65 / 43 / 42 of main, remainder to the largest
loser, ties by the lower user_id); the arena float does not move and no register row
is written; a replay drops nothing twice; a hit pays 105 of a 150 Diamond main pool
as 52 / 26 / 13 / 13 with the one unallocatable Diamond left in the pool; a horse
pays its share and is paid its share; a replay of the hit pays nothing; the
withdrawal moves all 196 Diamonds to the surviving pool and none to the house; and
every gate refuses by name. Two mutation tests were run: breaking the replay check
in the hit door, and discarding the allocator's carried residue. Both were caught.
