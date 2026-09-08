# A Deal Completes After Every Share Is Fully Paid

F43: the original final-table deal path continued after a failed share receipt and accepted partial receipts as completion. It could then stamp standings, mark COMPLETED and stop the manager while shares remained unpaid.

The original settlement loop still attempts every recorded positive share. It reaches the completion tail only when each receipt confirms full settlement of the requested amount. Refused, partial and incomplete replay receipts report through the existing error path. No new payment or recovery mechanism is introduced.

Four adverse cases failed against the baseline. All six actual-method cases now pass, including fully paid replay and fresh payment. Server TypeScript and the full local suite pass: 6,628 tests across 469 files.

This is a completion correctness fix, not certification of automatic pending-deal resumption, payout-row completeness or all financial flows. Deployment must be verified separately.
