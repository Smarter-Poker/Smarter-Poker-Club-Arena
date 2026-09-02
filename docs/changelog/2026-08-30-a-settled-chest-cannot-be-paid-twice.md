# A settled chest cannot be paid a second time

2026-08-30, found by the conservation check, not by reading code.

## What happened

Two migrations on 2026-08-29 taught the bounty residual payers to measure from
the ledger (`20260829223000`, then `20260830033037` for the second payer). A
conservation sweep at 03:44 UTC still found two events paying more than their
pool held:

| Event                          | Pool   | Paid   | Over  |
| ------------------------------ | ------ | ------ | ----- |
| Saturday Mystery               | 776.00 | 783.20 | +7.20 |
| Pre-Dawn Mystery Bounty (PLO5) |  30.00 |  32.60 | +2.60 |

Taking the PLO5 event apart, chest `e794df3d` is worth 260 cents and it was
paid twice, ten seconds apart, to the same person:

```
03:33:01  Unclaimed mystery bounty chests awarded to champion   2.60
03:33:11  Mystery bounty revealed from eliminated player        2.60
```

## Why the ledger fix did not catch it

`fn_mystery_bounty_settle` is a third payer, and it never measured anything.
It sweeps every chest still in `available`, `reserved` or `revealed` to the
champion and marks the CHEST `void` -- but it does not touch the AWARD hanging
off that chest. An elimination whose reveal was still in flight therefore kept
a live award; `fn_mystery_bounty_pay` landed moments later, credited the
knocker under its own idempotency key `mb:<award>:<user>`, and set the chest
back to `paid`.

Two credits, one chest. The keys are different, so neither credit could see the
other, and `fn_credit_and_log` idempotency -- which is doing its job perfectly
-- has nothing to compare.

## The fix

`20260830040000_a_settled_chest_cannot_be_paid_a_second_time.sql`, applied to
production at 03:52 UTC.

1. **Settle pays what is already revealed, first.** A chest the player has
   opened belongs to the player who opened it, not to the champion. Those
   awards are paid inside the settlement transaction, which marks their chests
   `paid` and removes them from the unclaimed sweep entirely.
2. **Settle voids the awards it sweeps.** Whatever is still unopened when the
   event ends goes to the champion, and its award is marked `void` in the same
   transaction -- a new terminal state, added to
   `tournament_bounty_awards_status_check`. It is not `completed`: nobody was
   paid under it.
3. **The payer refuses a settled chest.** `fn_mystery_bounty_pay` now returns
   `award_voided_by_settlement` / `chest_settled_to_champion` instead of
   quietly re-paying, which closes the window for an award mid-flight in
   another transaction.
4. **A floor under all three.** The champion residual is clamped to what the
   funded pool still holds according to the ledger, and clamping raises a
   critical `financial_alerts` row. Had the clamp existed at 03:33, the ledger
   already stood at exactly 30.00 of a 30.00 pool, the residual would have been
   0, and the 2.60 would never have been minted.

## The guard

`server/src/tournament/mysteryBountyChestDoubleSpend.guard.test.ts` pins all
four rules against the newest migration that defines each function. It sits
beside `bountyPoolConservation.guard.test.ts`, which pins the first payer to
the ledger.

## Not done here

The 9.80 already overpaid across the two events was left in the players'
wallets. Moving chips is Dan's call, and the precedent set on 2026-08-29
(`20260829124146_close_payout_alerts_dan_accepted_the_overpayments`) is that
overpayments already landed are accepted rather than clawed back.
