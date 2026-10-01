# A Retry Gets Its First Receipt (Diamond Phase 11, Line 2)

2026-09-30. Phase 11 line 2: "Test transfer/store/game concurrency, duplicate
delivery and crash recovery."

The concurrency suite showed that every Diamond money door takes effect exactly
once when a request arrives twice, but not every door answered the second
delivery the way it answered the first. Dan handed the two questions over on
2026-09-30 ("these are all for you to decide not me ... FIX AND FINISH ALL OF
THESE"). Decided by Claude on that delegation, and recorded in
`docs/DIAMOND-RULINGS.md`:

1. Every Diamond money door answers a retry with its first receipt, word for
   word. No door adds a "replayed" marker.
2. A retry that reuses a key with different details is refused by name at every
   door, the prize payer included.

## What changed

`20260930235000_a_retry_gets_its_first_receipt`:

- **The Diamond store** (`fn_purchase_feature_v2`) answers a retry with the
  receipt it stored the first time. It used to answer "cost 0, not granted".
  A player whose first answer was lost now sees what the purchase did.
- **A Diamond tournament withdrawal** (`fn_poker_diamond_tournament_unregister`)
  answers a retry without its two replay markers. The balance it reports is the
  one the refund left, not the wallet as it stands when the retry arrives.
- **The prize payer** (`fn_poker_diamond_tournament_pay`) answers a retry of a
  payment it already made "yes", as it did the first time. The same key with a
  different payee, event, bank or amount is refused by name:
  `diamond_tournament_pay_key_reused`. It used to answer "no" and pay nothing.
- **`fn_credit_and_log`**, the payer's only caller, is edited in its Diamond
  branch only. It still answers "paid" to the call that paid and "already paid"
  to a checked retry, so the settlers above it, the terminal and the engine see
  exactly the answers they saw before. Without this edit a retried payment
  would have failed every time on the payout table's unique key.

## What did not change

No table, column, grant or new function. No chip door answers differently. The
transfer, cash buy-in, top-up, cash-out and registration already answered word
for word and are untouched. The rebuy money core is shared with chips and is
reached only through the public rebuy door, which already answers a retry with
its stored first receipt; the core now shows in the suite that it refuses a
changed price by name. No engine code changed. Neither Diamond switch opens,
no Diamond moves, and no price changes.

## Evidence

- `docs/evidence/diamond-phase-11/concurrency-and-recovery.md`: the replay
  table, updated.
- `tests/sql/run-diamond-concurrency.py`: every retry must equal its first
  answer after the caller's wallet has moved, and every changed payload must be
  refused by name.
- `docs/evidence/diamond-phase-11/a-retry-gets-its-first-receipt-rehearsal.sql`:
  the rolled-back production rehearsal, before and after.
- The law: `tests/a-retry-gets-its-first-receipt.law.test.ts`.
