# Horse Brain Phase 15: validate returned policy receipts

The live worker client constructed an execution witness from a supplied policy graph before checking the graph's structure. A malformed transition list could throw out of the message handler. A discontinuous graph, a final action that contradicted the returned decision, or unexpected private fields could also be copied into a witness.

The response boundary now validates the finite betting action, amount, think time and caught-failure marker before constructing the witness. A supplied graph must have the exact version and fields, all eight owners in order, an unbroken predecessor chain, truthful change flags, finite nonnegative durations and a final action matching the returned decision. The timing owner cannot change the action. Unknown graph/transition/action fields are rejected, preserving the action-only receipt contract. A failed-brain marker may describe only the existing bare check/fold fallback. Missing graphs remain distinguishable legacy/failure inputs; validation does not manufacture evidence of graph execution.

Malformed results now use the client's existing terminal failure path, which rejects pending work and terminates the invalid worker. The error contains a finite category rather than private policy data. The real caller is LiveHorseDecisionWorkerClient's matched FAST_RESULT/DEEP_RESULT branch, before createHorseExecutionWitness.

## Verification

Seven client regressions failed before the repair. The focused suite passed 114 tests across three files, including 48 receipt-validator tests and actual HorseLogic output for all nine variants on four betting streets (36 decisions, each with a complete graph and no caught fallback). Hostile cases cover every graph owner, malformed lists, unknown/private fields, mismatched actions/sizes, invalid clocks, contradictory fallbacks and timing overrides. Server TypeScript compilation passed. The full server suite passed 12,360 tests across 819 files, with 146 existing cases in one unconfigured CashoutDeparturePostgres fixture file skipped.

Source and logs are retained under the owning task's phase15-response-validation artifacts. This change does not alter poker calculations or activate new policies. It validates the outer sampled-action trace; complete internal distributions, durable decision logging, replay, fleet certification, protected publication and natural execution remain separate requirements.
