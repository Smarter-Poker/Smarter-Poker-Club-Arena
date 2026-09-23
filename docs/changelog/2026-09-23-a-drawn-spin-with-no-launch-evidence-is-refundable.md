# 2026-09-23 — a drawn Spin with no launch evidence is refundable

Production Alerts Fleet, PRIMARY lane. Root-caused and fixed the oldest open
row on the board (`operational_alert_events` id=5, `SpinUnfilledBacklog`,
open since 2026-09-13).

## What was wrong

13 Spin tournaments drawn 2026-09-08 (multiplier stamped, one
`spin_reserve_ledger` `jackpot_draw` row each, real chips already moved)
never launched: zero `tournament_launch_receipts` rows — not even an
in-flight, uncompleted one — zero `spin_draw_receipts`, zero `hand_history`,
still `REGISTERING`, `started_at` still `NULL`, 15 days later. 346.00 chips
of member-club reserve and 39 wallet-charge legs (3 players × 13
tournaments) sat stranded, refundable to nobody.

Two independent defects blocked cancelling them:

1. `atomic_cancel_tournament`'s never-cancel-a-started-event guard refused
   **any** stamped `spin_multiplier` or `jackpot_draw` row, unconditionally.
   It could not distinguish a Spin whose launch is genuinely still in flight
   (verified live: five sibling Spins drawn in the same 2026-09-08
   13:35–13:46 UTC window recovered 5.4 days later, on 2026-09-14, via the
   launch lease itself — each carries a `tournament_launch_receipts` row
   with `started_at` at draw time) from one whose launch never started at
   all (the 13 here: no `tournament_launch_receipts` row at any state).
   `docs/laws.d/a-spin-is-drawn-stamped-and-booked-by-the-launch-that-
   deals-it.md` (owner policy v2.9, 2026-09-22) already made the forward
   case atomic — draw, reserve booking and stamp commit in the one launch
   transaction — so a launch-receipts row (any row, not only a completed
   one) is now the guard's signal instead of the multiplier/draw itself.

2. `fn_ca_tournament_refund_plan`'s escrow invariant compared
   `tournament_escrow.fee_entries_in` against the sum of each player's own
   `refund_fee` entitlement, which is structurally always 0 for a Spin (the
   whole buy-in itemizes as prize; the Spin's 8% rake is pooled separately
   at booking via `fn_spin_book_entry`, which is what actually seeded
   `fee_entries_in`). The assertion could never pass for **any** Spin,
   independent of these 13 rows — flagged and left open 2026-09-09
   (`docs/audits/2026-09-09-phase3-tournament-lifecycle.md`, "T06/S11",
   "the generic `fn_ca_tournament_refund_plan` therefore cannot serve as a
   Spin admission proof ... remains an open ... finding for the
   cancellation review") and never fixed until now. Verified live for all
   13: `fee_entries_in` exactly equals the pooled `fn_spin_book_entry` rake
   total to the cent.

Neither fix alone unblocks the 13: #1 alone still trips #2 inside the
per-player refund loop; #2 alone is still refused before ever reaching it.

## What changed

`supabase/migrations/20260923165133_a_drawn_spin_with_no_launch_evidence_is_refundable.sql`:

- `atomic_cancel_tournament`: guard now blocks on **any**
  `tournament_launch_receipts` row (not only a completed one, which is what
  actually protects an in-flight lease) and drops the standalone
  `spin_multiplier`/`jackpot_draw` checks the atomicity law makes redundant.
  Every other real-play guard clause (`started_at`, `RUNNING`/`BREAK`,
  `spin_draw_receipts`, `hand_history`, committed `tournament_obligations`)
  is unchanged.
- `fn_ca_tournament_refund_plan`: for a Spin tournament, compares
  `fee_entries_in` against the pooled `fn_spin_book_entry` rake total
  (mirroring `fn_ca_tournament_escrow_chips`'s own computation exactly)
  instead of the per-player `refund_fee` sum. Every non-spin tournament is
  byte-for-byte unchanged.
- Settles the 13 known stuck rows in the same migration, through
  `atomic_cancel_tournament` itself (the platform's own idempotent
  cancellation/refund authority), asserting each tournament's exact,
  live-read `total_refunded` before committing. Re-running the migration is
  safe — a tournament that already has a `tournament_cancellation_receipts`
  row just replays it.

Regression test:
`server/src/tournament/DrawnSpinWithNoLaunchIsRefundable.guard.test.ts` pins
both fixes, that every other guard clause is untouched, and that the
settlement block names and asserts all 13 ids.

## Why no new detector

`SpinUnfilledBacklog` already surfaces this population (that is how the
Production Alerts fleet found it in the first place); `spin_repair_missing_
multiplier` and `spin_sweep_unbooked` already prove the forward case has
nothing left to repair as of 2026-09-22. No new monitoring was added.

## Status

Draft PR opened, not yet merged, not yet applied. The 5.4-day recovery case
above is real and must be respected before this ships — the launch-receipts
guard change is the load-bearing part of the fix and needs the same
scrutiny as the money it moves.
