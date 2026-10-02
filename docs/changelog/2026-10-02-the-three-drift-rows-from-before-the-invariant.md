# 2026-10-02 - The three drift rows from before the invariant

The last three open `ca_drift_incidents` rows with a nonzero amount were filed
before the ledger invariant could refuse anything. Each was decided from rows
under CLAUDE.md 10.9. No chips moved for any of them, and nothing was taken
back from anyone.

## c87a637f (player_wallets +789.00) and d3d3d7fe (table_stack -859.31)

Both are `fn_ca_trial_balance_watch` readings of the same hour, 21:05 -> 22:05
UTC on 2026-10-01, across the 22:00 break and its engine cutover. The trial
balance compares each pool's balance column between two supply snapshots with
the ledger legs written between them, so a movement whose balance lands on
one side of a snapshot and whose leg lands on the other reads as drift in one
window and the opposite drift in the next.

1. Outcome read. The next reading (window 22:05 -> 00:05) was player_wallets
   -1,097.00 and table_stack +1,019.31: the same chips coming back. Remeasured
   across both sides with `fn_ca_trial_balance('2026-10-01 12:00')` (12:05 ->
   01:05, thirteen hours): player_wallets -60.00 against tournament_liability
   +64.80 (one wallet-to-tournament movement straddling the 01:05 snapshot),
   table_stack -17.87. Every cash hand receipt since hand 19,700,000 (17:xx
   UTC) has its post-commit obligations completed (99,034 receipts read at
   02:00 UTC, zero pending, zero without an envelope), and no receipt anywhere
   in `hand_atomic_commits` is pending, so no hand's fee legs were left
   unposted.
2. Nobody paid twice: nothing was paid.
3. Nothing clawed back: nothing moved.
4. Probe: none needed; no write.
5. Closed `verified_remeasured`.

## d4112b94 (ledger replay, cash felt -2.58, -18.01 cumulative)

`fn_ca_ledger_replay` reads the whole cash felt (`table_seats.stack`) as one
account once a day. Its unexplained residue was -0.48 for days, then -1.17,
-0.93, +0.15, and -15.58 on the 2026-10-01 06:47 reading: cumulative -18.01,
meaning the seats held 18.01 less than the journal says reached them. In-flight
hand fees at that reading (committed, legs not yet posted) were 2.15 across
three hands; pending add-ons are not the cause (one 176.80 add-on was pending
and the replay keys it separately). The rest is not attributable to a seat,
a hand or a player from rows: the felt is one pooled account and nothing
before 22:24 UTC on 2026-10-01 recorded which transaction moved a seat without
its leg.

1. Outcome read: the residue is measured, not assigned to anyone.
2. Nobody paid twice: nothing was paid. There is no player to pay; crediting a
   guessed seat would invent a recipient.
3. Nothing clawed back.
4. Probe: none; no write.
5. Closed `operator`, ruling: the 18.01 is recorded as an unattributed
   pre-invariant felt residue and absorbed. The class it belongs to - a
   balance moving without its same-transaction leg - is refused at commit
   since 20261002015339, so the residue cannot grow; the next replay reading
   is expected to show zero new unexplained movement on this account.
