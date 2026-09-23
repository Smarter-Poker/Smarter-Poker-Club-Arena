# The first step never ruins a bonus game, and the floor is what the player paid

Owner rulings of 2026-09-21 (Dan), R3, R6, R10, R11 and the server half of R16,
installed by `supabase/migrations/20260921203512_the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor_.sql`
as **contract 4** (`payout_version` 4). Nothing sealed before it is repriced:
every open or settled round keeps the contract it started under, and every
client mirror keeps the older verifiers by version.

## The rulings, verbatim

- R3: "The first step of a bonus game can never ruin it: the first tile
  selected in Mines must always be a diamond, never a bomb; the first street
  (Road crossing) must always be successful; the Crash ship can never explode
  until after 1.1x."
- R6: "On Plinko the player must choose how many diamonds to drop and the value
  of each drop."
- R10: "Minimum payout when they lose and get nothing goes from 0.10 to 0.50."
- R11: "Super bonus games are not factoring the double diamond add-on into the
  minimum payout requirement. A 2,500 diamond spin plus a 2,500 diamond add-on
  must have a minimum payout of 50 chips for any game."
- R16 (server part): the add-on debit must state the amount actually debited.

## The one constraint that shaped all of it

Every game keeps its long-run return at exactly 0.80 of the stake, and the edge
is charged once: every stopping point a player may choose is worth
`L + P(reach) x (prize - L) = 0.8B`. Therefore a step that is certain (P = 1)
can pay only 0.8B, or must not be a cash-out point. Each ruling was implemented
by picking the honest side of that fork.

### Mines (R3a)

The board is no longer dealt at start. `mine_cells` is sealed **empty** and dealt
exactly once, at the first pick, by `fn_choice_board_v4(server_seed,
client_seed, nonce, mines, first_cell)`: a Fisher-Yates shuffle with rejection
sampling of the twenty-four cells other than the pick, on the HMAC domain
`<client>:<nonce>:board:<first>:<cursor>`, so the board is a function of the
sealed commit and the pick and the receipt reproduces it. `fn_choice_immutable`
admits that single write and only that write: it recomputes the board from the
row's own seed and pick and refuses anything else (a forged board and a second
rewrite are both refused in the probe). The proof exposes `first_pick` and
`payout_version`.

With a safe first pick `P(survive k) = C(18,k-1)/C(24,k-1)`, so the ladder is
`prize_k = L + (0.8B - L) x C(24,k-1)/C(18,k-1)` (`fn_choice_prizes_v4`); the
first gem pays 0.80B, the second `L + (0.8B - L) x 24/18`. Keeping the old
ladder would have returned about 102% (the map's figure); this one is exactly
0.80 at every stop, proved in exact integers in the law test and to 1e-9 in
SQL. Boards are proved unbiased around every first pick (chi-square over 2,048
boards cycling the pick through all 25 cells).

### Donkey Cross (R3b)

Two candidates were on the table: skip the survival test at street one and
forbid cash-out before street two, or make street one pay 0.80x. The second was
chosen: the ladder becomes `[80,145,185,245,315,410,535,700,910,1180,1540,2000]`
(`fn_choice_ladder_v4('road')`), the survival identity then makes street one
certain for every roll with **no special case** in `fn_choice_act`, the replay
(`fn_diamond_bonus_replay`, unchanged) or the verifier, the ladder stays
monotone, the player still makes a real choice at street one (bank 0.80x or
cross street two), and it is the same shape as Mines' first gem. Every street
is exactly 0.8B under every floor.

### Crash (R3c)

`fn_crash_point_cents` floors the point at `GREATEST(110, ...)`; cash-out opens
at 1.11x on contract-4 rounds (`fn_crash_start` cap and auto-cash-out checks,
`fn_crash_decide` reads the round's `payout_version` for its floor,
`fn_crash_cashout` answers `Cash Out Starts At 1.11x`). For every x > 1.10,
`max(raw, 110) >= x iff raw >= x`, so `P(point >= x) = (0.8B - L)/(xB - L)` is
untouched and every target is still 0.8B: proved over the whole distribution in
the probe (survivors are `floor((0.8B - L) 2^48 / (xB/100 - L))` exactly; the
value of always cashing at x is within one roll's grain under 0.8B, never over)
and sampled through the real function against the closed form. The receipt now
carries `cashout_floor_cents` (111 / 101) and `crash_floor_cents` (110 / 100).
An old open round is proved to still cash out at 1.01x under its own contract.

Consequence to tell the owner: the mass that used to bust below 1.10x now busts
exactly at 1.10x. With the half floor that is 50.8% of ordinary rounds; with the
two-thirds floor (Super with the add-on) 69.9%.

### The floor (R10, R11)

`fn_diamond_bonus_floor(bet_chips, boost, paid_diamonds, rate)`:

- ordinary award: `ceil(bet x 50)/100`, half the stake (the constant 10 -> 50);
- Super award: `GREATEST(half, ceil(paid_diamonds x 100 / rate)/100)`, where
  `paid_diamonds = entry_diamonds + added_diamonds` (`fn_diamond_game_paid_diamonds`
  reads it off the starting award). Without the add-on that is the entry, half
  the doubled stake, unchanged: 25 chips on a 2,500 spin. With the add-on it is
  two thirds of the stake: **50 chips on 2,500 + 2,500**, the owner's example;
- clamped a cent under 0.80B. The probe walks every entry 25..2500 on all four
  stake kinds (ordinary, ordinary + add-on, Super, Super + add-on) and proves
  the floor is the designed value, whole cents, `5L < 4B`, and the clamp never
  binds.

The floor is stored immutably per round as before, and `payout_version` is now
a column on `diamond_choice_rounds` and `crash_rounds` (NULL for rows sealed
before today, whose version is still derived from their floor exactly as
before; new rows write 4). Plinko writes `payout_version: 4` and
`paid_diamonds` into its result.

### Plinko (R6, R10, R11)

- The drop value is the player's: `p_denom` in
  `(1,2,4,5,10,20,25,50,100,250,500)`, dividing the stake exactly, 1 to 100
  drops, **and the whole stake as a single drop is always open**, because an
  entry like 2,489 diamonds (19 x 131) has no listed value that fits a hundred
  drops and an award that cannot start strands the player's next spin. The
  quote returns `plinko_denominations` for the stake.
- The floor guards the **whole run**, never a drop, and the table follows the
  floor (`fn_plinko_table_for_floor`): the open table whose lowest slot still
  carries the floor on this stake. A floor top-up above the lowest slot adds
  expectation, so the floor must be carried by the board itself. Every
  half-floor stake (ordinary, Super without the add-on) plays the Super table
  (v4, lowest 0.52x); a Super stake with the add-on plays the new **Super
  Double** table (v6, lowest 0.72x). Diamond (v5, lowest 0.08x) closes; its
  settled batches keep their receipts.
- Super Double: `[2000,2000,1000,170,80,75,75,73,72,73,75,75,80,170,1000,2000,2000]`,
  exact 0.800000 (sum C(16,k) x m_k = 5,242,880), every slot pays, top 20x on
  the two outer slots each side (1 drop in 1,928), 10x (1 in 273), 1.7x (1 in
  59). A two-thirds floor leaves the board no room for more top weight: the
  middle seven slots hold 60,502 of the 65,536 paths and cannot pay under
  0.72x, so the ten outer slots share what is left of the 0.80.
- Rounding: each drop is still rounded to the cent by its own unbiased sealed
  draw, so the run's expectation is exactly 0.80 and the floor can only ever
  bind through cent rounding (a run of tiny drops all landing in the bottom
  slots and all rounding down), which is in the player's favour and bounded by
  the drop count in cents.

### R16 (server part)

The add-on debit row now says what it is: description
`<Game> Double Diamonds Add-On (2500 Diamonds Of A 7500 Diamond Stake)`,
metadata `add_on`, `added_diamonds`, `stake_diamonds`, `base_diamonds`,
`entry_diamonds`, `paid_diamonds`, `award_id`; the custody movement's note is
the matching `... Add-On Intake ...`. On all four games. The probe asserts, per
game: exactly one `diamond_transactions` row and one `diamond_spin_movements`
row for the add-on, the player debited exactly `added_diamonds`, an exact replay
of the start returns the receipt and debits nothing again, a wheel-funded start
without the add-on debits nothing, and every payout credits
`club_members.chip_balance` by exactly the payout with one `chip_ledger` row
(promo wallet first) and one `chip_transactions` row whose `from_promo` and
`from_bank` sum to the payout.

## What moved, and why

- `tests/the-games-never-pay-more-than-they-take-in.law.test.ts` and its
  registry entry: the Diamond-table reachability and ten-drop distribution pins
  of 2026-09-19 are re-stated per live table and per drop count (owner rulings
  R6, R10, R11 take prize mass from the top by arithmetic and give the drop
  count back to the player), the guarantee walk covers the four stake kinds,
  the choice-game identities are proved on the contract-4 forms with the first
  step certain, and a crash section proves the 1.10x floor keeps every target at
  0.80. The 2026-09-19 forms are still proved for the receipts sealed under
  them. The law no longer imports `PLINKO_DROPS`/`plinkoDenomination` from
  `bonusGameBudget.ts`; the drop constants live in `diamondBonusPayout.ts`.
- `tests/sql/diamond-bonus-fairness-audit.sql` is contract-aware: it reads
  which contract is installed and holds the draws to that contract's closed
  forms (crash targets from 1.11x, the floor read from the largest roll and
  required to be exactly the contract's, street one required certain, boards
  dealt around every first pick). The harness runs it at contract 3 and again
  at contract 4.
- `tests/sql/diamond-one-setting-super-guarantee.sql` is untouched: it runs at
  the 20260919220610 state and still pins that contract.

## Proof

- `scripts/dev/test-accounting-delivery.sh` (block `D2 bonus rules 2026-09-21`):
  applies the migration on the exact production preimages (eighteen md5 pins,
  read from production read-only and matched by the fixture chain), runs
  `tests/sql/diamond-first-step-and-paid-floor.sql` (the owner's example played
  on all four games with real wheel spins, real starts, real settlements and
  real ledger rows, plus the pure-function proofs) and the contract-4 fairness
  audit. Exit 0 end to end.
- `tests/unit/diamondBonusMinimum.test.ts`: contract-4 mirrors against vectors
  computed by Postgres, and the nine actual contract-4 receipts captured from
  the probe (`tests/fixtures/diamond-spins/first-step-postgres-receipts.json`).

## Client contract changes (for the page and service owners)

- Quotes (`fn_wheel_bonus_state` game_state): `payout_version` 4,
  `paid_diamonds`, `cashout_floor_cents` 111, `crash_floor_cents` 110,
  `plinko_denominations` (the legal drop values for this stake), `plinko_table`
  now chosen by the floor (4 or 6), `minimum_payout_chips` on the new rule.
- Plinko result: `payout_version` 4 for every run, `paid_diamonds`,
  `drop_count`; drops are the player's count; table 4 or 6.
- Choice receipts: `payout_version` 4 (a column now), `proof.first_pick`,
  `proof.payout_version`; the mines ladder and the road ladder are the contract-4
  forms; `mine_cells` is empty on an open contract-4 mines round until the first
  pick.
- Crash receipts: `payout_version` 4, `cashout_floor_cents`, `crash_floor_cents`;
  `Cash Out Starts At 1.11x`; auto cash-out from 1.11x.
- Refusal text: `Choose A Drop Value That Plays Every Diamond In One To One
Hundred Drops` replaces `Plinko Plays Ten Drops. Refresh Before You Play`.
- Mirrors: `diamondBonusFloor`, `BONUS_PAYOUT_VERSION`, `PLINKO_LIVE_TABLES`,
  `plinkoTableForFloor`, `PLINKO_DENOMINATIONS`, `PLINKO_MIN_DROPS`,
  `PLINKO_MAX_DROPS`, `plinkoDropChoices`, `validPlinkoDenomination`,
  `receiptPaidDiamonds` (diamondBonusPayout.ts); `ROAD_LADDERS_V4`,
  `CHOICE_PAYOUT_VERSION`, `roadLadder`, `minePrizeV4`, `mineBoardV4`
  (diamondChoiceMath.ts); `CRASH_PAYOUT_VERSION`, `crashPointFloorCents`,
  `crashCashoutFloorCents`, a fourth `pointFloorCents` argument on
  `crashPointCentsFromRoll` and `payoutVersion` on `verifyCrashRound`
  (diamondGamesFairness.ts). `validBonusMinimum` and `validateCrashSettlement`
  accept contract 4 and still accept 1, 2 and 3.
