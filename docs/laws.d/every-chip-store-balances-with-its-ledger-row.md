# tests/every-chip-store-balances-with-its-ledger-row.law.test.ts

Every chip store, not only the first six, moves in a transaction only by exactly
the net of the chip_ledger legs written in that same transaction; otherwise the
transaction is refused at commit by name, `REFUSED:
balance_moved_without_its_ledger_row` (or, while its store is still being
measured, recorded in ca_ledger_invariant_findings).

Migration 20261002030942 extends the commit-time check of 20261001160611 to the
promo floats (member, agent, club, legacy union), agent wallets, club wallets,
insurance banks, Spin reserve pools, tournament escrow (prize + bounty + fee),
the ticket escrow float and the two clearing stores (opening_setup,
leaderboard_round), through a second tally function (fn_ca_tally_store_move)
and new triggers, without redefining the six-store function or its triggers.
The mode is per store (ca_ledger_invariant_store_mode): the six proven stores
carry refuse, the nine new ones were installed in observe.

This is a coverage law. It derives the chip stores from the migrations: every
`column=store` the journal trigger (fn_ca_autoledger / fn_ca_autoledger_delete)
journals must be counted by a tally trigger on its table, every ledger store
ca_chip_store_coverage declares counted must be an account
fn_ca_ledger_tally_key resolves, and the stores the journal trigger never
covered (tournament escrow, the ticket float, the opening seed) are named and
must be counted. A planted migration adding a journalled column with no tally,
or a counted store with no key, is executed in the test and goes red.

The executable proof is scripts/dev/test-ledger-invariant.sh: after the
six-store proof it applies the real migration on PostgreSQL 17 and runs
tests/fixtures/ledger-invariant/stores-regression.sql - eleven planted
regressions refused by name, eleven live shapes committed, and an observed
promo drift beside a felt drift in one transaction, where the felt still
refuses. No later migration may move a store back to observe, or drop or
disable the store triggers or their functions.
