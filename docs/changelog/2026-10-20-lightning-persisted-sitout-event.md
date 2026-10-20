# Persisted Lightning Sit Out transitions

Before: `ServerTableEngineBase` lines 3069–3120 persisted the exact chair's
Sit Out flag asynchronously but emitted no event to its Lightning room. A
second connected device could not learn the change. Concurrent callbacks
could also finish their seat updates in the opposite order.

Change: keep the original seat-persistence owner and serialize each occupancy's
explicit transitions through a finite promise chain. After its exact update
returns a verified occupied row, resolve the open pool attached to that same
anchor and owner and emit `lightning_sitout_changed` to that room only. No pool
is manufactured or rebound, and no timer, polling, money writer or repair job
is introduced. Failure or zero updated rows emits nothing; later transitions
can still proceed after a refused earlier one. The original cash one-hand,
freeze, clock and eviction behavior remains in its existing owners.

Real-time law: triggered by `lightning_sitout_changed` discrete WS event, no
snapshot diff. Initial/reconnect reconciliation remains a client read.

Verification: real engine/DisconnectEngine callbacks with controlled database
completion exercise delivery only after persistence, both directions, exact
occupancy/owner/pool boundaries and concurrent transition ordering. Compiler,
normal hooks, required protected checks and actual containing release remain
separate evidence.

Verified: YES, the final writer, callback and event payload were reread.
TypeScript: PASS (`npm --prefix server exec tsc -- --noEmit -p server/tsconfig.json`).
Regression: the unchanged original engine failed the two positive/concurrency
cases and passed six refusal cases. The final focused run passes 122 tests,
including recovery from a refused earlier transition. Database completion is
controlled in this isolated real-engine test; production event delivery remains
an explicit post-release verification requirement.

Pending-exit boundary: suppress publication for `leave_pending` anchors and
non-active pools, while retaining the original seat flag write. The existing
recovered-bank forced-fold regression still checks every exact seat predicate
and heartbeat/explicit-return invariant; its database double now models the
returned-row query and waits for the asynchronous persisted flag.
