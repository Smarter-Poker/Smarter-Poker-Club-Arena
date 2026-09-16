# Horse Brain Phase 15: caught-policy failure accounting

A caught HorseLogic exception used to return an ordinary check/fold decision. A failed deep review could therefore replace a valid fast call with a fold, its execution witness could label the fallback as policy intent, and speculative plans prepared before the exception could survive into the accepted-action commit.

The brain now returns the finite private marker `policyFallback: 'brain_exception'` with the existing check/fold action and 1500 ms timing. The worker discards that failed computation's speculative effects. The response boundary rejects malformed fallback provenance; the real second-look callback retires a failed deep result and all its layer receipts while preserving the fast decision and its timer. The authoritative execution witness labels an accepted exception action as fallback. Private exception text never becomes receipt data. The two failure counters and execution-witness counter families are registered in HorseDataLedger.

## Verification

The new exception/second-look/witness regressions initially produced 11 failures; a separate injected partial-plan case also failed before the worker repair. The final focused contract suite passed 286 tests across seven files. The server TypeScript build passed. The final full server suite passed 12,297 tests across 818 files, with 146 existing fixture-dependent CashoutDeparturePostgres cases skipped (one file); that database fixture was not configured in this run.

The real scheduler integration covers all seven receipt families and proves that the controller receives the valid fast call after deep failure. The worker integration forces an actual HorseLogic exception after capturing a raise plan, then verifies a marked FAST_RESULT with no effects. Client tests cover the valid marker and null, array, unknown-string and boolean provenance without an event-handler throw. Successful policy actions and effects retain their existing behavior.

Evidence logs are retained in the owning task's `work/phase15-brain-fallback-*` artifacts, including both failing pre-repair runs and the intermediate full-suite registry/wiring failures. Those intermediate failures were fixed without removing the registry or executor-commit checks.

## Acceptance boundary

This repair has no schema change and does not activate adaptive policies. Its witness remains memory-only. Full internal distribution ownership, a durable complete decision ledger, restart replay, supported-domain/fleet certification and external strength evidence remain Phase 15 requirements. Source test results do not establish protected merge, deployment or natural production execution; those facts are tracked separately.
