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
