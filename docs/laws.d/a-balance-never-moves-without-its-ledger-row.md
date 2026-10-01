# tests/a-balance-never-moves-without-its-ledger-row.law.test.ts

A covered chip balance moves in a transaction only by exactly the net of the
chip_ledger legs written in that same transaction, and a leg exists only
beside the balance movement it describes; otherwise the whole transaction is
refused at commit by name, `REFUSED: balance_moved_without_its_ledger_row`.

Every chip balance on the platform is written directly by its door and
journalled after the fact by a trigger (fn*club_members_ledger_writer,
fn_ca_autoledger). Both stand down when the door sets
app.ledger_autoskip*<table> and promises to write the leg itself; 36 doors make
that promise and nothing verified it, and the felt (table_seats.stack) and the
pending add-on float had no journal trigger at all. That is what made drift
possible while every transaction was "logged": the log was written by a second
hand that could be told to stay quiet.

Migration 20261001160611 installs one transaction-scoped tally (setting
ca.ledger_tally) fed by AFTER-row triggers on club_members, clubs, table_seats,
table_pending_addons, union_wallets, bbj_pools and chip_ledger, and a deferred
constraint trigger that compares balance delta to ledger net per account at
COMMIT. The accounts are player_wallet:<user>:<club>, club_treasury:<club>, the
whole cash felt as one account (occupied seats on chip cash tables plus
unresolved add-on floats), union_bank:<union>, union_wallet:<union> and
bbj_pool:<pool>. A fn_ca_post_correction journal-only restatement is outside
the tally exactly as it is outside every meter.

The proof is executed: scripts/dev/test-ledger-invariant.sh runs the real
migration on an isolated PostgreSQL 17 (tests/fixtures/ledger-invariant) and
plants eleven regressions, including the 2026-08-25 deleted seat, and ten live
money shapes. The catalog enumeration of writers is the view
v_ca_chip_balance_writers; docs/evidence/chip-balance-writers-2026-10-01.md is
its snapshot. The one split-write it found, promo_apply_playthrough releasing
promo into chip_balance under a stand-down with no leg, is fixed at its line in
the same migration, pinned to the live body's md5.

The hand commits in two transactions, and each one balances on its own
(20261001231409). Observe mode's first 28 minutes recorded 4,491 findings, all
on `table_stack`, all one pair: the accepted-hand transaction moves the seats by
inflow - rake - bbj with no leg, and the later obligations transaction posts the
fee legs (rake to the union wallet or chip retirement, the drop to the jackpot
pool, the insurance bank's leg) with no felt move. The legs cannot be posted at
commit without queueing every hand of a club on its club_wallets row inside the
commit path (1,122 statement timeouts on that row in two hours), so the rule is
applied the other way round: the hand's receipt (hand_atomic_commits) counts
rake + bbj - inflow as FELT from the moment its envelope is stored to the moment
it completes, in the transaction that posts the legs. Either half alone, or the
pre-envelope shape, is refused by name (R12-R14 in the fixture). Proved on
4,074 of 4,074 completed production cash hands: receipt fees = felt legs, to
the cent.

Staged: the migration installs mode `observe` (findings land in
ca_ledger_invariant_findings, warned, committed) to measure one hour of live
traffic on every covered account; the next migration flips the one row to
`refuse`. The law refuses any later migration that sets the mode back to
observe, drops or disables a tally or check trigger, or drops a guard function.

installed mode: observe
