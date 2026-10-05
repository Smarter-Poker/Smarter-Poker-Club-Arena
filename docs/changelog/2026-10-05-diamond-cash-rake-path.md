# The Diamond cash rake has a price, a ledger and a destination — 2026-10-05

Phase 9 line (b) of the Diamond build programme, the cash-game half:
"Implement rake/fees/BBJ destinations only in Diamond accounts, where approved."

Migration `20261005183028_diamond_cash_rake_reads_the_owner_settings`.

## First, what went wrong, because it is the most useful thing here

`20261005151712_diamond_cash_rake_economics_and_accrual` merged and then
**refused itself on apply, committing nothing**:

```
ERROR 42P13: cannot remove parameter defaults from existing function
HINT: Use DROP FUNCTION fn_ca_diamond_economic(text,text) first.
```

That file built `ca_diamond_economics` and its reader itself, because the table
did not exist when it was written: `to_regclass` was NULL when production was
read at 15:00 UTC. While it sat in CI, the A-lane applied
`20261005151918_diamond_economics_records_the_owner_answers` at 17:25 UTC and
built the same table - better, and with a reader whose `p_scope` carries a
DEFAULT. `CREATE OR REPLACE` cannot drop a parameter default, so the transaction
rolled back.

Two lanes answering one design built one table twice, and PostgreSQL caught it
at the only moment that mattered. **Nothing was applied**: no row, no table, no
function and no grant of that file ever reached production. It now carries
`-- SUPERSEDED BY 20261005183028` and `THIS FILE MUST NEVER RUN`, and is kept
rather than deleted so the record of what was attempted stays readable.

The successor does what the lane was told to do and the first attempt could not:
it **extends** the table that is there. It creates no settings table, no reader
and no name list. The A-lane's closed name list already held a slot for every
one of B4 to B13 - it was written with these questions in mind - so the fourteen
answers go into those slots, in that list's own vocabulary, and the doors read
its readers. One place for every Diamond number, one spelling, one refusal.

## What was decided, and on whose authority

`docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md` section 1 calls B4 to B13 "The
Decisions Dan Must Make" and proposes no value. Dan answered the whole list on
2026-10-05, verbatim: "NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO."
Under CLAUDE.md 10.8 that later explicit instruction governs over the design's
earlier framing. It delegates the decision; it does not license inventing a
figure, so every number below is derived from what the platform already runs and
records its own derivation in its own column.

| #   | Question                    | Answer                                                             | Derived from                                                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| B4  | Is Diamond cash rake taken? | Yes                                                                | The arena is a diamonds-only 1:1 clone of a chip club, and every chip cash pot is raked                                  |
| B5  | Percentage per stake        | 10 percent, every stake                                            | All 19 chip schedule rows and all 6 `ca_rake_tier` rows read `rake_percent = 10`; Dan, 2026-08-27                        |
| B6  | Cap per hand per stake      | The chip cap at the same rung, in Diamonds (30 to 2000)            | Every live Diamond stake IS a chip schedule row read in the indivisible unit                                             |
| B7  | Two and three dealt in      | Two: 5 percent and half the cap, floored. Three: the ordinary rule | Dan's heads-up 5 percent is unit-free; the chip cap multipliers are not, and the three-handed one is gated on nine seats |
| B8  | Pre-flop hand raked?        | No                                                                 | `RAKE_SPEC.rules.noFlopNoDrop`; Bible V8 2.9; Dan, 2026-08-29                                                            |
| B9  | Smallest raked pot          | No separate minimum                                                | The chip rule has none; the whole-Diamond floor makes a pot under 10 pay nothing by itself                               |
| B10 | Rounding                    | Down                                                               | `fn_ca_unit_floor_cents` and the Diamond tournament fee both floor                                                       |
| B11 | Destination                 | `ca_diamond_house`                                                 | The only platform-owned Diamond account, and where the Diamond tournament fee already lands                              |
| B12 | Rakeback                    | None                                                               | The database refuses every rakeback record for the arena (`poker_arena_no_hierarchy`); ruling 16                         |
| B13 | VIP points                  | No                                                                 | Chip VIP points come from a trigger on `rake_records`, which this migration makes a refusal for the arena                |

**The derivation in one sentence.** The seventeen live Diamond cash tables are
dealt at 1/2 through 5000/10000 in whole Diamonds, and every one of those
seventeen blind pairs is a chip schedule row read in cents: chip $0.01/$0.02 is
1/2 cents, chip $50/$100 is 5000/10000 cents. The two ladders are the same
ladder with the indivisible unit swapped, so the chip cap carries exactly and
carries whole — the chip caps in cents are 30, 75, 150, 300, 500, 750, 800,
1000, 1250, 1500 and 2000, every one an integer. Nothing was rounded except one
heads-up half (bb:5, 75 to 37.5, floored to 37 by B10).

## What was built

- **65 answer rows in the shared `ca_diamond_economics`**: the eleven scalars
  above plus the cap ladder, 17 stakes by three dealt-in brackets. Each carries
  Dan's quote and its own derivation, and each sits beside the A-lane's line (a)
  answers in one table. The dealt-in bracket is part of the **name**
  (`cash_rake_cap_heads_up`), not the scope, because that table's scope grammar
  is `all` or `^bb:[0-9]+$` and nothing else - which is a better shape than the
  one the superseded file invented, because it keeps a stake key a stake key.
  An unset value refuses as `diamond_economics_unset:<name>/<scope>` under
  SQLSTATE `PDE01`, the A-lane's, and the reader never falls back from a stake
  to `all`.
- **`ca_diamond_rake_accrual`**, append-only, swept once, counted by
  `fn_ca_arena_diamonds()` while unswept (design R5) and excluded once swept.
- **The settler** recomputes the rake from the Diamond settings and refuses the
  engine's number by name when they disagree. Conservation becomes "the stack
  deltas sum to minus the rake and the drop". Attribution is
  WEIGHTED_CONTRIBUTED with a stated remainder rule: floor of the proportional
  share, then one Diamond each to the largest remainders, ties by `user_id`
  ascending — and the shares are asserted to sum to the rake on every hand.
- **`fn_ca_diamond_sweep_cash_rake`**, which crosses the accrued rake to the
  house by design R2: one payer spend row per payer, one house `mint`, the
  register checked to have retired exactly the swept amount from the payers, and
  the identity asserted whole afterwards. **One house write per sweep, not per
  hand** (design R4) — which is the answer to the rebuild contract's warning
  that `ca_diamond_house` is one row and "it will jam the day rake starts
  flowing". **No cron is installed.** The sweep is the product's own design for
  a per-hand amount, not a repair loop (CLAUDE.md 10.12).
- **The chip-table fence**: `rake_records`, `rake_attributions`,
  `rake_distribution_legs` and `club_wallets` refuse a Diamond Arena row with
  "Diamond Rake Is Never A Chip Rake Record". All four held zero such rows when
  measured. This is what makes B13 no by construction rather than by convention.
- **`fn_diamond_kind_bucket`** gains the `cash_rake` kind with its own bucket and
  its own Title Case label, "Diamond Arena Rake". Measured first: the kind
  resolved to `other_spent`, labelled "Other", which section 2.7 of the design
  says a new Diamond journal kind must never do.

## The one gap the design left, and how it was closed

Section 7 of the design listed as unverified: "The settler's recomputation of
rake assumes the accepted hand row carries whether a flop was dealt and how many
were dealt in; the row's exact fields for that were not read." They were read.
It does not: `p_stacks` carries `user_id`, `seat_id`, `seat_joined_at`,
`stack_before` and `stack`, and the router forwards it unchanged.

Rather than thread a new parameter through the chip commit doors for a Diamond
feature, the facts ride on the payload the router already forwards: each element
gains `contributed`, `dealt_in` and `hand_saw_flop`. The last is a fact about the
hand rather than about a player, and the payload is an array, so it rides on
every element and they must agree — a payload that disagrees with itself about
one hand is refused, not resolved.

**They are required whenever the rake switch is on, not merely when the rake is
non-zero**, because a zero nobody can verify is not a verified zero. The
consequence is deliberate: the engine must learn to send those three keys before
`cash_games_enabled` is opened, or every Diamond cash hand refuses by name.

## What was deliberately not touched

- **`cash_games_enabled` stays closed.** The migration reads it and refuses to
  commit if it is open. `tournaments_enabled` stays as found (true).
- **The jackpot amount stays held at zero.** B14 to B22 and the Diamond jackpot
  pool are the BBJ lane's; the settler still refuses a non-zero `p_bbj` by name.
- **Insurance stays refused**, for ever.
- **Boundary layers 1 and 2 are unchanged**: the Diamond table rows keep
  `rake_percent`, `rake_cap_bb` and `bbj_percent` at an explicit 0, so no chip
  schedule can reach a Diamond table. The Diamond rake is read from
  `ca_diamond_economics` and from nowhere else.
- **The engine side (layers 1, 3 and 4) is not built.** No Diamond cash hand can
  happen while the switch is closed, and the settler is the authority that
  recomputes; the engine arm is the next step, and it must land before the switch
  opens.
- **Five of the design's nine step-0 fence tables** (`bbj_pools`,
  `bbj_contributions`, `chip_ledger`, `tournament_guarantee_overlays`,
  `tournament_tickets`, `accounting_payable_earning_sources`) belong to the lanes
  that need them. Adding them is additive: one trigger per table, the same
  function.

## How it was proved

`tests/sql/run-diamond-cash-rake.py`, a private-cluster runner on isolated
PostgreSQL 17: **48 checks**, through the real doors, never production. The shared settings table is loaded from the A-lane's own migration text, narrowed to its sections 1 to 6 (its section 7 pins tournament doors this fixture does not hold), with the cut asserted so it cannot silently stop matching.

The installed settler (md5 `3aab9170062e97840afc7d15999691ad`) is loaded from
production's own `pg_get_functiondef` text and the BEFORE cases prove it refuses
any rake at all, so the change is measured against what the estate runs rather
than against a stub. The migration is then applied verbatim, with its own
closing assertion blocks, and the AFTER cases play raked hands at two stakes and
three dealt-in brackets, replay them, sweep them twice and assert the identity
closes at every step: custody 5960 plus accrual 40 is the same 6000 float; after
the sweep, float 5925 plus house 75 is still 6000, difference zero.

Ten cases exist only to prove an assertion asserts, and an error is the success
case in each: 41 and 39 where the settings say 40; a hand with no facts; an
unverifiable zero; a payload that disagrees with itself about the flop; a loss
larger than the contribution claiming to explain it; deltas that conserve to
zero while a rake is claimed; a jackpot drop; insurance; and a Diamond stake
nobody priced, which refuses with `diamond_economics_unset` by name rather than
borrowing another stake's cap.

Two of them are about horses (CLAUDE.md 10.5): a horse at the table is
attributed its share of the rake exactly as the three humans are, and has its own
spend row in the sweep. The law test asserts no `is_horse` appears in the
settler, the sweep or the float — and the law was itself mutation-tested: with
one reader call replaced by the literal `10`, it fails.
