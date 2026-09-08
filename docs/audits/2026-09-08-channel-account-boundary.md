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

## Release verification follow-up

Merged current main, preserving the token-deadline and account-boundary regression suites together. The merge passed 49 focused tests, client TypeScript, a build with behind-main=0, and 178 pre-push covering tests.

CI run 34186709546 then failed its unrelated short river-squeeze drag check twice: the host had already reached `released` and unmounted before the polling assertion expected `drag`. The test allowed real CI scheduling delay to consume the 2.55-second automatic-reveal window. The short-drag case now installs Playwright's clock before navigation and pauses it before the river mounts. Real pointer events and CSS spring-back are still checked. The separate automatic-reveal test retains real time and its existing deadline assertions. Test discovery passed; the CI browser run must verify execution before this release is accepted.
