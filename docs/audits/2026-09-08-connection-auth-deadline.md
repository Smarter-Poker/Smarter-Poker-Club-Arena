# A token request cannot hold connecting forever

Date: 2026-09-08

Both EngineStateClient and EngineChannelClient awaited getToken before opening a
socket. Their handshake watchdog therefore never started if the token provider
hung, and single-flight ownership prevented every later connection attempt.

The token wait now has a 15-second deadline. A deadline failure returns to the
existing backoff, without signing the player out. Disconnect cancels the wait and
clears its timer. Late resolutions and rejections remain observed but cannot open
a socket from the abandoned attempt. The cached-token path still invokes the token
provider immediately.

36 connection recovery tests passed, including hung-token recovery, late results,
disconnect cancellation, existing authentication-generation ownership and watchdog
behavior. Client TypeScript passed. No network-outage test was run against a seated
production player.

Remaining: session-revocation probes and cross-account ownership of the shared
channel need their own audit. This bounds token acquisition; it does not claim
every asynchronous auth operation or mobile recovery path is covered.
