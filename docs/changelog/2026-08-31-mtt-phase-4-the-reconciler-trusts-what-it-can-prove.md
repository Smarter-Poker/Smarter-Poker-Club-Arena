# 2026-08-31 — MTT Phase 4: the reconciler trusts what it can prove

Phase 4 of 7. Phase 3 gave tournament payouts an authoritative record; this is
the first thing that record made it possible to fix.

## What Phase 3's record exposed

39 completed MTTs paid out more than their prize pool, 20,407.66 over. With the
record in place the causes decompose cleanly, which was not possible before:

| cause                                               | events | excess    |
| --------------------------------------------------- | ------ | --------- |
| a place paid to two different users                 | 30     | 19,452.62 |
| satellite (seat value stamped in `prize`, not cash) | 7      | 870.00    |
| **neither**                                         | **2**  | **84.90** |

The first is the user-scoped idempotency key, fixed at source on 2026-08-28.
The second is not really an overpay — a satellite stamps the seat's notional
value into `tournament_players.prize`, so summing that column reads a 108 pool
at 926%. The last two are this changelog.

## The two that were left

**Mid-Morning Turbo (6-Max NLH) `88a6aced`, 2026-08-22:**

```
14:14:06  wallet_credit_idempotency gains ...:prize:{user}:4  36.90
          the credit MOVED — and no wallet_transactions row was written
14:29:55  fn_tournament_payout_reconcile sums wallet_transactions,
          sees 0.00 paid, computes 36.90 - 0.00 owed, pays it AGAIN
```

73.80 for a place worth 36.90; the event disbursed 110% of its pool. _Morning
Grinder (PLO)_ `b687e4aa` did the same on place 1, 96.00 against 48.00.

## The root cause is the source of truth

The reconciler answers "what has this player already been paid?" by summing
`wallet_transactions`. That is a **log** — written after the money moves, by a
separate statement. It can be missing, as here, or (the failure the function's
own comments already describe) present for a credit that never moved. Under-
report and it pays twice; over-report and it hides a real shortfall forever.

`tournament_payouts` is authoritative in a way the ledger is not: its
`idempotency_key` is UNIQUE and the row is written inside `fn_credit_and_log`
only after `fn_credit_player_wallet_once` returned true. **One row exists if and
only if money moved once.** Phase 3 backfilled the entire history into it, so it
answers for the back catalogue too.

## A second, quieter error fixed at the same time

The old sum took every `category = 'prize'` ledger row for that player — and
**bounty payments carry that same category while being funded from the bounty
pool, not the prize pool.** In a PKO event the reconciler counted bounty
winnings as structure money already paid, and could call a player square while
the structure still owed them. The record distinguishes them by `source`, so it
now counts only what the prize pool funds.

## Safety, measured before trusting it

The dangerous direction is the record reporting **less** than the ledger,
because that is what proposes a top-up the old logic would not have. Across
every COMPLETED non-satellite tournament of the last 30 days — 163,302
(tournament, finisher) rows:

```
163,286  the two sources agree
     15  record HIGHER than ledger   (the safe direction — the double-pays this prevents)
      1  record LOWER  than ledger   (0.31 chips, total)
```

That single row is _The Daily Big Mini_ place 3, and it cannot double-pay even
in principle: its `:reconcile` key is already consumed, so a second top-up
returns false from `fn_credit_and_log` and is reported as
`top_up_refused_by_idempotency` rather than paid. The reconcile key is scoped
per (tournament, user, place), which bounds this failure mode to one top-up per
place for all time.

## Verified on the two events that caused it

Dry runs, `p_apply => false`:

```
88a6aced  place 4: already_paid 73.80 vs expected 36.90
          -> issue "overpaid", excess 36.90, total_top_up 0
b687e4aa  place 1: already_paid 96.00 vs expected 48.00
          -> issue "overpaid", excess 48.00, total_top_up 0
both report paid_from = "payout_record"
```

Under the old body both read 0.00 already paid and topped up again.

The repo file's function body was checked against production byte for byte:
9,753 characters, md5 `3a644ec0c5a126986ad38bc768b4a94b` on both sides.

## What did not change

The trim-to-field rule, the basis-point rounding with the residual on the last
paid place, the duplicate-finisher and no-finisher refusals, the
overpayment-is-reported-never-clawed-back stance, the alert de-duplication and
its acceptance handshake, and the prize-column stamp. `paid_from` is added to
the returned jsonb so a reader can tell which source answered.

## Tests

`theReconcilerTrustsWhatItCanProve.law.test.ts` — 9 pins, including that bounty
sources never appear in the structure filter, that the ledger arm survives as an
explicit fallback rather than "no record means nothing was paid", and that the
place-scoped reconcile key is still what bounds a top-up to once.
