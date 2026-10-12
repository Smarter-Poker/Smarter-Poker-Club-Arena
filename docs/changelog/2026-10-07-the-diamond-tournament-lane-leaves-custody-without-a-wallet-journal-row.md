# 2026-10-07 - The Diamond tournament lane leaves custody without a wallet journal row

Issue #6411. The same defect class as the Diamond cash rake (#6410,
`docs/changelog/2026-10-07-the-cash-rake-leaves-custody-without-a-wallet-journal-row.md`),
in the Diamond tournament lane. Read from production rows at 13:21 UTC.

## The defect, to the line

A `diamond_transactions` row is the record of a movement of
`profiles.diamonds`. Five writes put a row there for Diamonds that moved
between an entry's arena custody and the house and never touched a wallet
(line numbers are in the live `pg_get_functiondef` text):

| Leg                                         | Writer                                                                                                                         | Line |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| tournament fee (custody to house)           | `fn_poker_diamond_tournament_drain`, reached with `p_journal_for = NULL` from `fn_poker_diamond_tournament_settle_fee` line 30 | 66   |
| Spin surplus (custody to house)             | the same drain, from `fn_poker_diamond_spin_draw` line 251                                                                     | 66   |
| guarantee overlay return (custody to house) | the same drain, from `fn_poker_diamond_tournament_settle_overlay` line 118                                                     | 66   |
| guarantee overlay (house to custody)        | `fn_poker_diamond_tournament_settle_overlay`                                                                                   | 74   |
| Spin underwrite (house to custody)          | `fn_poker_diamond_spin_draw`                                                                                                   | 207  |

Each writer's own comment says the wallet does not move (`balance_after` is
the wallet as it stands). An entry's Diamonds left the wallet once, in its
`arena_deposit` row, so a fee or surplus row writes that departure twice, and
an overlay or underwrite credit writes an arrival that never happened.

**Measured.** The fee path wrote first: the Diamond Progressive Bounty 2000
completed at 13:03:21 UTC and its 800 Diamond fee settled as four -200
`tournament_fee` rows. Journal drift (`profiles.diamonds` against
`SUM(diamond_transactions.amount)`) went from 0 to 4 wallets, 800 Diamonds,
all of it those four rows. The other four kinds had written nothing. No
Lifetime VIP lot was allocated from the four rows. `register_drifts` was 0 and
the supply identity difference 0: the register burns those rows drove are
correct, because the register counts custody Diamonds as the player's.

## The fix (20261007132503)

The #6410 design, applied to the lane: the register row stays and is written
directly; the wallet journal row goes.

- The drain's house-bound arm writes a player-holder `burn` into
  `ca_mint_ledger` itself, op_id `<reason>:<custody>`, with
  `balance_before = balance_after =` the untouched wallet, and returns it as
  `register_op_id`. Its movement carries no `wallet_journal_id`. A prize or
  bounty drain (the recipient's wallet credit, `p_journal_for` given) is
  unchanged.
- `settle_fee`, the Spin surplus arm and the overlay return arm assert the
  players' retirement by those op_ids instead of through journal ids. The
  overlay return now reads `supply_after` after the drain, as the fee does.
- The overlay pay arm and the Spin underwrite arm write a player-holder `mint`
  per custody share directly; their movement and tournament-ledger rows carry
  no `wallet_journal_id`; they assert by op_id.
- `poker_diamond_movements_amount_check` admits a NULL `wallet_journal_id`
  only on the two house legs (custody to `house` by `tournament_drain`;
  `house:` to custody by `spin_underwrite` or `guarantee_overlay`). Every
  movement with a wallet on either side still requires its journal row.
- `poker_diamond_tournament_ledger_outflow` no longer requires a journal id on
  `spin_underwrite`, `spin_surplus`, `overlay` and `overlay_return` rows (house
  legs). The inflow constraint, which holds entries, rebuys, re-entries and
  add-ons to their journal rows, is untouched.
- `fn_diamond_arena_reconciliation` compares only wallet legs to the journal,
  so the four fee legs already written no longer read as
  `release_amount_mismatch`.
- `fn_poker_diamond_tournament_drain` and `..._settle_fee` are on the guard
  watchlist and are declared through `fn_ca_declare_guard_redefinition` in the
  same transaction. No guard is disabled. Each of the five functions is
  replaced only if its live md5 is the one this file was written against.

Rejected: leaving the rows and teaching readers to skip them. That is a
detector, not a fix (CLAUDE.md 10.11).

## Pins

- `tests/the-journal-explains-the-balance.law.test.ts`: all five lane
  functions are last defined at or after 20261007132503 and insert no journal
  row; the drain writes the register row with the wallet unchanged and still
  carries a prize's journal; every caller asserts by op_id; the movement CHECK
  admits a missing journal id on the two house legs only; both watched guards
  are declared.
- `tests/sql/run-diamond-tournament-lane-journal.py` (new, isolated PostgreSQL
  17, listed in `scripts/ci/run-diamond-sql-acceptance.py`): loads the five
  production pre-images (`tests/sql/diamond-tournament-lane-preimages.sql`,
  md5-pinned), reproduces the 13:03 defect, applies the migration verbatim and
  drives the fee, the overlay and its return, and a 5x and a 2x Spin through
  the real functions, a horse in every event (14 checks, including mutation
  cases proving a wallet leg without a journal row is still refused).
- `tests/a-diamond-tournament-pays-from-its-own-custody.law.test.ts`: the
  historical pin of the 2026-09-14 drain text is labelled as history.

## The damage, settled (20261007134548)

20261007132503 was merged (squash `1146f649b1`) and applied through Apply
Merged Migration at 14:14 UTC; read back at 14:15: no lane function inserts a
journal row, both watched guards declared under it, the movement CHECK
installed, identity 0, `register_drifts` 0. The board was then read again: 4
wallets, 800 Diamonds, exactly the four -200 `tournament_fee` rows, and no
other tournament-lane row of any kind.

No balance moves: the wallets are right and the journal is wrong. The four
rows stay as written (append-only); each gets one correcting `adjustment` row
of +200, keyed `tournament_lane_correction:<original id>`, marked
`journal_backfill` so the register (whose burns were correct) does not follow
it, `issuance_class 'admin'` so it never reaches the promotional earn ledger,
and positive, so it allocates no Lifetime VIP lot. Proved first in one
self-aborting `DO` block on production at 14:04 UTC: cohort 4 rows, 800
Diamonds, 4 wallets, 0 credit rows; drift 4 wallets, 800, 0 mismatched; 4
inserted; after: 0 wallets unexplained, 0 register rows followed, 0 lot
allocations, identity 0.00, 0 Diamonds of balance moved. Rolled back and
re-read: 0 correction rows remained.

Who and why: four players, every one a horse, settled exactly as humans would
be (CLAUDE.md 10.5). The Diamond Progressive Bounty 2000 charged each entrant a
200 Diamond fee inside the entry they bought from their wallet; at completion
(13:03:21 UTC) the fee moved from each entry's custody to the house, and the
drain also wrote it as a second -200 wallet spend. cyruswhitlock,
flintivorson, slatenightingale and vegadeveraux each keep every Diamond in
their wallet and get one +200 correcting ledger line for that duplicate fee
line. Nothing is taken back (10.9 rule 3).

No `financial_alerts` row exists for this defect (searched the last day for
tournament_fee, journal and diamond); nothing to resolve.
