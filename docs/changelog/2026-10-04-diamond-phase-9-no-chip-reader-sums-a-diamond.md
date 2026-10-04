# Diamond Phase 9: no chip reader sums a Diamond, 2026-10-04

Phase 9's cross-format conservation line, and the chip-leg removal line beside
it. One migration, one new CI runner, one law. Nothing is published, nothing is
deployed, and no production write was made: the migration is written, proved on
an isolated PostgreSQL 17 against production's own function text, and handed to
the owner to apply.

## What was wrong

Step 0 of [the destinations design](../DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md)
taught the hourly chip supply meter, `fn_ca_supply_snapshot`, to count no
Diamond seat, no Diamond pending add-on and no Diamond event
(`20260929160000_the_chip_legs_refuse_a_diamond_row`). It fixed that one meter.
Three other readers measure the same two pools - member wallets and every live
seat's stack - with no asset filter at all, and one of them decides whether the
hourly platform freeze conserved.

**1. The break's conservation verdict.** `fn_ca_circulation_total()` (md5
`f4a6ddceec4e02cffd220c0db26d1019`) is `sum(club_members.chip_balance) +
sum(table_seats.stack WHERE left_at IS NULL)`. Its one caller is
`fn_ca_capture_freeze_mark(text)` (md5 `fdc0550ae20fd6b10979858c7608a1ec`),
which two active cron jobs run every hour - `ca-freeze-mark-pre` at `:55` and
`ca-freeze-mark-post` at `:00` - and which writes that figure into
`ca_freeze_circulation_marks`. `fn_ca_record_break_scorecard(timestamptz)` (md5
`0d9eb4d63244cfc69879f87596439c99`) then reads the pre and post totals of one
window and decides:

```sql
v_delta := v_post - v_pre;
v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
```

So the platform's own conservation verdict for the maintenance break is
computed from one number that adds a Diamond figure to a chip figure. The
moment `cash_games_enabled` opens, a Diamond player taking or leaving a seat
between `:55` and `:00` moves `on_the_felt` in Diamonds, the difference is
compared against a chip tolerance of `max(1.0, chips * 1e-7)`, and the break is
recorded as not having conserved chips when no chip moved at all.

**2. Unexplained chip supply.** `fn_snapshot_chip_supply()` (md5
`450da5111403dde7283f46499ad8ef8a`) measures the same two pools, writes them
into `chip_supply_snapshots` as `club_wallets_total`, `table_stacks` and
`tournament_stacks`, and turns their movement into `delta_holdings` and
`unexplained_delta`. It runs: `chip_supply_snapshots` took 23 rows in the 24
hours before this was written, the latest with `table_stacks` 89,586.84 and
`unexplained_delta` 10,383.99. A Diamond seat's stack would enter
`table_stacks` and then `unexplained_delta` as unexplained **chips**. No
`cron.job` names this function; its hourly caller is outside the database.

**3. A Diamond felt under a chip total.** `fn_club_chip_circulation(uuid)` (md5
`f71a1a5f26ffc70cc639777b232635cd`) lists each club's member wallets, felt and
treasury as chips. It is per club, so it mixes nothing between assets, but it
would report a diamonds club's Diamond seat stacks in a column headed chip
circulation under a chip total. CLAUDE.md 11.5 cites this function as the one
that prints the two pools reconciliation had never looked at.

## What changed

`20261004124546_the_chip_circulation_marks_count_no_diamond.sql`. All three
readers exclude a pool that is KNOWN to be Diamond, in the shape step 0
established: `NOT EXISTS (... clubs c WHERE c.id = ... AND c.asset =
'diamonds')`. Only a known diamonds pool is excluded, so a seat whose table row
is missing, or a membership whose club row is missing, stays counted exactly as
it is counted today. `clubs.asset` is NOT NULL with a CHECK of
`('chips','diamonds')` and a default of `'chips'`, so there is no third value
and no NULL to fall through. Each function changes by asserted substitution:
the live md5 pinned, each old clause counted, and the reverse substitution
proved to reproduce the pinned text, so a drifted function aborts the migration
rather than being rewritten from this file's idea of it.

The Diamond is not dropped from the books by being dropped from the chip books.
A Diamond cash seat's stack decomposes the custody row that funded it, and the
Diamond Money Contract counts a decomposition once: `fn_ca_arena_diamonds()`
(md5 `86863a1208455e92803777829bc9a668`) counts `poker_diamond_custody`, and
`fn_ca_diamond_register_vs_supply()` closes on it. Counting the same Diamond a
second time in a chip figure is what this removes.

This is a definition change, not a repair (CLAUDE.md 10.11, 10.12). No cron, no
sweep, no backfill, and no settled row rewritten: the chip snapshots and freeze
marks already taken were taken when no Diamond seat existed, so they are
correct as they stand.

## Why nothing moves, and why it belongs before the switch

Read from production on 2026-10-04, `SELECT` only, inside `BEGIN TRANSACTION
ISOLATION LEVEL REPEATABLE READ READ ONLY`:

| Read                                                       | Value                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `poker_diamond_custody`                                    | 0 rows                                                |
| live seats in a diamonds club                              | 0                                                     |
| `club_members` rows in a diamonds club with non-zero chips | 0 (of 1 row, `chip_balance` 0.00)                     |
| diamonds clubs                                             | 1: `002c2d27-9584-4e52-835a-bb2be148fc81`, is_platform |
| `ca_arena_settings`                                        | `cash_games_enabled` false, `tournaments_enabled` false |
| `fn_ca_arena_diamonds()`                                   | 0                                                     |
| `fn_ca_diamond_register_vs_supply().difference`            | 0.00 (register 10,665,711.00)                         |
| `fn_ca_circulation_total()`                                | wallets 174,126,305.73, felt 5,842,340.25, total 179,968,645.98 |

So every figure the three readers return is unchanged by this migration, and
the migration asserts that rather than asserting about it: it reads each pool
both ways inside its own transaction and refuses to commit if any of them
differs. That is also why this belongs before `cash_games_enabled` and not
after it. Applied after the first Diamond seat, the change would itself appear
as a step in `table_stacks` and a one-off `unexplained_delta`, and the chip
figures already published would already be wrong - so the migration refuses
outright when a live Diamond seat exists, by name, rather than hiding the step.

## The proof

`tests/sql/run-diamond-cross-format-conservation.py`, a new runner on its own
isolated PostgreSQL 17 cluster, listed in
`scripts/ci/run-diamond-sql-acceptance.py` (`RUNNERS` and
`PRIVATE_CLUSTER_RUNNERS`) and in `tests/unit/diamondAcceptanceCi.test.ts` (the
explicit list, the private-cluster list and the three literal counts, now 25 /
12 / 13). Its fixtures route to the job that executes them through
`scripts/ci/classify-ci-changes.mjs`.

It loads six readers from `poker-diamond-cross-format-conservation-doors.sql`,
which is production's own `pg_get_functiondef` text, checks every one against
the md5 pinned in `diamond-cross-format-conservation-doors.manifest.json`
before a case runs, reproduces each defect as an assertion that PASSES on the
installed text, then applies the migration file itself - verbatim, with its own
md5 pins and its own closing block - and proves the figures afterwards. Thirty
checks, measured on PostgreSQL 17.11:

```
  all 6 readers are byte-for-byte the text production runs
  the three readers are service_role only, as production has them
  the fixture closes - register 107 = wallet 100 + house 0 + arena float 7
  reproduced - 900 chips and 7 diamonds on the felt summed to 907.00 in the freeze mark
  and the mark total 1157.00 is 250 chip wallet + 900 chips + 7 diamonds, in one number
  the mark carries no asset or club column to separate them afterwards
  the :55 pre mark and the :00 post mark land on one window_hour
  reproduced - 7 diamonds leaving the felt makes the break verdict say chips did not
    conserve (delta -7.00 against a tolerance of 1.0)
  reproduced - the chip supply snapshot records 907.00 on cash tables, 7 of them Diamonds
  reproduced - and the next snapshot files that Diamond as -7.00 of UNEXPLAINED CHIP supply
  reproduced - the chip circulation report gives the Diamond Arena a chip total of 7.00
  refused by name, which is the success case: a live Diamond seat already exists
  the fixture is now in production's state - 0 custody rows funded, no live Diamond seat
  the migration committed, with its own md5 pins and its nothing-moved assertions
  the freeze mark reads 250.00 + 900.00 = 1150.00, every one of them a chip
  7 diamonds leaving the felt moves the chip total by 0.00 and the break verdict holds
  the Diamond is kept and counted by fn_ca_arena_diamonds(), not thrown away
  the chip supply snapshot records 900.00 of chips and files no unexplained chip
  the chip circulation report lists the chip club unchanged and gives the arena no row
  asked for the arena by name, the chip report returns no row at all
  cash seat buy-in - identity closed, float 97, chip total unmoved at 1150.00
  cash seat cash-out - identity closed, float 7, chip total unmoved at 1150.00
  tournament entry - identity closed, float 57, chip total unmoved at 1150.00
  satellite seat - identity closed, float 57, chip total unmoved at 1150.00
  tournament fee to the house - identity closed, float 52, chip total unmoved at 1150.00
  tournament prize - identity closed, float 27, chip total unmoved at 1150.00
  spin day entry - identity closed, float 47, chip total unmoved at 1150.00
  spin day settles - identity closed, float 27, chip total unmoved at 1150.00
  the fee the house banked is 5, registered once, and the house is still one row
  eight Diamond movements across every format and not one of them is in the chip books
  both arena switches are still closed, as the fixture found them
```

The last section is the cross-format conservation line: one Diamond walked
through every format the arena deals, and after each movement the Diamond
identity still closes, the arena float has moved by exactly the amount, the
amount is a whole Diamond, and not one chip figure has moved. Those movements
are written in the shape the installed doors write them and each one names its
door; this runner does not execute the doors, which
`run-diamond-tournament-lifecycle.py` and `run-diamond-concurrency.py` do. The
claim here is that the two sides of the books agree across formats and that no
chip reader sees any of it.

Every amount in the fixture (7, 90, 1000) is a legible fixture amount. None of
them is a rate, a price, a fee or a guarantee, and nothing here approves one.

## What was checked and left alone

- **The house is one row and cannot become two.** `fn_ca_diamond_trial_balance`
  and `fn_ca_diamond_snapshot` read `ca_diamond_house WHERE id = 1` while
  `fn_ca_diamond_register_vs_supply` sums every row, which the rebuild contract
  warns about. `ca_diamond_house` carries `CHECK (id = 1)`, so the divergence is
  closed by a constraint and there is nothing to fix. The runner asserts it.
- **The tournament fee destination already works and is idempotent.**
  `fn_poker_diamond_tournament_settle_fee` (md5 `4e947c948d953098fb63c26d14decde8`)
  drains the fee parts of the custody rows, asserts the register retired exactly
  that much from the players, credits `ca_diamond_house` with one `mint` row
  reasoned "DR14 (poker_tournament_fee)", and returns early on an existing
  `poker-tournament-fee:<id>` ledger key, so a replay banks nothing twice. It
  was read, not changed.
- **`clubs.total_rake` for the Diamond Arena is 0.00** and the Diamond fee path
  never increments it: the `UPDATE public.clubs SET total_rake` in
  `fn_settle_tournament_rake` is in the chip branch only. So the four
  leaderboards that sum `clubs.total_rake` cannot see a Diamond figure.
- **`rake_records`, `rake_attributions`, `club_wallets`, `bbj_pools`,
  `bbj_contributions`, `chip_ledger`, `tournament_guarantee_overlays` and
  `tournament_tickets`** each hold 0 Diamond Arena rows and refuse one by name
  since step 0, so every `sum(rake_amount)` reader is asset-pure by
  construction.

## What this does NOT do

It does not set, approve or imply a Diamond rake percentage, a cap, a fee rate,
a jackpot drop, a guarantee or a destination. Questions B1 to B22 and A1 to A20
of the destinations design are still Dan's and are still unanswered, every
Diamond rake, insurance and BBJ path is still refused at all six layers of
`DiamondCashBoundary`, and no number was invented here.

It does not move the tournament fee off the chip settler (step 3 of the design's
section 4). `fn_settle_tournament_rake` still takes the global chip settlement
lane lock, still calls `fn_ca_begin_legacy_fee_resolution` and still writes a
`tournament_rake_settlements` row before it branches to the Diamond fee door,
and that door is still reached through it from five chip settlement callers.
That remains open.

Neither arena switch was touched. Both are false.
