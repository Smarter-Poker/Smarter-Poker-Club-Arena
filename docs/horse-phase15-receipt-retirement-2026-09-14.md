# Horse decision receipt retirement

The Phase 15 execution audit found two existing lifecycle gaps. Phase 7 utility receipts stayed pending when a deeper decision replaced the fast decision, when a deeper result was unchanged, or when its generation/fence had expired. Separately, cancelling a turn cleared its action timer, removing the future fence check that would otherwise retire the returned receipts for Phases 7, 8 and 10–13.

`ServerTableEngineTurns.scheduleHorseAction` now owns receipt retirement for the lifetime of its abort signal. Cancellation retires pending receipts immediately, and late worker responses still pass through the existing fence rejection. Every rejected deep result retires the same six receipt families. Accepting a deeper result retires the old decision's utility receipt as well as its other phase receipts.

Immediately before the executor intentionally cancels remaining worker work, it detaches this cancellation listener. The selected receipt then receives the actual executor outcome: intended, coerced, fallback or not executed. Pending-status checks make repeated retirement idempotent. Decision selection, sizing, timing, authority checks and action application are unchanged.

## Verification

The expanded real scheduled-action fixture initially reproduced 11 failures: five discarded Phase 7 deep-result cases and cancellation of each of the six receipt families. The repaired focused suite passed 103 tests across execution effects, turn boundaries and second-look behavior. It includes accepted, unchanged, stale-generation, stale-fence, after-commit and cancelled in-flight deep results; immediate cancellation with no timer callback; coercion and rejection; and exactly-once retirement telemetry alongside actual action counts. The fixture's response type uses the worker's real result contract, including absent amounts on folds. The final TypeScript build passed, and the integrated server suite passed 12,045 tests with 145 declared skips across 807 passing files and one skipped file.

This repair is part of Phase 15's execution accounting. It does not implement the complete policy graph, full decision ledger, deterministic replay, out-of-domain/fleet certification or external strength evidence. Protected publication and natural proof of this repair remain separate requirements recorded in the release checkpoint.
