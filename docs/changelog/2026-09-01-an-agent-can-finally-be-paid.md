# An Agent Can Finally Be Paid

**Phase 6 Of 7, Agent Credit And Promotion Lifecycle**

Phases 4 and 5 each wrote the same sentence into a comment and moved on:
_"there is no payout path to send them to yet (phase 6 builds one)"_. This is
that path.

## What Was True Before This

Measured on production:

```
agent_commissions      1,507,614 rows
  unsettled              958,627 rows   394,904.61 chips   96 agents
  settled                548,987 rows   every one stamped on 2026-08-20
                                        by a single bulk operation
accruing since 2026-04-28, and still accruing

SHARK CLUB          owed 386,208.84   treasury 1,376,610.47   68 agents
Club JAQK           owed   8,120.03   treasury 1,051,788.71   43 agents
Midway Union        owed     568.18   treasury         0.00    3 agents
Deep Stack Society  owed      20.27   treasury    78,725.36   24 agents
```

Three broken things stood where the payout path should have been.

**`fn_pay_commission_atomic`** was a stub. Its entire body returned
`{'success': false, 'error': 'not_implemented'}`.

**`execute_commission_payout`** was worse than a stub. It credited a wallet,
debited **nothing** - chips from nowhere - and never set `settled_at`, so the
same commission row could be paid again and again forever. Nothing in the app
called it, which is the only reason it never fired.

**`sum_agent_commissions`** read `commission_history`, a table with 0 rows. It
answered `{total: 0, paid: 0}` to every question ever asked of it.

And **`agents.pending_commission` is written by no function and no trigger
anywhere in the database.** It said 26,859.87 owed across 5 agents while the
ledger held 394,904.61 across 96 - and it was the number Phase 4's demotion
refusal, Phase 5's promotion result and the agent dashboard all showed people.

The dashboard's "Request Payout" button told the agent _"Commissions are paid
out automatically at the weekly settlement."_ No function, cron or settlement
job did that. It was a reassuring sentence in front of 394,904.61 unclaimed
chips.

## The Rules

From Dan:

> "AGENTS HANDLE THEIR OWN PAYOUTS, THEY SELL THEIR RAKE BACK CHIPS BACK TO
> THEIR DOWNLINES"

So the agent claims; staff do not pay out. `fn_agent_claim_commission` pays
`auth.uid()` and takes **no payee parameter** - there is deliberately no way to
move somebody else's earnings.

Commission lands in the **player wallet** (`club_members.chip_balance`), their
own money. Not the agent wallet: Phase 5 refuses to demote anybody whose agent
wallet still holds chips, so paying earnings there would build a settlement
blocker into every future demotion.

> "COMES FROM THE CLUB BANK AND DOCUMENTED IN THE TRANSACTION LEDGER"

The treasury is debited by exactly what the agent is credited, and one
`chip_transactions` row records both sides. Chips are never created.

> "THEY PAY THE BALANCE OFF WEEKLY, AND ANY RAKE BACK GOES ON TOP. SO IF THEY
> HAVE A 5K CREDIT LINE AND AT THE END OF THE WEEK HAVE 1000 CHIPS LEFT, BUT
> THEY MADE 6000 IN RAKE BACK, THEY STILL PAY THE 4000 TO SQUARE UP THE BALANCE"

Commission is **not** netted against `credit_used`. The claim never touches that
column, and the migration asserts that it does not.

## Why It Settles In Batches

The largest agent has **192,135** unsettled rows. Settling them in one statement
measured **64.6 seconds** against the `authenticated` role's **8 second**
statement timeout - so the three biggest agents (192k, 114k, 113k rows) could
never have been paid at all.

The timeout was the smaller half. That statement also holds `FOR UPDATE` on the
`clubs` row for its whole life, so a single claim would have frozen every chip
movement in that club for a minute.

So a claim settles a bounded batch and reports whether more is left. Two further
measurements shaped it:

- `ORDER BY created_at` cost **1,194ms**, because it walks all 192,135 matching
  index entries and top-N sorts them. Without it the same read is **84ms**.
  Money does not care which of an agent's own rows settle first.
- Reporting the exact remaining figure cost **1,474ms**, re-scanning every
  remaining row on a call whose whole budget is 8 seconds. An `EXISTS` answers
  the only question the caller needs in order to loop, in **0.25ms**.

One batch of 1,000 now runs comfortably inside budget. The client loops with a
**fresh `op_id` per batch** - reusing one is what makes a retry safe, and using a
new one is what lets the loop make progress.

## The Bug This Nearly Shipped With

An early draft folded the lock, the settle and the sum into one CTE for speed.
That stamped `settled_at` **before** the club bank had been checked. A refusal
returns JSON, and a plain `RETURN` commits rather than rolls back - so a short
bank would have returned "cannot pay" while leaving the rows marked paid.

Every write now happens after the last thing that can refuse, the settle is the
last write of all, and the migration asserts that ordering rather than trusting
it.

## Evidence

Verified against production inside rolled-back transactions:

```
claim (largest agent)   2.95s for one batch, budget 8s
drain (smaller agent)   owed 1,127.02 -> 6 calls -> claimed 1,127.02
                        bank -1,127.02   chips +1,127.02   conserved: true
                        unsettled after: 0
replay (same op_id)     success=true replayed=true, paid once
bank short              refused, bank_short=true, rows newly settled: 0
                        "The Club Bank Holds 1.00 Chips And Owes You 803.49.
                         Ask An Owner To Fund The Bank, Then Claim Again."
```

`tests/an-agent-can-finally-be-paid.law.test.ts` - 22 pins. Full suite: 772
files, 10,786 tests, all passing. Every gate green.

The discarded-error ratchet moved **down** for `CommissionService.ts` (3 to 2),
because `executePayout` and its unchecked read-back are gone.
