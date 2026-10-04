# A union rake treasury leg names its wallet (2026-10-04)

Migration `20261004123650_a_union_rake_treasury_leg_names_its_wallet`.
Law `tests/a-union-rake-treasury-leg-names-its-wallet.law.test.ts`.

## What happened

At 06:40 UTC the nightly ledger replay (job 286) judged Midway Union's rake
treasury (`union_wallet:fade0000-...-0001:union_wallets.rake_wallet`) for the
first time since 2026-10-01 06:47 (the runs of 10-02 and 10-03 failed: a job
startup timeout during a database restart, then the 600 s budget). The balance
moved -754,464.37; the journal it could key said +734,884.10. It filed a
critical drift incident and tripped the kill switch at -1,489,348.47
(UNCONFIRMED, freeze is human only).

## Nothing was missing

Read under exactly the replay's two snapshots (`read_snapshot` of the 10-01
06:47 and 10-04 06:41 readings), the window holds 590 legs out of the union
wallet whose `from_label` is NULL:

| when (UTC) | writer | legs | amount |
|---|---|---|---|
| 10-01 22:43 | weekly close f3470e1f (week 09-21), club rakeback | 2 | 387,082.68 |
| 10-01 22:43 | weekly close f3470e1f, retained share to the bank | 1 | 43,012.21 |
| 10-02 06:11 | owner legacy cascade, round 3 (union pays players) | 582 | 117,192.35 |
| 10-02 10:04 | owner legacy cascade, round 1 (union pays clubs) | 2 | 339,323.01 |
| 10-03 10:25 | overdue agent commission funding (one-off, 20261003092151) | 3 | 602,748.22 |
| | total | 590 | 1,489,358.47 |

`union_wallet_transactions` for the same snapshot window agrees to the cent
(rake credits 734,884.10 on 259,143 rows; rakeback debits 1,446,346.26; the
retained `rake_hold` 43,012.21). The commit-time balance invariant
(`zz_ca_balance_has_its_ledger_row`) recorded no finding for the union: every
balance move had its leg. The replay resolves a `union_wallet` leg by its label,
and an unlabeled one only when the counterparty is a promo store, so these legs
were `unkeyable` and dropped from every account.

A residual of 10.00 remains between the balance and both journals in that
window (the balance rose 10.00 more than any leg or wallet transaction says).
The invariant sums the five operating wallets of the row as one account, so a
10.00 move between two of them would pass it; it is recorded on the incident
for the next reading, which starts from the 10-04 06:41 snapshot.

## Fix

The three writers that debit `rake_wallet` through a hand-written leg now name
the column (`from_label = 'union_wallets.rake_wallet'`):

- `fn_union_weekly_rakeback_close`: each club's rakeback leg;
- `fn_union_close_post_rake_debit`: the retained share to the general bank;
- `fn_accounting_legacy_pay_week`: round 1 always, round 3 when the union pays.

Edited by exact substitution against pinned preimages, postimage equal to the
substituted text; amounts, keys, receipts and locks unchanged. Validated before
apply by building the three postimages in `pg_temp` (compiled; `plpgsql_check`
reports nothing the live bodies do not already report).

Without this, the week closing 2026-10-05 would have tripped the kill switch
again on the first replay after its close.

## Live

Applied to production 2026-10-04 ~13:45 UTC; all three live proofs read true and grants are unchanged. Recorded in schema_migrations from the file bytes (md5 c987ccf4f7ae210a5b328e5df5f907ed). Incidents 30bf6669, 18f578be and de1c3649 resolved with this migration as the correction.
