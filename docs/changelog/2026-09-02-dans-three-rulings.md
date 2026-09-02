# Dan's three rulings, applied

## 1. "Club shares come from the rake treasury, its sent at the end of the week."

That settles the double-bank. `atomic_distribute_rake` was crediting two real
balances for one hand's rake — `club_wallets.chip_balance += (rake − bbj)` as a
per-hand pre-payment, **and** the full rake to the treasury. Under the ruling
only the treasury credit is right: paying the club a slice of every pot as it
happens pays them twice, once now and once on Friday.

Two things checked before touching a money path used by every hand:

1. **The weekly settlement never reads that column.**
   `fn_union_settlement_cascade`, `fn_union_issue_weekly_invoices` and
   `fn_union_apply_presettlements` don't reference `club_wallets` at all; the
   preview works from `rake_wallet` and `chip_treasury`. Removing the per-hand
   credit takes nothing away from what the club is actually paid.
2. **Nothing live spends it.** 46,991 `commission_out` rows exist, but the
   newest is 2026-08-20 — none in thirteen days. That path moved elsewhere.

Kept: `period_rake_collected`, `lifetime_rake_collected` and the BBJ counters
still accumulate every hand, because they are what the weekly settlement is
computed from. Only the spendable balance stops moving. The 4,351,836 already
sitting there is history, and history stays.

**Verified on live traffic:** over 25 seconds of play `club_wallets` moved
**0.00** while the union rake wallet took 3.35 against 4.25 collected. Then
across **232 raked hands** in ten minutes: **0%** bank their rake twice. The
ratchet is pinned at 0.

The legacy `record_rake` carried the same pre-payment. The first migration's
guard refused to patch it — the assignment is padded differently and it would
not guess — so a second migration did it explicitly. A half-applied ruling is
worse than an unapplied one, because it looks finished.

### The detector had to change with it

Once the credit was gone, the two legs stopped meaning the same thing:
`union_rake`/`chip_treasury` move chips, `club_accumulator` records the accrual
toward Friday. "The legs must sum to the rake" was no longer the right
invariant, and the detector kept firing on hands that were now correct — 34 of
44 in the two minutes after the fix. It measures the **chip-moving** legs now.
A detector reporting a defect already fixed is the same disease as one that
misses a real defect.

## 2. "Where do the funds go or are held after a player buys into a tournament?"

Answered in the report rather than here — it is a question about the model, and
the honest answer includes what the schema does _not_ record.

## 3. "Name a champion (ideally the person who won) and pay them out."

52 completed tournaments had players and no winner recorded. "Ideally the person
who won" needed no guessing: in **all 52**, exactly one player remained in
`status='playing'`, and in all 52 that player sat at **position 1**. Zero
ambiguous events. The record already named the winner; nobody had written it in
the column settlement reads.

Naming a champion moves no money by itself — the triggers that fire on
`UPDATE OF status` are daily missions, the booking cap, the current-players sync
and the zero-chip guard, none of which pay out. Payment was the separate,
idempotent step, and the whole chain was proved in a rolled-back probe first.

Result: **0** tournaments without a champion, and the Midnight Bounty champion
received the **24.00** that had been sitting unpaid since 2026-08-26. The
ratchet moved 52 → 0.
