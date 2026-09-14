# Lease renewals remain complete above the API row limit

Both lease adapters sent an entire fleet to a table-returning heartbeat RPC.
With 1,008 valid claims and a 1,000-row response cap, both discarded all proof
and fenced all 1,008 owners. This is reproduced against the real adapters with
a capped transport fixture. The live project previously returned a 1,000-row
discovery page, and the 12:54 UTC engine metrics recorded 10,080 malformed
tournament heartbeat claims. The exact failing live request/response was not
captured, so those metrics alone do not prove every observed loss has this cause.

PostgREST's [db-max-rows contract](https://docs.postgrest.org/en/stable/references/configuration.html#db-max-rows)
applies to function results too. The engine now bounds heartbeat input to 500
claims per request and four concurrent requests per scope. Whole-input
validation catches duplicate identities across batches, including UUID case
aliases, before dispatch. A snapshot protects queued claims from caller mutation.
Each request retains exact generation/state/completeness checks; malformed
responses fence only that request's claims, and transport uncertainty renews
nothing. Complete independent answers remain usable. Failure diagnostics now
include requested and received row counts.

The conservative proof deadline starts before the entire pass. Queued work
cannot start after it, and an earlier response cannot age into a usable proof
while waiting for another batch. No mutative RPC is paginated or replayed.
Existing RPCs, database ownership protocol, thirty-second takeover boundary and
twenty-second local proof window remain unchanged.

A separate two-case reproduction exposed an expiry race in both actual engine
classes: an already-expired incarnation accepted a later deadline if its timer
had not run yet. Renewal now invokes the existing synchronous authority fence
before installing another deadline. Current terminal child dealers, shutdown
renewals, exact generations and out-of-order valid responses keep their prior
contracts.

Validation so far: both pre-fix fleet cases failed with zero of 1,008 proofs;
both pre-fix overdue-timer renewal cases incorrectly returned true. The repaired
focused run passed 148 tests in nine files, including 40 fleet cases covering
boundaries through 3,001 claims, bounded concurrency, immutable capture,
cross-batch malformed inputs, partial transport failures, response corruption,
queued expiry and monotonic deadlines. The final full run passed 12,419 tests
in 827 files under installed Node 24.15.0; the separate disposable PostgreSQL 17
run executed and passed all 157 opt-in accounting cases. TypeScript/build and
format checks passed. The first full run on this workstation's default Node 26
had five failures in two existing HTTP-pool test files because that runtime
exposes Dispatcher1Wrapper. Neither those tests nor the pool installer was
changed. Protected CI uses Node 22, as does the production image; that exact
runtime qualification remains a pipeline gate.

The newly served bf316652 engine independently recorded 1,001 malformed
tournament heartbeat claims in its first refusal and a fleet-loss log burst at
13:03:05 UTC. This matches the capped-response mechanism but still does not
replace capture of the raw failing response. The event progress reader at
13:07:40 reported 73 stalled MTTs, zero overdue starts and zero overdue local
breaks; Brunch Special PKO (PLO8) still had 37 pending knockouts and zero bounty
obligations at 13:08. This candidate was not serving during those observations.

This is an engine source repair, not a production recovery certificate. The
release pipeline, deployed identity, sustained manager ownership, break exit,
pending eliminations and rightful bounty recipients remain independently
verifiable acceptance requirements. No production heartbeat, payment, lease
mutation, configuration change or manual restart was used as a test.
