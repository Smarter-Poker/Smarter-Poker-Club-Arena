# Channel Handshakes Have A Deadline

Continuation of Real Time Fixes And Upgrades. The channel WebSocket had no
CONNECTING deadline, while the table state client already did. Its heartbeat
watchdog started only after OPEN, so a handshake that emitted neither OPEN nor
CLOSE could permanently silence presence, lobby, tournament and financial
updates. Additional subscribe calls saw CONNECTING and could not recover it.

EngineChannelClient now expires a stalled handshake after 15 seconds and uses
its existing reconnect backoff. It detaches the old socket before closing it,
so recovery works even if close never emits an event. Successful open and
intentional disconnect cancel the deadline. Close callbacks require current
socket ownership so a late callback cannot disturb the replacement.

Verification: the blackholed-handshake regression failed before the fix. All
54 tests in engine-state-client-recovery, engine-socket-mux and
realtime-channel-service pass after it, including successful-open and permanent
disconnect cases. No database schema, game rules or chip movement changes.
Authenticated production gameplay remains unverified: the browser reaches the
sign-in screen. This code test does not establish real-world network latency.

Recovered continuity: offline subscription coalescing merged as #3548;
replay-error isolation merged as #3543. Shared consumer ownership was saved at
a63447f9e, and stale room callbacks at 30b1ea4dd0 in the prior agent worktree.
Those are separate changes, not duplicated here. The prior worktree was still
receiving commits, so this continuation uses its own isolated worktree.
