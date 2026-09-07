# Snapshot delivery has its own recovery deadline

The live-table audit found a second class of frozen connection in
`EngineStateClient`: every inbound frame reset the transport watchdog, so
regular PINGs could keep a table connected forever without its initial
SNAPSHOT or an answer to RESYNC. Repeated unusable DELTAs had the same effect.

Two behavioral regressions reproduced this on the unmodified client: the
first snapshot was never requested despite 40 seconds of heartbeats, and a
sequence gap never caused recovery despite 65 seconds of unusable frames.

The client now tracks snapshot delivery independently from transport traffic.
It arms that deadline on subscribe, on a resync request, and when the engine
announces a table rebuild. Only an accepted SNAPSHOT clears it. A pending
snapshot triggers soft recovery at 35 seconds and reconnect at 60 seconds
or after three unanswered watchdog resyncs;
repeated requests cannot extend the deadline. The existing bounded wake
grace also applies to this deadline. A separate unanswered-snapshot counter
prevents repeated wake events plus heartbeats from postponing recovery
indefinitely; the added wake-loop regression failed without that counter.
An idle table with a valid snapshot
does not need state changes to remain connected.

Validation: 37 client tests pass locally across the mux and recovery suites.
Seven new cases cover the missing initial snapshot, repeated sequence gaps,
same-sequence resync replies, rejected stale snapshots, engine rebuilds, and
background/wake recovery, and repeated wake events. The first two failed before the implementation.
Prettier reports both edited files unchanged. This is targeted local
validation; the full repository checks belong to this branch's CI.

Related subscription ownership PR #3508 separately passed its production
build, TypeScript checks, all four client test shards, server checks, and
CSS/multi-table animation E2E in GitHub CI. Its production E2E and post-deploy
verification jobs were skipped, which is not proof of live deployment.

The broader audit remains open. The Mac's `.env` and SSH key are not mounted
in this cloud session. The supplied root-account SSH instructions identify
the intended credentials but do not provide access here. Live handshake
timeouts, server resource pressure, and end-to-end real-player recovery
still require verification against the deployed engine and frontend.
