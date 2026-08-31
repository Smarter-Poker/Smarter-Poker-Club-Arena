# Phase 1 of 7 — an invoice bills what was borrowed

2026-08-31. First phase of the agent credit and promotion lifecycle programme.

## The bug

`fn_generate_all_credit_invoices` computed an agent's debt as:

```sql
v_debt := credit_limit - agent_wallet_balance
```

That is the **unused portion of the credit line**, which is the opposite of a
debt. The less an agent had borrowed, the larger their bill — and the job runs
weekly, so it re-billed the whole line every time.

Measured on production before the fix:

|                                    |                        |
| ---------------------------------- | ---------------------- |
| Invoices raised                    | 224                    |
| Chips billed                       | 18,047,771             |
| `agents.credit_used`, whole estate | 0.00                   |
| Overdue                            | 184, oldest 2026-07-21 |
| Payments ever made                 | 0                      |

One agent with a 500,000 line who has never borrowed a chip carried twelve
invoices of 500,000 each. Another had thirty at 150,000.

Nobody paid one, which is the only reason no money moved.
`fn_pay_credit_invoice_from_wallet` deducts real chips from a real wallet and
would have settled a debt that did not exist. That is luck, not safety.

## The second half

Found while fixing the first: `fn_apply_credit_payment` marked the invoice paid
and **never touched `agents.credit_used`**. Had the credit line ever worked, an
agent could have paid an invoice in full and still owed every chip of it,
because the bill and the debt live in different columns and nothing reconciled
them. That is the shape section 11.5 of CLAUDE.md exists to warn about.

## What changed

- `fn_generate_all_credit_invoices` bills `credit_used`. An agent who has
  borrowed nothing is not invoiced at all.
- `fn_generate_credit_invoice` reads the debt from the agents row instead of
  trusting the caller's figure, and refuses a bill larger than the credit drawn
  — so a hand-rolled caller cannot reintroduce the bug. It also refuses to
  invoice a prepaid agent, who by definition borrows nothing.
- `fn_apply_credit_payment` decrements `agents.credit_used` in the same
  transaction, and clamps the payment to what is actually outstanding.
  `amount_paid` used to climb past `debt_owed` while `amount_remaining` floored
  at zero, so the two disagreed for ever after.
- `credit_invoices.status` gains `void`, and the table gains `void_reason`.
  `fn_apply_credit_payment` and `fn_pay_credit_invoice_from_wallet` both refuse
  a void invoice — the wallet path refuses **before** the deduct, because a
  wallet debited and rolled back is a ledger entry nobody asked for.
- All 224 phantom invoices are voided with a reason. Every one had
  `amount_paid = 0`, so no payment was unwound and no chip moved.

## Verification

- Applied to production; the migration asserts its own outcome and would have
  refused to commit otherwise.
- After: **224 voided, 0 live, 0 still over-billing, 0 payments unwound.**
- Behaviour probed against production **inside a transaction that was rolled
  back**, per section 11.5:

| Probe                         | Result                                             |
| ----------------------------- | -------------------------------------------------- |
| Invoice an agent with no debt | refused — "has drawn no credit"                    |
| Draw 500, then bill           | billed exactly 500                                 |
| Pay 200                       | applied 200, `credit_used` 500.00 → 300.00         |
| Overpay 1000                  | clamped to the 300 remaining, `credit_used` → 0.00 |
| Pay a voided invoice          | refused — "was voided and is not payable"          |

- `tests/an-invoice-bills-what-was-borrowed.law.test.ts` — 15 pins, green.
- `npx tsc --noEmit` clean, client and server.
- Full client and server suites green.

## Not in this phase

Making the credit line _spendable_ is phase 2. Today `fn_agent_wallet_send`
still refuses the moment the wallet is short, prepaid or not, so `credit_used`
remains 0 and no invoice will be raised until that lands. Fixing the biller
first means that when credit starts moving, the bill is already right.
