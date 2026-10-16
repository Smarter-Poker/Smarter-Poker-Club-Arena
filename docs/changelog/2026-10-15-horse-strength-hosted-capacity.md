# Horse strength jobs share a bounded hosted capacity allocation

Independent phase/variant/SHA groups previously each admitted 18 or 20 long
running matrix jobs. Concurrent dispatches multiplied that demand across the
same personal account's standard GitHub-hosted capacity, delaying client PR
checks and publication for hours.

All five strength workflows now share `horse-strength-hosted-capacity` at
workflow scope, with `queue: max` and cancellation disabled. One league runs at
a time with at most eight matrix runners; its plan completes before the matrix.
Waiting workflows use no runners. All matrices, profiles, held-out seeds,
source ancestry checks, evaluators, job timeouts, result/artifact checks and
assembler/replay rules remain unchanged. This limits simultaneous work, not
qualification coverage. Required CI, publication and post-deploy workflows keep
their existing independent groups and all required checks.

GitHub retains up to 100 pending runs in a native concurrency group. Beyond that
finite provider limit a dispatch is rejected/cancelled, never treated as a passed
qualification. Operators must read the run outcome and explicitly submit any
rejected qualification after capacity is available. There is no scheduler,
runner-holding admission script, release automation or custom runner. Already
queued/running runs retain their old workflow definition and drain normally;
this change does not cancel another task's work or retroactively throttle it.

The regression test discovers every strength workflow, guards the shared group
and retained queue, the aggregate eight-runner bound, full matrix wiring,
source identity, fail-fast policy, artifact failure handling and independent
client/CI groups. Hosted verification uses intentionally nonexistent source
commits in plan-only workflows: ancestry refusal must fail before dependencies
or evaluator execution. These runs prove scheduling only and cannot certify a
benchmark or policy promotion.
