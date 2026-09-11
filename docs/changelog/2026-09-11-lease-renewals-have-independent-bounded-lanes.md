# Lease renewals have independent bounded lanes

A single hung heartbeat previously held the shared cash/tournament renewal pass
until its fifteen-second HTTP deadline. With the prior proof expiring twenty
seconds after the earlier request, one hung attempt could expire the cash fleet.

The existing GameServer lifecycle now admits each scope every five seconds with
at most three outstanding calls per scope, six in the combined composition.
Primary, direct and authorized shutdown callers share the counters. A saturated
tick is skipped, without accumulating work or waiters. Each scope applies its
own proof or loss immediately and frees its slot after its operation settles;
it never waits for its peer or physical retirement. Shutdown stops its scheduler
and joins every remaining call before the final fence and exact release.

Every proof retains its pre-request monotonic deadline and immutable acquisition
identity. An old successful response whose own deadline has passed is explicitly
obsolete, rather than a loss of a newer proven owner. UNKNOWN/busy extends
nothing. Taken/stale/missing or malformed authority remains fail-closed.
GameServer and the table/manager proof methods check the previously proven
deadline before applying any new proof, including after an event-loop stall
whose expiry callback has not run. Process and acquisition replacements reject
responses captured by the earlier owner.

## Validation

The final focused server suite passed 156/156 tests across 11 files; server
TypeScript passed. The unchanged base fails 15 of the 30 new/extended ownership
and proof-deadline cases, reproducing the defects.

The real GameServer composition with real dealer/manager proof methods covers
hung-first, uniformly six-second responses, one fully occupied scope with a
healthy peer, six total calls, cadence sharing, obsolete responses, definitive
loss, UNKNOWN/busy, event-loop stalls, stopped generations and shutdown joining.
Existing admission, retirement, lease parsing and distributed-boundary regressions
remain in the focused suite. The SDK transport test sends six real loopback HTTP
requests in both scope directions while three responses remain held.

`node scripts/dev/probe-lease-hedging-pg17.mjs` creates a disposable local PG17
cluster, loads the exact v4 heartbeat migration and applies an isolated role's
8-second statement timeout. Six real DB connections completed 6-second work in
6009ms; an actual 30-second query was cancelled in 8003ms. Both scopes were tested
for SKIP LOCKED/busy, independent peer progress, delayed old-generation takeover,
stale-generation refusal and reuse after cancellation. The cluster is stopped
and removed after the probe. The native probe has no live database target.

## Required installed proof before release

No production SQL/configuration, publication or credentials changed here. The
lead read back service_role statement_timeout=8s and both heartbeat functions
with their existing search_path-only proconfig. This metadata and the isolated
role test do not certify how the installed PostgREST instance consumes role
settings or its pool-acquisition deadline. The release owner must verify the
complete queue+statement+transport cancellation horizon, so an aborted HTTP
operation cannot free a local slot while unobserved server work remains queued.
Client abort alone is not evidence of DB cancellation. If installed behavior
differs, correct/rehearse that exact prerequisite before activating this change.
No heartbeat timeout was shortened and no speculative SQL migration was added.

The D3 equity-priority decision remains unchanged: real-money insurance awaits
`getEquityPool().estimateInsurance()` in ServerTableEngineRunout, so its worker
cannot be treated as display-only computation.
