# The two retired mixed-custody events are voided, and every dollar goes home

2026-09-26. Migration `20260926131948`. Law
`tests/the-two-retired-events-are-voided-money-neutral.law.test.ts`.

## What was stranded

| event    | name                     | entrants         | money in                                              | recorded, never paid |
| -------- | ------------------------ | ---------------- | ----------------------------------------------------- | -------------------- |
| 5a387a75 | $100 Freeroll 12:00 PM   | 351, every horse | 100.00 overlay from the main union bank               | 29.70 (places 15-36) |
| 615783bf | Afternoon Free Buy (NLH) | 195, every horse | 250.00 overlay from club 2a1132b9, 39 add-ons of 1.00 | 52.82 (places 13-20) |

Both have been frozen since 2026-09-18 22:10. Their mixed-custody admissions
are pinned to dead engine 778075b4 (instance 1-1bcee94e), and every lease
claim is refused with `F06_RETIRED_PARTIAL_PROCESS_CHANGED`. No custody design
exists that could resume them, and `atomic_cancel_tournament` refuses a
started event (that law stands). On 5a387a75, RexSr's chair left with 0 chips
at 22:09:40, but his registration still says `playing`.

## The ruling: void, money-neutral

Every dollar goes back to exactly where it came from. Nothing is created and
nothing is destroyed.

- The overlays return to their sources, 100.00 and 250.00, each as one
  `reversal` leg keyed `tourney:<id>:void:overlay-return`.
- The 39 add-ons are refunded through `fn_settle_tournament_refund_exact` and
  their immutable entitlements. This is the same payer that atomic
  cancellation uses.
- The 82.52 of recorded prizes is void. No payout, obligation, prize leg or
  wallet credit for it ever existed.
- RexSr is recorded as eliminated in 14th place, at 22:09:40.746.
- The stale 615783bf lease is released. The escrows close at exact zero, the
  chairs and tables close, and the events are `CANCELLED` with a verified
  `tournament_cancellation_receipts` row.

## How it is kept safe

- The door refuses any other event (a CHECK on its receipt table, too), any
  drift in a pinned fact, and any human entrant.
- `f06_source_guard` is opened only for these two events, and only inside
  the transaction that holds the void's uncompleted claim. It is then
  restored byte for byte to the live body (`be484837`).
- The void holds the settlement lane like every terminal authority, so the
  migration carries `lock_timeout 2s` and `statement_timeout 10s`. A busy
  lane refuses cleanly and never stalls the fleet (the 09:33 collapse).

## Measured after apply

Recorded on the pull request.
