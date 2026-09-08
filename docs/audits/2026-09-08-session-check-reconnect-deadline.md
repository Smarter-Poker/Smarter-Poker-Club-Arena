# A Hung Auth Probe Must Not Stop Reconnection

## Root Cause And Change

Both EngineStateClient and EngineChannelClient call checkSessionThenReconnect
after an explicit auth rejection or repeated failed handshakes. They scheduled
the next connection only after askWhetherTheSessionIsAlive settled. A hung
module fetch, getUser, or refresh request therefore stopped the reconnect ladder
indefinitely during the network outage it was supposed to recover from.

The shared caller now waits at most 15 seconds for the probe. Timeout means
unknown and resumes the existing reconnect backoff. Confirmed revocation before
the deadline still stops retries and uses the existing sign-in prompt. The timer
is cleared on completion; late rejection is observed, and a late result cannot
change the already-resolved verdict. Existing connection-generation and socket
ownership checks prevent a timed-out waiter from reviving a disconnected client.
Both table and channel clients use the same helper, independent of game format.

This does not abort or duplicate the shared SDK request. It does not change
server-side 30/45-second disconnect allowances or VIP eligibility. The separate
sessionRevoked module's internal refresh/sign-out side effects still require
coordinated ownership hardening; this change makes no claim to solve that race.

## Verification

Six new socket-level fake-network cases cover both clients: a never-answering
probe, a late revoked result after recovery, and explicit disconnect before the
deadline. Existing confirmed-revocation and recovery tests remain required.
The two focused suites passed 70 tests, including all six new cases. Client
TypeScript completed cleanly. No live wagers, paid Rabbit Hunt, or account
sign-out were used for verification.
Client TypeScript, production build, and normal push gates are required.

## Live Hand-Delay Evidence At The Start Of This Phase

At 2026-09-08 11:20 UTC, engine and frontend both served c5b7203a. The engine's
last 2,000 gap samples reported median 2,053 ms, p90 3,249 ms, maximum 7,203 ms,
and 602 samples above the 2,500 ms target-plus-slack threshold. Two samples
included rebuy pauses. The event-loop governor was unthrottled at scale 1,
p50 20.48 ms and p99 52.76 ms; no tables were reported stalled.

This is a substantial improvement over the earlier measurements, not proof of
universal two-second dealing. Settlement, fresh input reads, tournament ghost
seat checks, and pending seat-move announcements remain measured contributors.
Their financial and seating invariants must be preserved when reducing waits.
The production SHA includes the settlement recount, Omaha evaluator, preload,
and HTTP retry ownership fixes. Other agents' intervening changes are also
present, so these measurements are not an isolated attribution experiment.
