# Engine repair integration checkpoint

This source integration starts from protected main
`a8be599ec0e3a53affbb6b14c7efe902c8729f14`. It is held for further transport
qualification and is not a production release certificate.

The candidate composes the previously reviewed shuffle qualification, independent
bounded ownership renewal, process-wide accepted-work telemetry, and tournament
balance redrive on the actual maintenance thaw. Disposable Git fixture isolation
is included as the explicit dependency already proposed in PR4334. The original
commits remain preserved in their workstream branches.

The balance-redrive source ancestor also contained historical financial-ruling
and wake SQL. Those files are excluded from this engine candidate; the separate
accounting workstreams retain their source and current rehearsal evidence. No
accounting or wake script was executed during integration.

The complete server suite initially exposed a stale source assertion looking for
a direct human `performAction` assignment. The timing wrapper now encloses that
synchronous call. The guard checks that the broadcast clock is armed before both
the wrapper and its actual action callback, and an actual HandController runtime
case proves the current action's clock is already armed when rules execute.

Validation on Node22.23.2 with isolated exact-lock dependencies:

- Server typecheck passed.
- Full server suite:691 files passed,1 skipped;9836 tests passed,145 skipped.
- Focused telemetry and timing-law suite:25 tests passed.
- Client typecheck passed.

The D6 transport prerequisite remains open. Production PostgREST14.5 has a10s
pool acquisition timeout and the service role has an8s statement timeout, while
the ordinary client aborts at15s. A native rehearsal with a12-connection pool,
the structurally extracted actual GameServer admission method, real five-second
ticks and native RPC work observed8 simultaneously executing renewals after
timeouts freed local slots. The three-per-scope promise bound is therefore not
yet a six-physical-RPC bound. A2s pool-wait experiment passed a narrower local
test, but no production setting changed and upstream gateway closure is unproved.
Do not release this candidate or mark D6 complete from the unit-test results.

Operation-maintenance, provider activation, dependency updates, integration CI,
production publication, exact component certification and24-hour qualification
are separate remaining steps. The already accepted a8 release is unchanged.
