# Bound the authentication request that owns the shared lock

The table connection and HTTP auth-wait deadlines bounded callers, but the
Supabase client's underlying fetch had no deadline. A refresh request that
never completed, including one stalled after response headers, could keep
its shared auth lock and refreshingDeferred pending. Every subsequent token
request could then wait behind the same operation. Retrying the table does
not release that lock. This is a verified failure mode, not yet a confirmed
diagnosis of the owner's September 8 iPad screenshot.

The auth-only fetch path now has a ten-second network/body deadline. It aborts
the actual fetch and rejects the SDK caller even if a transport ignores abort.
The SDK remains the only refresher and retains its default cross-tab lock.
Its existing approximately thirty-second refresh retry window remains in
charge of retries. Abort is treated by the installed SDK as a retryable
network failure, so the session is retained instead of signed out. No custom
refresh-token request, parallel refresher or lock bypass was added.

The real GoTrueClient regression test starts a hanging refresh, queues a
session read behind it, advances past the SDK retry window, verifies that
the original session remains stored, and then successfully refreshes again.
Other tests cover a hung body, caller cancellation, no request after prior
cancellation, status/header/JSON preservation and timer cleanup.

Only this client's configured auth endpoint uses the wrapper. PostgREST
mutations retain their existing behavior. The helper is imported lazily to
keep it out of the entry chunk. Auth responses are buffered under the
deadline before the SDK consumes JSON; their status and headers are retained.

Limitations: another already-open application's older auth client can still
hold the shared lock. SDK callback deadlocks, identity ownership during
sign-out, and engine HTTP mutation response deadlines are separate concerns.
This change cannot prove connectivity on a device that has not received it.
