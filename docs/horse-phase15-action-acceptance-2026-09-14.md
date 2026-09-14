# Horse Brain Phase 15: authoritative acceptance controls retries and effects

The Horse scheduler previously treated a thrown or false controller return as rejection even when the controller had already recorded the action. The private witness retained that acceptance, but the scheduler could still attempt another action, omit the accepted wager's plans and label older policy receipts as unexecuted. It also committed plans after wager sizing had changed from the brain's original proposal.

The Horse-only attempt wrapper now checks whether its acceptance observer received a record before considering a retry. This applies to both the policy action and check/fold fallback attempts. An accepted action is not retried after a later exception or contradictory false return. Exceptions still reach the error reporter; this does not repair or conceal a separate failure to advance the hand. Existing clock restoration and watchdog behavior remain in place when no action lands.

Intent effects require the single accepted wager to match both the submitted wager and the original decision witness's action and amount. Coercion by either the scheduler or controller discards the speculative plans. Normal accepted wagers retain the FIFO dispatch barrier and one effect commit. All six layer receipts and the execution witness reconcile to the actual accepted action.

## Verification

Three regressions failed before the repair using the actual HandController: a post-acceptance advance exception triggered a second attempt, a contradictory false return triggered three attempts, and a fixed-limit clamp committed a plan for a different wager. Four additional cases verify accepted check/fold fallbacks with either a later throw or false return. The focused contract suite passed 152 tests across four files. Server TypeScript compilation passed. The full server suite passed 12,304 tests across 818 files; 146 existing cases in one CashoutDeparturePostgres fixture-dependent file remain skipped because that fixture was not configured.

The intermediate full run exposed two source-shape assertions for the Horse action clock. Those assertions now follow the actual attempt wrapper and still verify controller wiring, arm-before-action ordering, fallback accounting and total-failure clock restoration. No unrelated runtime behavior was edited. Pre-repair, intermediate and final evidence is retained under the owning task's work/phase15-action-acceptance-\* artifacts.

## Acceptance boundary

This is an execution correctness repair, not a complete durable decision ledger or whole Phase 15 certification. No database change or adaptive-policy activation is included. Protected publication and natural production proof are tracked independently from these source tests.
