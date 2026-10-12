# tests/the-journal-explains-the-balance.law.test.ts

A player's diamond balance and the journal row that explains it are written by
the same hand in the same transaction, or not at all.

Before 2026-09-01 handle_new_user's INSERT INTO public.profiles carried the
500 diamond welcome grant as a literal in the `diamonds` column, so the balance
existed the instant the row was born and no diamond_transactions row was ever
written for it. That left 439 wallets holding 220,985 diamonds the journal
could not account for, and showed a third of the wallets with a ledger two
numbers on one screen that could not both be true, because
fn_diamond_wallet_summary reads on_hand from profiles.diamonds and
lifetime_earned from the journal. The balance was always high and never low,
so no player was ever short.

The cause is closed three times over: 20260901032430 made the grant journal
itself, 2026-09-08 routed it through fn_ca_mint under op id signup:<id>, and
2026-09-15 flipped DR2:balance_born_outside_the_mint and
DR6:balance_changed_without_journal from 'log' to 'refuse' so a profile can no
longer be born holding diamonds and an unsanctioned write to profiles.diamonds
is refused outright.

Those two rule rows and their triggers (zz_ca_diamond_born_with_balance,
zz_ca_audit_diamond_change) are the hard-coded fix, so this law refuses any
migration from 20260930 on that softens either rule below 'refuse', drops or
disables either trigger, or opens a new born-with-balance door by giving
profiles.diamonds a non-zero literal on INSERT. It also pins the settlement,
20260930055147, to changing no balance, keying every row per user so a re-run
cannot double it, and marking every row 'journal_backfill' so the Mint's
register does not count supply it already holds a second time.

Extended 2026-10-07 for the second way a journal stopped explaining a balance:
a writer that INSERTs a diamond_transactions row and moves no
profiles.diamonds. fn_ca_diamond_sweep_cash_rake journalled each payer's
Diamond cash rake, which had already left with the table stack and was already
inside the smaller cash-out, so 46 rows in its first six hourly sweeps put 13
wallets 4,460 Diamonds out. The law now refuses, from 20261007112751 on, any
function whose body inserts a wallet journal row without moving the wallet in
the same body (a settlement row marked 'journal_backfill' is the only
exception), pins the sweep to retiring the rake in the Mint register with no
journal row, and pins the settlement 20261007112808 to changing no balance,
keying every correction to the row it corrects, and staying out of the
register.

Extended again 2026-10-07 (#6411) for the Diamond tournament lane: the drain's
house-bound arm (tournament fee, Spin surplus, guarantee overlay return), the
guarantee overlay paid into custody and the Spin underwrite each journalled a
custody-to-house or house-to-custody movement no wallet made; the fee path put
4 wallets 800 Diamonds out at 13:03 UTC. The law pins all five lane functions
to their 20261007132503 definitions: no wallet journal row for a house leg, the
register row written directly with the wallet unchanged, every caller asserting
the register by op_id, and the movement CHECK admitting a missing journal id on
the two house legs only.
