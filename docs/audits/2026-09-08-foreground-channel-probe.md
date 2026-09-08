# Recover the lobby and account-event channel after mobile network changes

## Reproduced failure

EngineChannelClient returned immediately from browser online events while its
WebSocket reported OPEN. Its visibility handler adjusted the old liveness
clock but did not actively ask for a response. A half-open mobile socket could
therefore retain stale lobby, club, tournament and financial event streams.
Repeated foreground events could keep granting the same wake grace.

Five new tests failed on the previous implementation. The running engine
`54ed5bc1` already supports client-initiated CHANNEL_PING with an immediate
CHANNEL_PONG reply; no new server protocol or engine deployment is needed.

## Change

A visible online/pageshow/visibility return sends CHANNEL_PING and reasserts
the current desired club, tournament, lobby and presence subscriptions once.
A single five-second timer starts before sending. Incoming well-formed server
traffic proves that this authenticated socket is responsive and cancels the
probe. Further wake events cannot move the first deadline. Silence detaches
that socket and starts the existing authenticated reconnect ladder, which
replays current subscriptions. Disposal and socket-generation guards prevent
late callbacks from reopening or affecting a successor.

This restores the event transport; it does not replay purchases or invent a
balance from a missing event. Existing authoritative account refresh and
cash-purchase receipt recovery remain responsible for monetary readback.
The table-state-specific foreground probe is a separate preceding branch,
`fix/foreground-table-state-probe`, and both must be published.

## Verification

The real client runs against deterministic WebSockets. All 60 tests in the
recovery suite passed, including six new cases for all three resume events,
response success, repeated-wake deadlines and disposal. Root TypeScript
compilation passed. No tests were disabled, and no production purchase or
seat action was used to test this change.

At this checkpoint the code is local. Publication, physical iPad Home Screen
and live network-switch acceptance remain to be verified.

## Integration with table recovery

PR #3884 merged as 276f66a220f0cd2147e90b66b92a6e50f4e3ee4e.
Its table recovery tests and this change both appended to the recovery suite.
The merge retains both complete suites, including the table snapshot deadline
and the channel ping deadline. Combined recovery and mux tests pass all 101
cases, and root TypeScript compilation passes. This is integration evidence;
the physical iPad home-screen flow remains unverified.
