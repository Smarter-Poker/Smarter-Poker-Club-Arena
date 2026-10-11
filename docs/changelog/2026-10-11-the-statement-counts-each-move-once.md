# The Cashier Statement counts each move once and names its wallet (2026-10-11)

## What was wrong

The Cashier Statement (page, totals and export all read the one owner-only row
query `fn_cashier_statement_rows`) printed some moves twice and charged the
wrong person:

- A door that writes a receipt and journals the same move as a `chip_ledger`
  leg (BBJ promo sweeps, add-on refunds, promo, pot and reversal doors) showed
  both, so the move counted twice.
- A 30-chip cash out read as 60 out for the player (the hold and the approval
  both charged them) and 60 in for the assigned agent, who received nothing.
- The operator who pressed Club Bank Send was charged for chips the Club Bank
  paid; a horse's treasury-funded seat carried a kind no human row has; real
  names and storage paths could be printed as names.

## What changed

Migration `20261011194856_the_statement_counts_each_move_once_and_names_its_wallet`.
It was first written as `20261009223439` against the body before #6615; #6615
(`20261010011934`) then installed a fast path for the default all-scope totals,
so the file was rebased onto production's live body (md5
`8a47b11b861fef1357ae8749d1370a11`) and re-reserved to a version after it.

- Every path (pages, exports, filtered totals and #6615's default fast path)
  leaves out a leg its receipt already shows, and counts a receipt where its
  chips move: a cash out's hold is the player's out, the approval the
  approver's in, a refund the player's in; a pot (Club Bank, promo, union) is
  the side of a pot send, not the operator.
- #6615's fast path keeps one directional range per source. The receipts the
  viewer is not a side of are still counted from `idx_chip_tx_club_time_totals`;
  the viewer's own receipts are read from the (club, user, time) indexes,
  which carry the kind; the mirrored legs join the omitted set `$19`.
- New partial index `idx_chip_ledger_statement_mirror_legs`, built
  CONCURRENTLY before the transaction.
- Labels use `fn_arena_name`; storage-path labels print as null; a
  treasury-funded seat reads exactly as a Club Bank send.

Before and after, for a player who cashed out 30: out 60 became out 30; the
owner's own totals for Club Bank sends went from out to managed.

## Verification

`python3 scripts/ci/test-cashier-statement-db-postgres.py` on PostgreSQL 17
(CI: `accounting_postgres` shard 2): production's live body reproduced byte for
byte; `db-one-move-once.sql` fails 21 of 31 on it and passes 31 of 31 after;
totals equal their own unlimited page for every viewer, scope and filter,
including #6615's NaN and omission boundaries; drift, invalid index, replay and
browser-role installs refused; plan index-only with no sequential scan.
`scripts/dev/test-cashier-statements.sh` (#6615's own qualification) still passes.

## Installation

Not installed by this merge. Dispatch Apply Merged Migration once for this
file, starting at least 12 minutes before :50 UTC (the index builds first).
Post-install md5 of `fn_cashier_statement_rows`: `88cb4d660916a2c78b9cf7333c5b3b45`.
Both `-- @live-proof:` lines must read true afterwards.
