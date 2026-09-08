# Shared channels respect account changes

Date: 2026-09-08

The channel singleton read a token only when opening a socket. No production
sign-out path called disconnect, and subscription intent, queued hand replay
requests and deferred financial events could outlive the account that created them.

The existing synchronous MasterBus auth handler now resets shared channels when
the user changes. The service releases its consumers and presence cache; the client
closes the old socket, drops old intent and requests, and blocks reconnect attempts
while signed out. A token refresh for the same user retains the connection.
Deferred event delivery checks connection ownership before calling listeners,
so a previous account's queued financial event cannot reach a newly mounted listener.

56 focused tests passed, covering table/lobby recovery, subscription reference
counts, account changes, signed-out behavior and deferred financial event isolation.
Client TypeScript passed. No production account-switch or seated-outage test was
performed.

The session-revocation probe remains a separate open issue: the installed auth SDK's
getUser can remove its session on session_not_found before a caller can check an
auth generation. Fixing that safely requires separating validation from shared
session mutation, without introducing a second competing token refresher.
