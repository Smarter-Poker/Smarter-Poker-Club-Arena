# Horse execution amount fidelity, September 14

Execution witness v3 binds the accepted wager amount to the original decision context. Before this repair a selected call for 10 accepted at 20, or an all-in accepted at a changed street total, was labeled intended because only the action name was compared. Four negative fixtures reproduced the amount and missing-evidence failures.

The witness now copies an expected controller amount at creation: a sized call/bet/raise retains its selected amount; an unsized call uses the original canonical effective call; an all-in uses the original stack plus street bet. The value receives the same cent normalization as the controller. Later mutation of the request cannot change the copied amount. A changed amount is coerced. A matching action without its original amount evidence is unverified with `accepted_amount_unverifiable`, and the actual accepted record is retained.

Three real scheduled-executor fixtures use the actual `HandController` to call the two-chip blind. Unsized and correctly sized selections are intended; a selection for twenty is recorded as coerced to two. Existing action-rejection, callback-exception, actor/street mismatch, legalizer, effect-ownership and worker-client tests remain intact. There are no changes to action execution or chip accounting.

Verification: 216 tests passed in the focused witness, scheduled executor and worker-client files. Final server build passed; the complete server suite passed 12,946 tests with 157 declared skips (846 files passed, one skipped). Preserved task evidence: `horse-execution-amount-before.log`, `horse-execution-amount-focused-final.log`, `horse-execution-amount-build-final.log`, `horse-execution-amount-full.log`.

This is still a private memory witness. It is not the complete durable Phase 15 action ledger, a hand-UUID match, restart replay, publication or daily GTO certification. Full Phase 14/15 requirements remain open.
