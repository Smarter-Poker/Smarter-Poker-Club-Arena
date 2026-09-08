# The pointer is written where the money moved

2026-09-08. Branch `fix/the-pointer-is-written-where-the-money-moved`. The
fourth class of open drift incident, and the one where reading the rows turned
20 flagged incidents into a defect covering the entire table.

## What was flagged

20 open incidents, `fn_ca_settlement_correctness_check:rakeback_chain`, all
raised in a single scan at 2026-09-07 19:30:02:

> rakeback marked paid/transferred with no linked wallet/chip transaction — the
> money side has no evidence pointer

20 players, one club, **4,224.68 chips**, every row `status = 'paid'` with
`wallet_transaction_id` null.

## What was actually true

**The players were paid.** All 20 have a `chip_ledger` leg, a
`wallet_transactions` row, and a rakeback-category credit. Nobody is owed
anything.

**And it was never 20 rows.** The scan reports a sample; the table tells the
real story:

| measure                                  | value          |
| ---------------------------------------- | -------------- |
| `rakeback_period_payouts` rows           | 2,704          |
| paid with **no** evidence pointer        | **2,704**      |
| rows that have ever carried a pointer    | **0**          |
| chips involved                           | 285,190.25     |

`wallet_transaction_id` has never been written, once, since the table was
created.

## The root cause

`fn_close_settlement_period` pays through `atomic_credit_wallet_and_log`, and
passes it the payout id — so the credit **does** stamp
`wallet_transactions.related_entity_id` with the payout. The link has always
existed, in one direction.

The call is a `PERFORM`, and the function returns a `boolean`. There is no id to
capture and nothing writes the reverse link. `fn_ca_settlement_correctness_check`
reads the reverse link. So every paid rakeback on the platform looked like money
with no evidence behind it.

**Fixed at the source**: the payer now reads back the row it just stamped and
writes the pointer, in the same transaction as the credit.

## Two things found on the way in, both worth more than the original bug

### 1. My own chip-unit constraint would have thrown on the next payout

The pointer backfill failed on a row holding `payout_amount = 1.4625`, refused
by `chk_payout_amount_is_two_decimal_places` — phase 9.1's constraint, shipped
this morning as one of the three left `NOT VALID` precisely because rows like
that existed.

**A `NOT VALID` CHECK still fires on every new and updated row.** It tolerates
the history and refuses the future. So the next rakeback payout with a sub-cent
amount would have thrown — a latent break introduced at 05:56 today and found at
13:10 only because an unrelated backfill tripped over it. Nothing had hit it yet:
the last payout was written 2026-09-07 19:25, and the closer has since only
deferred, for real reasons (`insufficient_club_treasury` 459,
`no_membership_at_earning_club` 379).

933 of the 2,704 rows carry a sub-cent amount. Rounding a money column is only
safe if it changes nothing anyone was paid, so that was **proved, not assumed**:

| check                                              | result      |
| -------------------------------------------------- | ----------- |
| wallet matches the **rounded** amount              | **933/933** |
| wallet matches the **exact** sub-cent amount       | **0/933**   |

The players were always paid in whole cents. The column held an intermediate
that never matched the money. Rounded, the constraint validated, and
`fn_close_settlement_period` now rounds at source so it cannot return.

### 2. One row said paid and nothing had moved

0.20 chips, marked paid 2026-07-22 for the 2026-04-27/28 period — the one row of
2,704 with no wallet transaction pointing back.

Read before deciding: no treasury debit of 0.20 in the window, no wallet
transaction, no ledger leg, no membership at that club, and **no wallet
transaction or ledger leg anywhere, ever, for that user.** Nothing left the club
and nothing reached the player.

Corrected forward rather than deleted (CLAUDE.md 10.9): `status = 'failed'` with
the evidence in `failure_reason`. The row keeps its history and stops claiming a
payment that never happened, and its unique `(period, user)` key still stands, so
a later close cannot pay April twice if that account ever joins. No balance
moves; nothing is taken from anyone.

## Two guards refused this work, correctly

Both are mine, from earlier phases, and both did their job:

- **`fn_ca_journal_append_only`** refused the `UPDATE` outright:
  _"financial journals are append-only … set `app.ledger_maintenance` with an
  incident reference for authorized maintenance."_ The migration uses that
  sanctioned escape, transaction-scoped and named, rather than dropping the
  guard.
- **`fn_ca_resolution_needs_a_cause`** refused a resolution whose `root_cause`
  was the placeholder `'probe'` — and, in an earlier migration today, one with no
  `correction_ref` at all. An incident cannot be closed without saying what was
  wrong and what stopped it.

## Measured in a rolled-back probe

```
rounded=933  backfilled=2703  orphan=1
still_unevidenced=0  incidents_evidenced=20 of 20
```

The migration carries that last number as a **post-condition**: if any row still
says paid with no linked transaction, it aborts and writes nothing.

## Applied

Inside the maintenance freeze, because the `VALIDATE CONSTRAINT` and the
`CREATE OR REPLACE FUNCTION` each cost a ~28s PostgREST schema reload, and
today's class 3 investigation showed what a cluster of those does to live
settlement.
