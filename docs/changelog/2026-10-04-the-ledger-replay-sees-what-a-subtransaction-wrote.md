# The ledger replay sees what a subtransaction wrote (2026-10-04)

Chip drift. Two migrations:

- `20261004124640_the_ledger_replay_sees_what_a_subtransaction_wrote_and_a_uni` fixes the payers and the reader.
- `20261004125201_the_drift_the_replay_misread_is_rebaselined_and_its_incident` is records only: it rebaselines the four accounts the reader got wrong and closes their incidents and the kill-switch alert.

Law: `tests/the-ledger-replay-sees-what-a-subtransaction-wrote.law.test.ts` (`docs/laws.d/the-ledger-replay-sees-what-a-subtransaction-wrote.md`).

## What the 06:40 replay said

On 2026-10-04 the nightly replay, now running inside its budget, judged the window from the 2026-10-01 06:47 reading and filed:

| account | unexplained |
| --- | --- |
| Midway union rake wallet (`union_wallet:fade0000...:union_wallets.rake_wallet`) | -1,489,348.47 (kill switch, critical) |
| one player wallet (`70fa710b`) | +190.00 (critical) |
| jackpot pool `a7a65cfc` promo bank | -6.21 |
| club `2a1132b9` promo bank | +6.21 |

No chip was lost. Every figure reads back to legs that exist.

## Defect 1: a union rake payment did not name the column it left

A `union_wallets` row holds six balances, so a `union_wallet` side of a leg must carry a label saying which one moved. The weekly close (`fn_union_weekly_rakeback_close`), its retained-share transfer (`fn_union_close_post_rake_debit`) and the owner-authorized legacy week (`fn_accounting_legacy_pay_week`, rounds 1 and 3) wrote their union side with none. The replay counts such a leg as `unkeyable` and does not judge it against any account, so the rake wallet was judged with its rake coming in and none of its payments going out.

Read from production for the window 2026-10-01 06:47 to 2026-10-04 06:41, under the two readings' own snapshots:

| legs | union side | total |
| --- | --- | --- |
| 259,143 rake legs in | `union_wallets.rake_wallet` | +734,884.10 |
| 589 rakeback legs out (7 to club treasuries, one of them the union's own club; 582 to players) | no label | -1,446,346.26 |
| 1 retained-share leg to the union bank | no label | -43,012.21 |

`union_wallet_transactions` debits exactly 1,446,346.26 and 43,012.21 from `rake_wallet` in the same transactions. -754,464.37 moved = 734,884.10 - 1,489,358.47 + 10.00; the 10.00 is defect 2.

The three writers now stamp `from_label = 'union_wallets.rake_wallet'` on the union side of every leg they write (the legacy week's round 3 only when the payer is the union). The 2026-10-03 overdue-commission funding wrote three more such legs from a one-off migration; it does not run again.

## Defect 2: the replay judged a leg by its subtransaction

Every `BEGIN ... EXCEPTION` block runs as a subtransaction, so a row inserted inside one carries the subtransaction's id as its `xmin`. The autoledger always inserts that way. The replay decides whether a leg belongs to the next window with `pg_visible_in_snapshot(xmin, previous reading's snapshot)`, and PostgreSQL documents that function as wrong for a subtransaction id: an id inside the snapshot's xmin..xmax band that is not in its in-progress list reads as committed, even when its parent was still running. Such a leg was invisible to the reading that took the snapshot (its parent had not committed) and then excluded from the next window as "already seen". The balance moved and no reading ever counted the leg.

Read from production: one tournament finish transaction started at 2026-10-01 06:39:52 and committed after the 06:47 reading. Its prize leg (190.00 to `70fa710b`, xmin 750498527) and its rake leg (10.00 to the Midway rake wallet, xmin 750498599) both sit in that reading's band and neither is in its in-progress list. The 06:40 promo sweep runs in the same minute as the replay, so its legs straddle the reading most nights: 6.21 on 2026-10-01 (xmin 750500000) and 2.31 on 2026-09-30 (xmin 710724517), each read as a loss in the jackpot pool and a gain in the club promo bank.

A probe in one rolled-back call confirmed the mechanism on production: a row inserted inside an exception block had xmin 878999716 under top-level transaction 878999714, and `pg_current_xact_id()` inside the block returned 878999714.

`chip_ledger` gains `top_xid xid8` (nullable, no default, so no rewrite of the journal). `fn_ca_chip_ledger_enrich` stamps it with `pg_current_xact_id()`, which is always the top-level transaction, and never takes it from the writer. Both journal readers (`fn_ca_leg_accounts_since_snapshot` and `_for`) judge `COALESCE(top_xid, xmin)`. Legs written before the column existed keep NULL and fall back to xmin, so a leg that straddled the 2026-10-04 06:41 reading can still read once more tonight; from the next reading on, the top-level id decides.

## The records

A reading cannot be re-judged after the fact, and the next reading carries a cumulative forward (a same-sign interval is judged on the cumulative, so a 0.10 move on the rake wallet would have re-filed -1.49M). The four accounts above get a fresh baseline, written the way the replay writes a first reading: the balance and the snapshot it was read under, in one statement. The six incidents (`30bf6669`, `18f578be`, `de1c3649`, `c8a4dcb2`, `f972f5db`, `89f91485`) close through `fn_ca_incident_action` with their root causes, and financial alert `0884f538` (the kill switch) closes with the same explanation. No chips move.

Other small cumulatives the replay has carried quietly (bbj main 0.37, backup 0.19, older residues already judged 0) are left as they are.

## How to apply

Both migrations are applied after merge through **Apply Merged Migration**, in order: `20261004124640_the_ledger_replay_sees_what_a_subtransaction_wrote_and_a_uni.sql`, then `20261004125201_the_drift_the_replay_misread_is_rebaselined_and_its_incident.sql`. Each checks its pre-images and stops without changing anything if production moved. The second refuses to run before the first. Avoid minute :50 to :03 UTC (the database refuses DDL during the hourly break).

## Still open

The same kind of unlabelled union side can still be written by rarely used paths that declare a union wallet as the autoledger counterparty without naming a column (union send to a member, union P&L settlement, spin settlement, BBJ funding and backup transfer, promo rain and promo disbursement to a player). None has written a leg in 60 days. They are the next cut, together with a constraint that refuses an unlabelled union side.
