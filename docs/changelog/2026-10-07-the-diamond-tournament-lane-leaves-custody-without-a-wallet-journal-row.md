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

## The damage

Settled by its own migration once this one has stopped the growth, with the
numbers read then (CLAUDE.md 10.9 rule 4); see the section below.
