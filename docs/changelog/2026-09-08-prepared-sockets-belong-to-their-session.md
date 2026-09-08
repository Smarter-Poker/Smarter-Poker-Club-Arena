# Prepared Table Sockets Belong To Their Session

The shared table transport retained an open or connecting WebSocket when a
caller supplied a different authentication token or engine address. Updating
the stored fields did not change the already completed handshake. The cached
snapshot guard prevented replay of old buffered state, but new subscriptions
could still use the old authenticated socket.

Acquire, speculative acquire, and physical prewarm now establish transport
identity before checking reuse. A token or origin change retires the old
socket and its facades. The next connection handshakes with the supplied token
and waits for its own subscription acknowledgement. Existing stale-socket
callback guards keep late frames from reopening the new facade.

Calls with the same origin and token retain the existing warm connection.
A changed token requires a new handshake; this deliberately includes token
rotation because this protocol has no in-place authentication update.

Three regression tests failed against the old behavior and pass with the fix.
The focused transport, warmup, recovery, and channel lifecycle run passes 75
tests. This does not complete the broader logout and authentication callback
lifecycle audit, which also includes pending asynchronous token/session checks.
