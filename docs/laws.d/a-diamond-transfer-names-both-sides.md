# tests/a-diamond-transfer-names-both-sides.law.test.ts

A Diamond Wheel spin price is a TRANSFER to the host club's owner (Dan,
2026-09-10), but `deduct_diamonds` decided what a transfer was from a hardcoded
list of sources that `wheel_spin` was not on, so the debit was journaled a
spend and the Mint register BURNED 100 diamonds that were sitting in the
owner's balance, while the matching credit was journaled a transfer and
registered nothing. Balances moved 0, the register moved -100, and
`fn_ca_diamond_snapshot` raised it an hour later. This law pins the fix: the
classification follows the money (a debit that names a recipient is a
transfer), every diamond-game leg names the player on the other side, ONE
definition of "this is a transfer" is read by both the register's skip and the
guard, and `ab_ca_diamond_transfer_names_its_counterparty` refuses any journal
row that escapes the register while naming nobody. It also pins what was NOT
done: the 50-diamond threshold is unchanged, nothing is excluded from the
measurement, no player balance is adjusted, and the register is corrected
forward by one row rather than edited.
