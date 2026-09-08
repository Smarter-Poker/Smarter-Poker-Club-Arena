# Weekly financial close confirmation audit

Scope: existing RakebackSettlerService weekly invoice, rake counter reset and close marker sequence.

## Confirmed defect and correction

The invoice wrapper discarded the response and the close continued after invoice errors. Live read-only inspection of fn_generate_all_credit_invoices confirmed that its success:true response can contain failed > 0. The engine now requires success:true and failed:0 before resetting counters, pins invoice period_end to the same UTC week as the close marker, stops after a reset error, and reports marker write errors without logging completion.

## Verification

The actual class method is extracted with the TypeScript AST and executed against query-boundary stubs. Before correction: nine failures and three passing controls. After correction: all 12 cases pass. Server TypeScript passed. Full server suite: 6,813 tests across 481 files passed.

These tests establish engine control flow, not production database atomicity or live deployment. No production mutation was performed by this audit.

## Still open

Counter reset and close marker remain separate writes. An interruption after reset can cause a later retry to clear increments accumulated since that reset. A transactionally fenced close and period-based counter accounting need a separate design and concurrency test before claiming durable weekly close. Delayed invoice generation also reads current credit_used, not a historical cutoff snapshot. Neither risk is repaired by these response guards.

The 216-requirement audit and expanded financial audit remain incomplete. This change does not certify rake distribution, BBJ, Backup BBJ, promo funding, or all cashier operations.
