# Chip standard Phase 2.1 - the weekly union close pays from the rake treasury, and only from it

2026-09-03, migration `20260903161443_the_weekly_union_close_pays_from_the_rake_treasury_and_only_from_it`
(applied once, 16:14 UTC). Lane-2 audit finding F1, CRITICAL, dated before 2026-09-14.

## What was wrong

`fn_union_weekly_rakeback_close` debited two union pots for one payout:
`rake_wallet -= LEAST(period_total, rake_wallet)` AND `chip_balance -= payout_total`,
while the clubs received `payout_total` once. The union's retained share
vanished and the clubs' share left twice. Its guard demanded that the general
BANK cover a payout owed by the rake TREASURY (`payout > chip_balance OR
payout > rake_wallet`), so Midway Union - treasury 2,051,670.07, bank
68,876.84 - would have refused any week above 69k forever. The "retained"
row was a `chip_balance` credit labelled "informational; chip_balance total
unchanged by retention": a journal entry for money that did not move.

## What it does now

- guard: `rake_wallet >= period_total`, else refuse whole (retryable, incident);
  the general bank is never consulted
- `rake_wallet -= period_total` (once), `chip_balance += retained`,
  clubs `+= payout` through `fn_credit_treasury` keyed
  `union_close:<settlement>:<club>` so a retried close cannot pay twice
- the union side declared through `fn_ca_declare_ledger('rakeback',
'union_wallet', union, settlement, NULL, {union_wallets})`; each club credit
  journals as one `union_wallet -> club_treasury` row from the clubs auto-ledger;
  the retained share is one explicit `union_wallet -> union_bank` row
  (`treasury_transfer`, key `union_close:<settlement>:retained`)
- conservation asserted on the balances themselves inside the guarded section:
  `(treasury delta) + (bank delta) + (clubs delta) = 0`, treasury delta =
  `-period_total`, clubs delta = `payout_total`, bank delta = `retained`; a miss
  raises, the section rolls back, the settlement row goes to `failed`
- `union_wallet_transactions` keeps its shape (one `rakeback` debit per club);
  the retained pair is now a real `rake_hold` transfer (rake_wallet debit,
  chip_balance credit)
- callers (`fn_union_settlement_cascade`, `_all`, `fn_execute_union_rakeback`)
  and the return shape are unchanged; two fields added (`retained_to_bank`,
  `conservation`)

Who eats a short treasury is Dan's ruling (roadmap decision 4). Until then a
short treasury refuses the close and pays nobody - never partially, never
from the bank.

## Rolled-back probe on the real period (2026-08-24 00:00 .. 2026-08-31 00:00 UTC)

Inside one transaction: freeze rows set inactive, settlement floor moved back,
the close called, everything read, then `ROLLBACK`. Nothing persisted.

```
result   success, clubs_paid 1, period_rake 962,179.99, total_rakeback 1,140.48,
         union_retained 961,039.51, conservation asserted, settlement final
union    rake_wallet 2,052,259.94 -> 1,090,079.98   (-962,179.96 *)
         chip_balance   68,876.84 -> 1,029,916.35   (+961,039.51)
clubs    2,428,399.18 -> 2,429,539.66               (+1,140.48)
ledger   union_wallet -> club_treasury 1,140.48 (rakeback, settlement stamped)
         union_wallet -> union_bank  961,039.51 (treasury_transfer, union_close:<sid>:retained)
uwt      rakeback/rake_wallet debit 1,140.48 (Club JAQK);
         rake_hold rake_wallet debit + chip_balance credit 961,039.51
replay   {"success": false, "error": "already_executed"}
```

(\*) a 0.03 live rake credit landed on the wallet between the two reads; the
function's own assert, which reads its own RETURNING values, passed exactly.

## Found on the way, for Dan (not changed here)

Rake credits into the union treasury carry the TABLE's club. Union tables
belong to the union's house club, so for the week above 362,165 rows /
1,136,306.50 are stamped with the union itself and only 196 rows / 1,267.20
with a member club. Under the current rule the two member clubs would share
1,140.48 of a 962k week. Attributing the same week's cash-table rake by the
PLAYER's club (from `rake_records.player_contributions`) gives Club JAQK
799,193.67 and SHARK CLUB 3,834.15. That is the ClubGG / PokerBros union
model. Which rule the close should use is a business decision, added to the
roadmap as decision 4b. The function's arithmetic is correct under either.

Also: the two historic closes (04-01..08-17 and 08-10..08-17, executed 08-19
and 08-20) overlap and were paid by the double-debit body; they are part of
the epoch reset, not repaired here.
