# The Settlement Check Counts No Refund (2026-10-11)

## What Was Reported

`fn_ca_tournament_settlement_mismatch` listed finished chip tournaments as
"overpaid" by 10 to 25 chips (seven at the 2026-10-10 handoff), while the
prize overpay ratchet read 0. Over 30 days it listed 22 such events, over by
5 to 480 chips.

## What Actually Happened

Nobody was overpaid. The reader summed every non-bounty wallet credit on a
tournament as "paid", and a registration refund is a credit too. In all 22
events:

- the excess equals the event's refund credits to the cent (for example PLO8
  Morning Stack: one 10 chip "Bot retirement drain" refund, read as a 10 chip
  overpay);
- the prize credits equal the prize pool to the cent;
- entries collected = prize + bounty + rake + refunds (PLO8 Morning Stack:
  250 collected = 216 prize + 24 rake + 10 refunded; Turbo Tuesday PKO: 1,470
  = 600.75 prize + 600.75 bounty + 133.50 rake + 135 refunded).

The sibling reader `fn_ca_prize_overpay_unexplained` already excluded refunds
(fixed 2026-10-05), which is why the two disagreed. This reader also feeds
the critical ratchet `tournament_underpaid_48h`, so a refund could have hidden
a real underpayment of the same size.

## The Fix

Migration `20261011200528_the_settlement_check_counts_no_refund` changes the one line that
reads credits: `category NOT IN ('bounty', 'refund')`, the same rule its
sibling uses. Re-measured read-only with the fix over 178,870 completed
events in 30 days: 0 underpaid, 0 overpaid. The migration asserts that
before it commits. No money moves and nothing is taken back from anyone.

The 2026-09-06 operator note on PLO4 Heads-Up 25 (3e281f5c) was re-checked
too: its chip-proportional deal is recorded and balanced (75.00 collected =
47.50 + 23.75 prize + 3.75 rake, escrow closed at zero, migration
20260906153943 recorded).

## Money Checks Run With It (Last 24 Hours, Read Only)

- 26,578 chip events (MTT, bounty, PKO, mystery bounty, satellites, heads-up
  Sit And Gos, Spins): every escrow closed with zero prize, bounty and fee
  balance, money in equals money out, and the booked rake equals the fee taken.
- 20 Diamond events: every Diamond escrow at zero and custody at zero; the
  Diamond PKO split 48,000 into 21,600 bounty, 4,800 rake, 21,600 prize.
- Satellite conservation audit (336 hours): 0 rows. Payout guarantee check
  (rolled back): 0 unpaid places, 0 vacant places, 0 retained bounty pools.
  Running Diamond events: escrow equals custody on all 58.

## Pinned By

`tests/the-settlement-check-counts-no-refund.law.test.ts`.
